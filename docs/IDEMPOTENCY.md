# LedgerFlow Idempotency Contract & Recovery Specification

## 1. Overview & High-Level Architecture

LedgerFlow provides high-throughput, strictly idempotent payment and double-entry ledger execution. The idempotency subsystem is designed as a **two-tier defense architecture**:

1. **Fast-Path Distributed Lock & In-Memory Cache (Redis):**
   - High-performance latch using Redis keys prefixed by tenant: `idemp:<merchant_id>:<key>`.
   - Acquires lock via `SET ... EX 30 NX` with a unique owner token (`UUIDv4`).
   - Releases lock using an atomic Lua compare-and-delete script to guarantee lock ownership safety.
   - Caches completed responses for configurable retention (default: 86,400 seconds / 24 hours).

2. **Durable Source of Truth & Concurrency Guard (PostgreSQL):**
   - Durable ledger state stored in `idempotency_keys` table with composite primary key `(merchant_id, key)`.
   - Transactional coupling: the idempotency record update, double-entry ledger entries, balance updates, and transactional outbox events commit or roll back in the **exact same ACID transaction**.
   - Safe fallback: operates with full correctness even if Redis is completely unavailable, flushed, or restarted.

---

## 2. The Idempotency Contract

### 2.1 Request Headers & Tenant Scoping
- **Header:** `Idempotency-Key` (required for mutating endpoints such as `POST /transfers`).
- **Tenant Isolation:** Every key is scoped to the authenticated merchant (`req.merchant.id`).
  - Redis key format: `idemp:<merchant_id>:<trimmed_key>`
  - PostgreSQL unique identity: `PRIMARY KEY (merchant_id, key)`
  - Two distinct merchants may use the identical `Idempotency-Key` concurrently or sequentially without collision, state sharing, or cross-tenant interference.

### 2.2 Canonical Request Fingerprinting
Requests are fingerprinted deterministically using SHA-256 over:
$$\text{SHA256}(\text{Method} \parallel \text{":"} \parallel \text{NormalizedPath} \parallel \text{":"} \parallel \text{CanonicalBody})$$

- **Method:** Uppercased (`POST`).
- **Normalized Path:** Path stripped of trailing slashes and query parameters (`/transfers`).
- **Canonical Body:** Recursive lexicographical sorting of JSON object keys at all nesting depths. Array order and primitive types are strictly preserved.
  - Example: `{ "to_account_id": "B", "amount_paise": 100, "from_account_id": "A" }` produces the identical fingerprint as `{ "from_account_id": "A", "to_account_id": "B", "amount_paise": 100 }`.

### 2.3 Response Semantics
1. **First Execution (HTTP 201 Created):**
   - Atomically executes balance check, debits sender, credits recipient, inserts ledger rows, enqueues outbox events, records idempotency result, and commits.
   - Returns HTTP 201 Created with JSON response body.
2. **Identical Replay (HTTP 201 Created with Replay Header):**
   - If the same tenant submits the same `Idempotency-Key` with an identical canonical request:
   - Returns the exact original committed HTTP response body.
   - Attaches response header: `X-Idempotent-Replay: true`.
   - **Zero side-effects:** No additional ledger entries, no balance modifications, and no duplicate outbox events are generated.
3. **Payload Mismatch Conflict (HTTP 422 Unprocessable Entity):**
   - If a tenant reuses an `Idempotency-Key` with a different request payload or endpoint:
   - Returns deterministic HTTP 422 Unprocessable Entity:
     ```json
     {
       "error": "Unprocessable Entity",
       "code": "IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD",
       "message": "Idempotency key has already been used with a different request payload or endpoint"
     }
     ```
   - The transfer is rejected, and existing state is untouched.
4. **Concurrent Execution In-Flight (HTTP 409 Conflict):**
   - If a concurrent request arrives while the original request is actively executing in-flight:
   - Returns HTTP 409 Conflict:
     ```json
     {
       "error": "Conflict",
       "message": "Request already in progress"
     }
     ```

---

## 3. Lock Ownership & Safe Release Semantics

### 3.1 Lock Token Allocation
Every incoming request generates a cryptographically random `lockToken = uuidv4()`. The lock payload stored in Redis is structured as:
```json
{
  "status": "IN_FLIGHT",
  "token": "4f18b3cb-e587-4a0b-9df2-4753be36c2ef",
  "request_hash": "a1b2c3d4..."
}
```
TTL is set to 30 seconds (`EX 30 NX`).

### 3.2 Compare-and-Delete Lua Script
Locks are released using atomic Lua script `COMPARE_AND_DEL_LUA`:
```lua
local current = redis.call("get", KEYS[1])
if not current then
  return 0
end
if current == ARGV[1] then
  return redis.call("del", KEYS[1])
end
local ok, data = pcall(cjson.decode, current)
if ok and data and data.token == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
```
- **Ownership Invariant:** A request can **only** delete the Redis key if the key holds its specific `lockToken`.
- **Takeover Safety:** If Request 1's lock expires after 30 seconds and Request 2 acquires the lock with a new token, Request 1 cannot accidentally delete Request 2's lock.
- **Cache Protection:** Cached completed responses (`{"response_status": 201, ...}`) do not contain a matching `token` field, ensuring `releaseSafeLock` will never delete a completed response cache.

---

## 4. Failure Modes & Crash Recovery Matrix

| Scenario | System State at Failure | Recovery Behavior on Retry | Guarantee |
| :--- | :--- | :--- | :--- |
| **Crash before DB commit** | PostgreSQL transaction uncommitted; Redis holds `IN_FLIGHT` (TTL 30s). | PostgreSQL connection drops; DB automatically rolls back. Once Redis TTL expires (or on lock cleanup), retry executes transfer cleanly. | Exactly-once transfer; zero partial ledger records. |
| **Crash after DB commit, before Redis cache update** | PostgreSQL has committed `response_status = 201`. Redis still holds `IN_FLIGHT` with old token. | Middleware detects `IN_FLIGHT` in Redis, checks PostgreSQL, finds committed 201, heals Redis cache, and immediately returns 201 Replay with `X-Idempotent-Replay: true`. | Client gets original response; never receives false 409 Conflict. |
| **Crash during HTTP response delivery** | PostgreSQL committed; Redis cache updated; TCP socket terminated before client reads bytes. | Client reconnects and retries. Middleware checks Redis (or Postgres), finds cached 201, and returns replay. | Response replayed identically. |
| **Transfer rejected / failed (400, 404, 422)** | DB rolled back; HTTP status $\neq 201$. | Response handler triggers `releaseSafeLock` via `res.on('finish')` / `res.on('close')`. Redis lock deleted; DB has no record. | Key is immediately reusable for valid subsequent requests. |
| **Redis unavailable / down** | Redis connection refused or timed out. | Middleware falls back to PostgreSQL. Transfer controller uses `INSERT INTO idempotency_keys ... ON CONFLICT DO UPDATE`. | Fully operational without Redis; transactions strictly serialized. |
| **Redis flushed / restarted** | Redis empty; PostgreSQL holds durable records. | Middleware misses Redis, queries PostgreSQL, finds completed 201, repopulates Redis cache, and returns 201 Replay. | Zero data loss; transparent cache warming. |

---

## 5. PostgreSQL Durable Concurrency Guard

When Redis is unavailable or a Redis lock expires mid-flight, PostgreSQL serves as the durable source of truth via row-level locks:

```sql
INSERT INTO idempotency_keys (key, merchant_id, request_hash, response_status, response_body, locked_at)
VALUES ($1, $2, $3, NULL, NULL, NOW())
ON CONFLICT (merchant_id, key) DO UPDATE
  SET locked_at = idempotency_keys.locked_at
RETURNING key, request_hash, response_status, response_body;
```

1. **Serialization:** PostgreSQL acquires an exclusive row lock on `(merchant_id, key)`. Any concurrent request blocks waiting for the active transaction to commit or roll back.
2. **If first transaction commits:** The concurrent request unblocks, inspects the returned row, observes `response_status !== NULL`, rolls back its own transaction, and returns the replayed response.
3. **If payload differs:** The concurrent request unblocks, inspects `request_hash`, detects the mismatch, rolls back, and returns HTTP 422.
4. **If first transaction rolled back:** The inserted row was aborted. The second request's insert succeeds and executes cleanly.
