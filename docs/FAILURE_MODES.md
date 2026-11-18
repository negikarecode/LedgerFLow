# LedgerFlow Failure Modes & Recovery Guarantees

This document provides a code-level architectural analysis of how LedgerFlow handles failures across the application lifecycle. Every failure mode details the exact trigger, system state at the moment of failure, formal invariant guarantee, and step-by-step recovery path, backed by direct references to the implementation files.

---

## Table of Contents

1. [API Crashes After Database Commit but Before Response Is Sent](#1-api-crashes-after-database-commit-but-before-response-is-sent)
2. [Worker Crashes Mid-Delivery (At-Least-Once Delivery & Deduplication)](#2-worker-crashes-mid-delivery-at-least-once-delivery--deduplication)
3. [Redis Goes Down or Is Flushed (Queue, Locks, Circuit Breakers)](#3-redis-goes-down-or-is-flushed-queue-locks-circuit-breakers)
4. [PostgreSQL Failover or Connection Loss Mid-Transaction](#4-postgresql-failover-or-connection-loss-mid-transaction)
5. [Merchant Endpoint Is Slow, Down, or Returning Garbage](#5-merchant-endpoint-is-slow-down-or-returning-garbage)
6. [Clock Skew and Replayed Webhook Requests](#6-clock-skew-and-replayed-webhook-requests)
7. [Poison Events That Always Fail](#7-poison-events-that-always-fail)
8. [Two Workers Picking Up the Same Outbox Row](#8-two-workers-picking-up-the-same-outbox-row)
9. [Summary of Guarantees & Known Limitations](#9-summary-of-guarantees--known-limitations)
10. [Redis Degraded-Mode Architecture & Operator Recovery Playbook](#10-redis-degraded-mode-architecture--operator-recovery-playbook)

---

## 1. API Crashes After Database Commit but Before Response Is Sent

### Failure Scenario
A client invokes `POST /transfers` with an `Idempotency-Key` header. The Express API process acquires the Redis lock, begins a PostgreSQL transaction, locks the sender and receiver accounts, checks balance invariants, writes the double-entry `ledger_entries`, updates cached `accounts.balance_paise`, inserts `outbox_events`, and updates `idempotency_keys` with the final HTTP 201 response payload. The transaction successfully commits via `await client.query('COMMIT')`. 

However, before the API process can write to the Redis response cache or transmit the HTTP response buffer across the TCP socket back to the client (e.g., Node.js OOM kill, power outage, unhandled exception in an unrelated thread, or network partition), the API server crashes.

### State at Failure
- **PostgreSQL (Committed):**
  - Sender and receiver accounts have updated `balance_paise`.
  - Immutable debit and credit rows are permanently recorded in `ledger_entries`.
  - `outbox_events` row exists in `status = 'PENDING'`.
  - `idempotency_keys` record contains `response_status = 201`, `response_body = {"transaction_id": ...}`, `request_hash = <sha256>`, and `locked_at = NULL`.
- **Redis (Transient):**
  - Lock key `idemp:<merchant_id>:<key>` may still be held (`status = 'IN_FLIGHT'`) with remaining TTL (up to 30s) or might have expired.
  - The fast-path response cache has **not** been written yet.
- **Client:**
  - Client receives a TCP connection reset (`ECONNRESET`) or HTTP timeout. The client does not know whether the transfer succeeded or failed.

### Formal Guarantee
**Strict Exactly-Once Execution:** The transfer executes exactly once. Money is never debited twice. When the client retries with the same `Idempotency-Key`, it receives the original committed `201 Created` response payload without creating duplicate ledger records.

### Recovery Path in Code
1. The client retries the exact same HTTP request with the identical `Idempotency-Key`.
2. **Fast-Path Check & Stale Lock Healing ([src/api/middlewares/idempotency.ts](file:///home/aryan/LedgerFlow/src/api/middlewares/idempotency.ts)):**
   - If Redis still contains an `IN_FLIGHT` lock or `'LOCKED'` string from before the crash, the middleware does not blindly return 409.
   - It performs a fast lookup in PostgreSQL `idempotency_keys`. Because the transaction already committed, it finds `response_status = 201`.
   - The middleware immediately heals the Redis cache with the completed response, attaches `X-Idempotent-Replay: true`, and returns HTTP `201 Created` with the original response body.
   - The client never experiences a false 409 Conflict error or a 30-second delay.
3. **PostgreSQL Fallback (if Redis was flushed or restarted):**
   - The middleware queries PostgreSQL directly:
     ```sql
     SELECT key, merchant_id, request_hash, response_status, response_body 
     FROM idempotency_keys 
     WHERE key = $1 AND merchant_id = $2
     ```
   - Finds `response_status = 201` and `response_body` fully populated from the earlier committed transaction.
   - Verifies that `stored.request_hash === requestFingerprint`.
   - Repopulates Redis fast-path cache for future instant lookups, attaches `X-Idempotent-Replay: true`, and returns HTTP `201 Created`.
   - The transfer controller logic is **never re-entered**.
   - See [docs/IDEMPOTENCY.md](file:///home/aryan/LedgerFlow/docs/IDEMPOTENCY.md) for full contract details.

---

## 2. Worker Crashes Mid-Delivery (At-Least-Once Delivery & Deduplication)

### Failure Scenario
An outbox worker instance polls a pending event, leases it in PostgreSQL (`next_retry_at = NOW() + INTERVAL '30 seconds'`), enqueues it to BullMQ, and initiates an outbound HTTP POST dispatch to the partner's registered webhook endpoint. While the HTTP socket is transmitting, or while waiting for the partner's HTTP 200 acknowledgement, the worker process crashes (e.g., container host restart, SIGKILL).

### State at Failure
- **Partner Receiver:** The partner receiver may have already received the HTTP payload, executed internal actions (e.g., credited user account), and sent an HTTP 200 response that never reached the dying worker; or the request never arrived at all.
- **PostgreSQL:** `outbox_events.status` remains `'PENDING'` with `next_retry_at` set 30 seconds into the future. No row has been written to `delivery_attempts` for completion.
- **Redis / BullMQ:** The BullMQ job in Redis is marked active or dropped when the worker socket disconnects.

### Formal Guarantee
**At-Least-Once Delivery with Deterministic Idempotency Identifiers:** LedgerFlow guarantees that every committed outbox event is delivered at least once. Because true "exactly-once delivery" across independent distributed networks without two-phase commit is physically impossible under the Two Generals' Problem, duplicate dispatches can occur after crashes. LedgerFlow provides deterministic payload identifiers to enable partner receivers to achieve strict exactly-once side-effects.

### Recovery Path in Code
1. **Lease Expiry ([src/worker/index.ts#L69-L73](file:///home/aryan/LedgerFlow/src/worker/index.ts#L69-L73)):**
   - The outbox poller sweeps for eligible rows:
     ```sql
     WHERE o.status = 'PENDING'
       AND (o.next_retry_at IS NULL OR o.next_retry_at <= NOW())
     ```
   - Because `next_retry_at` was set to `NOW() + 30s` at lease time ([src/worker/index.ts#L95-L98](file:///home/aryan/LedgerFlow/src/worker/index.ts#L95-L98)), after 30 seconds the stalled event becomes eligible for polling again.
2. **Re-Polling & Dispatch:**
   - A surviving or restarted worker polls the event, extends the lease by another 30 seconds, enqueues the job into BullMQ, and re-dispatches the HTTP POST request.
3. **Partner Receiver Deduplication Protocol ([src/worker/index.ts#L243-L276](file:///home/aryan/LedgerFlow/src/worker/index.ts#L243-L276)):**
   - Every webhook dispatch carries two identifiers:
     - **`event_id` (`payload.event_id` and `X-LedgerFlow-Event-Id` header):** **STABLE** across all attempts, retries, and replays. Generated at the instant the transfer is committed in PostgreSQL.
     - **`delivery_id` (`payload.delivery_id` and `X-LedgerFlow-Delivery-Id` header):** **UNIQUE** per dispatch attempt for audit tracing.
   - **Receiver Implementation Requirement:** The partner receiver must store `event_id` in a database table with a unique constraint (e.g., `INSERT INTO processed_events (event_id) VALUES ($1)`). If a duplicate dispatch arrives with an already-processed `event_id`, the receiver returns HTTP `200 OK` immediately without applying duplicate credits.

---

## 3. Redis Goes Down or Is Flushed (Queue, Locks, Circuit Breakers)

### Failure Scenario
Redis crashes, is restarted, experiences network partitioning, runs out of memory, or executes `FLUSHALL` while transactions are in flight and workers are actively delivering webhooks. Additionally, Redis may be completely offline when the application starts up, or connection drops / timeouts / authentication errors may occur during runtime.

### State at Failure
- **Redis:** All cached idempotency keys, active BullMQ job queues, distributed circuit breaker states (`cb:endpoint:*`), rate limit token buckets, and in-flight mutexes are gone or unreachable.
- **PostgreSQL:** Completely unaffected. All committed accounts, ledger entries, idempotency records, outbox events, and historical delivery logs remain intact and fully transactional.

### Formal Guarantee
**Zero Data Loss & PostgreSQL Source-of-Truth Survivability:** Correctness never depends on Redis. Redis acts solely as an optional acceleration and coordination layer:
1. **Financial Correctness & Idempotency:** Enforced with durable serializability via PostgreSQL `idempotency_keys` table with `UNIQUE(merchant_id, key)` constraint and transactional row locking. Double-entry balance conservation ($\Delta = 0$) is mathematically guaranteed by PostgreSQL.
2. **Outbox Events Durability:** Enforced via PostgreSQL `outbox_events` table written inside the exact same database transaction as the ledger entries. No queue-related failure can ever cause committed transfers to lose their outbox events.
3. **Circuit Breakers & Rate Limits:** Gracefully fail-open or fall back to durable state stored in PostgreSQL `webhook_endpoints.circuit_breaker_state`.
4. **Delivery Semantics:** Guaranteed **At-Least-Once Delivery** with deterministic `event_id` and unique `delivery_id` headers. Recovery does not produce spurious or duplicate events beyond documented receiver-deduplicated retries.

### Recovery Path in Code

#### 1. Fail-Fast Client Lifecycle & Degraded Fallback ([src/redis/client.ts](file:///home/aryan/LedgerFlow/src/redis/client.ts))
- **`enableOfflineQueue: false`:** By default, ioredis queues commands offline when disconnected, causing callers to hang indefinitely if Redis is down. LedgerFlow explicitly sets `enableOfflineQueue: false` on application clients. When Redis is down or severed, commands immediately reject within milliseconds, allowing the API middleware to fall back to PostgreSQL without blocking HTTP requests.
- **Strict Command & Socket Timeouts:** Clients enforce `connectTimeout: 2000` and `commandTimeout: 2000`. Unresponsive sockets or network blackholes are terminated rather than consuming unbounded socket handles.
- **Separate BullMQ Lifecycle:** BullMQ workers and queues utilize dedicated connection configurations (`createBullMQRedisClient()`) with `maxRetriesPerRequest: null`, isolated from the API cache client, ensuring BullMQ connection requirements do not degrade application request handlers.

#### 2. Reconnection with Bounded Exponential Backoff and Jitter ([src/redis/client.ts](file:///home/aryan/LedgerFlow/src/redis/client.ts))
Both application Redis clients and BullMQ worker pollers use bounded exponential backoff with full proportional jitter:
$$\text{delay} = \min\left(\text{maxDelayMs}, \text{baseDelayMs} \times 2^{\min(\text{attempt}-1, 10)}\right) + \text{jitter}$$
- **Base delay:** 100 ms (API client) / 1,000 ms (poller).
- **Max delay:** 3,000 ms (API client) / 10,000 ms (poller).
- **Jitter ratio:** 30% randomized jitter spread across reconnection attempts to eliminate the **thundering herd** problem when Redis restarts.

#### 3. PostgreSQL Idempotency Fallback ([src/api/middlewares/idempotency.ts](file:///home/aryan/LedgerFlow/src/api/middlewares/idempotency.ts) & [src/api/controllers/transfers.controller.ts](file:///home/aryan/LedgerFlow/src/api/controllers/transfers.controller.ts))
- When Redis `SET ... NX` fails, the middleware catches the error, increments `idempotency_fallback_total`, logs a structured warning, and marks `redisAvailable = false`.
- The controller runs inside a PostgreSQL transaction:
  ```sql
  INSERT INTO idempotency_keys (key, merchant_id, request_hash, response_status, response_body, locked_at)
  VALUES ($1, $2, $3, NULL, NULL, NOW())
  ON CONFLICT (merchant_id, key) DO UPDATE
    SET locked_at = idempotency_keys.locked_at
  RETURNING key, request_hash, response_status, response_body;
  ```
- If a prior transaction committed: returns HTTP `201 Created` with `X-Idempotent-Replay: true` and the original response body.
- If request hash mismatches: returns HTTP `422 Unprocessable Entity` with `IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD`.
- If concurrent identical requests arrive while Redis is down: PostgreSQL serializes them on the row lock; the primary commits while concurrent contenders unblock, see `response_status = 201`, and return the replayed response. Zero money is moved twice.

#### 4. Outbox Poller Backoff & Queue Repopulation ([src/worker/index.ts](file:///home/aryan/LedgerFlow/src/worker/index.ts))
- Before polling PostgreSQL, the outbox poller inspects `queue.client.status`. If Redis is not in the `'ready'` state, polling is skipped. This prevents unnecessary database leasing of rows (`next_retry_at = NOW() + 30s`) that cannot be enqueued into BullMQ.
- If Redis disconnects mid-cycle, the poller records `outbox_poller_errors_total` and backs off exponentially (1s $\to$ 2s $\to$ 4s $\to$ 10s + jitter).
- The moment Redis reconnects, the poller resumes at adaptive speed (50ms interval) and drains the pending PostgreSQL outbox backlog without event loss.

#### 5. Health Check Separation: Liveness vs Readiness ([src/api/controllers/health.controller.ts](file:///home/aryan/LedgerFlow/src/api/controllers/health.controller.ts))
- **`GET /health/live` (and `/livez`):** Liveness probe. Verifies that the Node.js event loop and Express process are alive and responsive. Does **not** check external dependencies, preventing container orchestrators (Kubernetes/ECS) from entering cascading restart loops during transient Redis maintenance.
- **`GET /health/ready` (and `/readyz`):** Readiness probe. Distinguishes required dependencies:
  - **PostgreSQL:** Strictly **REQUIRED**. If PostgreSQL is down, returns HTTP `503 Service Unavailable` (`ready: false`).
  - **Redis:** **NON-BLOCKING**. If Redis is down but PostgreSQL is UP, returns HTTP `200 OK` with `{ status: "degraded", ready: true, degraded: true }`. Traffic continues to be routed to the instance.
- **`GET /health`:** Aggregate health check. Returns `200 OK` when both are healthy; returns `503 Service Unavailable` when either is down for backward compatibility with legacy monitoring scripts.

#### 6. Observability & Telemetry ([src/observability/metrics.ts](file:///home/aryan/LedgerFlow/src/observability/metrics.ts))
- **`redis_connected`:** Gauge reporting real-time Redis connection state (1 = connected/ready, 0 = disconnected/down).
- **`redis_errors_total{operation="connection|auth|bullmq"}`:** Counter tracking all socket, timeout, and authentication failures.
- **`idempotency_fallback_total`:** Counter incremented each time an API request falls back to PostgreSQL due to Redis unavailability.
- **`outbox_poller_errors_total`:** Counter tracking background poller recovery attempts.

---

## 4. PostgreSQL Failover or Connection Loss Mid-Transaction

### Failure Scenario
While an API request is inside an active transfer transaction (e.g., between `SELECT ... FOR UPDATE` and `COMMIT`), the PostgreSQL primary server terminates unexpectedly, network connectivity is severed, or a failover occurs.

### State at Failure
- **PostgreSQL:** The active database connection drops. The server-side transaction is uncommitted.
- **Redis:** The distributed lock `idemp:<merchant_id>:<key>` was acquired with a 30-second TTL.
- **Application:** `client.query()` throws a connection error (`ECONNRESET`, `57P01 admin shutdown`).

### Formal Guarantee
**Atomicity & Zero Invariant Leakage:** PostgreSQL guarantees that uncommitted transactions are completely rolled back upon socket termination. No partial ledger entries, no partial balance updates, and no orphaned outbox events are ever persisted.

### Recovery Path in Code
1. **Catch Block Rollback & Safe Lock Release ([src/api/controllers/transfers.controller.ts#L257-L270](file:///home/aryan/LedgerFlow/src/api/controllers/transfers.controller.ts#L257-L270)):**
   - The error is caught in the controller:
     ```typescript
     } catch (err) {
       try {
         await client.query('ROLLBACK');
       } catch {}
       if (idempotency && idempotency.redisAvailable) {
         await releaseSafeLock(idempotency.redisKey, idempotency.lockToken);
       }
       next(err);
     } finally {
       client.release();
     }
     ```
2. **Distributed Lock Clearance:**
   - `releaseSafeLock` ([src/api/middlewares/idempotency.ts#L48-L56](file:///home/aryan/LedgerFlow/src/api/middlewares/idempotency.ts#L48-L56)) executes an atomic compare-and-delete Lua script verifying the unique `lockToken`. It immediately deletes the Redis lock so that the client is not blocked from retrying immediately.
   - If the Redis connection is also down, the 30-second TTL ensures the lock automatically frees itself.
3. **Client Retry:**
   - The client receives HTTP 500. Upon reconnecting to the promoted PostgreSQL replica, the client retries with the same `Idempotency-Key`.
   - The transaction executes cleanly from scratch.

---

## 5. Merchant Endpoint Is Slow, Down, or Returning Garbage

### Failure Scenario
A registered webhook endpoint experiences severe latency (takes 60+ seconds to respond), crashes completely (HTTP 500/502/503 or ECONNREFUSED), or returns malformed payloads (infinite response streams, non-JSON HTML error dumps).

### State at Failure
- The background worker holds active worker concurrency slots.
- Partner queues risk head-of-line blocking and starvation if one merchant monopolizes worker threads.

### Formal Guarantee
**Fault Isolation & Zero Queue Starvation:** A broken or slow partner endpoint never starves healthy partner deliveries, never exhausts worker concurrency, and never exhausts server memory.

### Recovery Path in Code
1. **Hard Socket Timeout ([src/worker/index.ts#L258-L265](file:///home/aryan/LedgerFlow/src/worker/index.ts#L258-L265) & [src/security/ssrf.ts#L309](file:///home/aryan/LedgerFlow/src/security/ssrf.ts#L309)):**
   - Every outbound delivery enforces `WEBHOOK_DELIVERY_TIMEOUT_MS` (default 5,000 ms) directly on the HTTP request socket.
   - Sockets exceeding 5 seconds are forcefully aborted with `ECONNABORTED`.
2. **Response Stream & Memory Cap ([src/security/ssrf.ts#L252](file:///home/aryan/LedgerFlow/src/security/ssrf.ts#L252) & [src/security/ssrf.ts#L351-L358](file:///home/aryan/LedgerFlow/src/security/ssrf.ts#L351-L358)):**
   - Responses are capped at 64 KB (`maxResponseBytes = 65536`). Infinite streams or multi-megabyte payloads are destroyed, preventing OOM crashes.
   - Error snippets stored in `delivery_attempts.error_message` are truncated to 1,024 characters ([src/worker/index.ts#L287](file:///home/aryan/LedgerFlow/src/worker/index.ts#L287)).
3. **Per-Endpoint Concurrency Limiting ([src/worker/concurrency-limiter.ts](file:///home/aryan/LedgerFlow/src/worker/concurrency-limiter.ts)):**
   - Limits active dispatches per endpoint (default: 3 concurrent requests via `WEBHOOK_MAX_CONCURRENT_PER_ENDPOINT`).
   - If an endpoint has 3 slow requests in flight, subsequent dispatches are delayed by 250ms rather than occupying additional worker threads.
4. **Token Bucket Rate Limiting ([src/worker/rate-limiter.ts](file:///home/aryan/LedgerFlow/src/worker/rate-limiter.ts)):**
   - Evaluates a Redis Lua token bucket (default: 10 req/s, burst 20). Excess jobs are delayed without dropping.
5. **Distributed Circuit Breaker ([src/worker/circuit-breaker.ts#L191-L245](file:///home/aryan/LedgerFlow/src/worker/circuit-breaker.ts#L191-L245)):**
   - Consecutive failures are tracked. Upon 10 consecutive failures (or >50% rolling window failure rate), the circuit breaker trips to **`OPEN`**.
   - While `OPEN`, jobs for this endpoint are fast-rescheduled with delay in <1ms without hitting the network, and without incrementing retry attempts ([src/worker/index.ts#L168-L191](file:///home/aryan/LedgerFlow/src/worker/index.ts#L168-L191)).
   - After a 30-second cooldown, the breaker enters **`HALF_OPEN`** and admits a single probe request. If the probe succeeds, the breaker transitions to **`CLOSED`**; if it fails, it trips back to **`OPEN`**.
6. **Fair Outbox Sweeping ([src/worker/index.ts#L63-L74](file:///home/aryan/LedgerFlow/src/worker/index.ts#L63-L74)):**
   - The poller uses window function `ROW_NUMBER() OVER (PARTITION BY endpoint_id ORDER BY created_at ASC) as ep_rank`.
   - Interleaves polled batches across endpoints, ensuring healthy partners are never starved behind a massive backlog of failing events.

---

## 6. Clock Skew and Replayed Webhook Requests

### Failure Scenario
An attacker intercepts an outbound webhook payload and attempts to replay it against the partner receiver at a later date. Alternatively, significant time drift exists between the LedgerFlow server clock and the receiver's server clock.

### State at Failure
- The attacker transmits the identical payload and headers to the receiver.
- The cryptographic signature matches the payload.

### Formal Guarantee
**Cryptographic Replay Resistance & Tolerance Window:** Webhook requests cannot be replayed outside a strict 300-second tolerance window. Constant-time signature verification prevents side-channel timing attacks.

### Recovery Path in Code
1. **Timestamped Header Signing ([src/worker/signature.ts#L19-L36](file:///home/aryan/LedgerFlow/src/worker/signature.ts#L19-L36)):**
   - The worker computes Unix timestamp `t = Math.floor(Date.now() / 1000)`.
   - Constructs the signing buffer: `${t}.${payloadString}`.
   - Computes HMAC-SHA256 with the endpoint's high-entropy secret (`whsec_...`).
   - Dispatches header: `X-LedgerFlow-Signature: t=1700000000,v1=a1b2c3...`.
2. **Receiver Verification Protocol ([src/worker/signature.ts#L41-L100](file:///home/aryan/LedgerFlow/src/worker/signature.ts#L41-L100)):**
   - The receiver parses `t` and `v1`.
   - **Replay Window Assertion:**
     ```typescript
     const currentTs = Math.floor(Date.now() / 1000);
     if (Math.abs(currentTs - timestamp) > toleranceSeconds) { // default 300s
       return { valid: false, reason: 'Signature timestamp outside tolerance window' };
     }
     ```
   - **Timing-Safe Equality:**
     ```typescript
     const matches = crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
     if (!matches) {
       return { valid: false, reason: 'Signature mismatch' };
     }
     ```
3. **Known Limitation & Requirement:**
   - If the receiver's system clock drifts by more than 300 seconds relative to standard NTP time, valid webhooks will be rejected with `timestamp outside tolerance window`. Both LedgerFlow nodes and receiver systems must run NTP synchronization (e.g. `chrony` or `systemd-timesyncd`).

---

## 7. Poison Events That Always Fail

### Failure Scenario
A webhook payload is pointed at an unrouteable destination, an endpoint that permanently returns HTTP 400 Bad Request due to a contract mismatch, or an invalid scheme that passes initial validation.

### State at Failure
- The event repeatedly fails delivery whenever picked up by the worker.

### Formal Guarantee
**Bounded Retries & Dead-Letter Isolation:** Poison events cannot loop indefinitely, cannot monopolize queue capacity, and cannot block subsequent outbox events. After 5 failed attempts, the event is permanently relegated to dead-letter storage.

### Recovery Path in Code
1. **Exponential Backoff with Jitter ([src/worker/index.ts#L351-L361](file:///home/aryan/LedgerFlow/src/worker/index.ts#L351-L361)):**
   - For attempts 1 through 4, the event is rescheduled:
     ```typescript
     const backoffSeconds = Math.pow(2, nextAttempts) + Math.random() * 0.5;
     ```
   - `outbox_events.next_retry_at` is updated to `NOW() + interval 'X seconds'`.
2. **Dead-Letter Transition ([src/worker/index.ts#L341-L350](file:///home/aryan/LedgerFlow/src/worker/index.ts#L341-L350)):**
   - On the 5th failed attempt:
     ```sql
     UPDATE outbox_events 
     SET status = 'DEAD_LETTER', attempts = $2, next_retry_at = NULL 
     WHERE id = $1
     ```
   - The event transitions to status `'DEAD_LETTER'`. It is excluded from future poller queries (`WHERE status = 'PENDING'`).
3. **Operator Inspection & Manual Replay ([src/api/controllers/outbox.controller.ts#L155-L330](file:///home/aryan/LedgerFlow/src/api/controllers/outbox.controller.ts#L155-L330)):**
   - Operators inspect failure history via `GET /outbox/:id` (which returns all granular attempt logs, durations, HTTP statuses, and error snippets from `delivery_attempts`).
   - Once the issue is resolved on the partner side, the operator triggers manual replay:
     - `POST /outbox/:id/replay` (single event replay)
     - `POST /outbox/replay-batch` (replays all dead-lettered events for an endpoint)
   - The replay endpoint resets `status = 'PENDING'`, resets `attempts = 0`, sets `next_retry_at = NOW()`, preserves all prior audit attempt rows, and enqueues the event with the **same original `event_id`** so the partner can safely deduplicate.

---

## 8. Two Workers Picking Up the Same Outbox Row

### Failure Scenario
Multiple instances of the outbox worker daemon are deployed across multiple containers or servers. Two workers execute their polling loops at the exact same millisecond.

### State at Failure
- Both workers query the PostgreSQL `outbox_events` table simultaneously for eligible pending events.

### Formal Guarantee
**Mutual Exclusion & Non-Blocking Partitioning:** No two worker threads can ever acquire the same outbox row concurrently. Neither worker blocks or deadlocks the other.

### Recovery Path in Code
1. **Row-Level Locking with `FOR UPDATE SKIP LOCKED` ([src/worker/index.ts#L62-L84](file:///home/aryan/LedgerFlow/src/worker/index.ts#L62-L84)):**
   ```sql
   WITH eligible AS (
     SELECT o.id,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(o.endpoint_id, '00000000-0000-0000-0000-000000000000'::UUID)
              ORDER BY o.created_at ASC
            ) as ep_rank
     FROM outbox_events o
     WHERE o.status = 'PENDING'
       AND (o.next_retry_at IS NULL OR o.next_retry_at <= NOW())
     ORDER BY ep_rank ASC, o.created_at ASC
     LIMIT $1
   )
   SELECT o.id, o.event_type, o.target_url, o.payload, o.attempts, o.endpoint_id, o.request_id,
          e.secret as endpoint_secret,
          e.rate_limit_per_second, e.rate_limit_burst
   FROM outbox_events o
   JOIN eligible el ON o.id = el.id
   LEFT JOIN webhook_endpoints e ON e.id = o.endpoint_id
   ORDER BY el.ep_rank ASC, o.created_at ASC
   FOR UPDATE OF o SKIP LOCKED;
   ```
2. **Locking Mechanics:**
   - Worker 1 opens a transaction (`BEGIN`) and issues the query. PostgreSQL locks the returned rows for Worker 1.
   - When Worker 2 issues the query simultaneously, `SKIP LOCKED` instructs PostgreSQL to immediately ignore rows currently locked by Worker 1 and fetch only subsequent unlocked rows.
3. **Lease Extension Before Commit ([src/worker/index.ts#L94-L101](file:///home/aryan/LedgerFlow/src/worker/index.ts#L94-L101)):**
   - Inside the transaction, Worker 1 updates:
     ```sql
     UPDATE outbox_events 
     SET next_retry_at = NOW() + INTERVAL '30 seconds' 
     WHERE id = ANY($1)
     ```
   - Worker 1 commits.
   - When Worker 1's lock is released, the rows are already set to `next_retry_at = NOW() + 30s`, meaning any subsequent poller query immediately excludes them (`WHERE next_retry_at <= NOW()`).
4. **BullMQ Job Deduplication ([src/worker/index.ts#L120-L123](file:///home/aryan/LedgerFlow/src/worker/index.ts#L120-L123)):**
   - Enqueued with deterministic job ID: `${row.id}-${row.attempts}-${Date.now()}`.
   - Even in edge cases of queue resubmission, BullMQ deduplicates concurrent job insertion.

---

## 9. Summary of Guarantees & Known Limitations

| Component | Operational Guarantee | Fallback Mechanism | File Reference |
| :--- | :--- | :--- | :--- |
| **Double-Entry Balance** | Mathematical conservation ($\Delta = 0$ paise) | Database constraint `CHECK (balance_paise >= 0)` & atomic ledger entries under `SELECT FOR UPDATE` | [008_account_balance_caching.sql](file:///home/aryan/LedgerFlow/src/db/migrations/008_account_balance_caching.sql) |
| **Balance Integrity** | Continuous discrepancy monitoring | `reconcileAccountBalances()` service + `POST /admin/reconcile` trigger + Prometheus invariant gauge | [reconciliation.ts](file:///home/aryan/LedgerFlow/src/services/reconciliation.ts) |
| **API Idempotency** | Strictly exactly-once execution (0 double debits) | Fast-path Redis lock with owner token $\to$ Durable PostgreSQL `UNIQUE(merchant_id, key)` | [idempotency.ts](file:///home/aryan/LedgerFlow/src/api/middlewares/idempotency.ts) |
| **Outbox Dispatch** | Guaranteed at-least-once delivery | Atomic transaction with ledger entries $\to$ Poller sweep with 30s lease renewal | [worker/index.ts](file:///home/aryan/LedgerFlow/src/worker/index.ts) |
| **Worker Concurrency** | Zero duplicate worker processing | PostgreSQL `FOR UPDATE OF o SKIP LOCKED` | [worker/index.ts#L82](file:///home/aryan/LedgerFlow/src/worker/index.ts#L82) |
| **Fault Isolation** | Broken partner never starves queue | Distributed circuit breaker (`OPEN` after 10 fails) + Token bucket rate limit + Concurrency cap | [circuit-breaker.ts](file:///home/aryan/LedgerFlow/src/worker/circuit-breaker.ts) |
| **SSRF Security** | Zero private/loopback/metadata ingress | DNS resolution + IP socket pinning (`lookup` agent) + hop-by-hop redirect verification | [ssrf.ts](file:///home/aryan/LedgerFlow/src/security/ssrf.ts) |
| **Signature Verification**| Replay defense via 300s window | HMAC-SHA256 (`t=...,v1=...`) with `crypto.timingSafeEqual` | [signature.ts](file:///home/aryan/LedgerFlow/src/worker/signature.ts) |

### Explicit Known Limitations
1. **Receiver Idempotency Obligation:** LedgerFlow guarantees *at-least-once* delivery over unreliable networks. Receivers **must** check `event_id` or `X-LedgerFlow-Event-Id` to guarantee exactly-once side-effects within their own applications. True exactly-once delivery across external HTTP networks is physically impossible.
2. **NTP Clock Synchronization Requirement:** Webhook signature verification allows up to 300 seconds of tolerance. Receivers with clock drift greater than 5 minutes will reject valid dispatches.
3. **Database Connection Pool Saturation:** In extremely high concurrency environments (>500 concurrent connections per node), transactions queue behind PostgreSQL row locks and pool connections (`DB_POOL_MAX=60`). Scale horizontally with transaction pooling (e.g., PgBouncer) if concurrency exceeds 10,000 req/s.
4. **Dead-Letter Storage Retention:** Events entering `DEAD_LETTER` remain in the database indefinitely until replayed or pruned by operators via database maintenance scripts.

---

## 10. Redis Degraded-Mode Architecture & Operator Recovery Playbook

### 10.1 Degraded-Mode Behavioral Matrix

When Redis is unavailable (down, restarting, partitioned, out-of-memory, or experiencing authentication errors), LedgerFlow automatically transitions into **Degraded Mode**. No operator intervention is required to trigger this mode:

| Component | Normal State (Redis UP) | Degraded State (Redis DOWN) | Correctness & Financial Guarantee |
| :--- | :--- | :--- | :--- |
| **API Ingress (`POST /transfers`)** | Accepts requests; uses Redis fast-path lock & cache | Accepts requests; bypasses Redis lock, falls back to PostgreSQL | Fully preserved. Zero double debits or balance drift. |
| **Idempotency Locking** | 30s Redis distributed lock with owner token | PostgreSQL `INSERT ... ON CONFLICT (merchant_id, key)` | Fully preserved. Concurrent requests with identical key serialize on row lock. |
| **Idempotent Replays** | Cached response returned from Redis in <5ms | Response fetched from PostgreSQL `idempotency_keys` in ~15ms | Fully preserved. Identical response returned with `X-Idempotent-Replay: true`. |
| **Key Reuse Detection** | Mismatched hash rejected from Redis cache | Mismatched hash rejected from PostgreSQL record | Fully preserved. Returns HTTP 422 `IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD`. |
| **Double-Entry Ledger** | Atomic PostgreSQL transaction (`BEGIN ... COMMIT`) | Atomic PostgreSQL transaction (`BEGIN ... COMMIT`) | Identical. Ledger entries balance strictly to zero ($\Delta = 0$). |
| **Outbox Persistence** | Inserted into PostgreSQL `outbox_events` table | Inserted into PostgreSQL `outbox_events` table | Zero data loss. Outbox rows committed in same transaction as ledger entries. |
| **Outbox Poller** | Polls PostgreSQL and pushes jobs to BullMQ | Pauses polling until Redis is `'ready'`, backs off exponentially | Zero lost events. Rows remain `PENDING` with untouched or safe lease timers. |
| **Webhook Worker** | Processes BullMQ jobs with rate/concurrency limits | Pauses execution until Redis reconnects | Webhook dispatches pause during outage and catch up upon recovery. |
| **Circuit Breaker** | Distributed state stored in Redis hash (`cb:endpoint:*`) | Falls back to durable state in PostgreSQL `webhook_endpoints` | Broken endpoints remain guarded via PostgreSQL fallback state. |
| **Rate Limiter** | Token bucket Lua script in Redis | Fails open gracefully to prevent blocking valid webhook traffic | Temporary fail-open prevents queue stalls when rate limiter storage is degraded. |
| **Liveness Probe (`/health/live`)** | HTTP 200 OK | HTTP 200 OK | Containers remain running; orchestrators do NOT crash loop. |
| **Readiness Probe (`/health/ready`)**| HTTP 200 OK (`status: "ok"`) | HTTP 200 OK (`status: "degraded"`, `ready: true`) | Traffic continues flowing to API instances. |

---

### 10.2 Delivery Semantics: Why "Exactly-Once External Delivery" Is Mathematically Impossible

> [!IMPORTANT]
> **LedgerFlow Delivery Guarantee:** LedgerFlow provides **Guaranteed At-Least-Once Delivery** with deterministic deduplication identifiers.
> 
> True "exactly-once delivery" across external HTTP networks is **physically and mathematically impossible** under the **Two Generals' Problem** and Fischer-Lynch-Paterson (FLP) impossibility result. If an HTTP POST request is dispatched across an untrusted network, any of the following scenarios can occur:
> 1. The recipient receives the webhook and processes it, but the TCP socket is severed before the HTTP 200 acknowledgement reaches LedgerFlow.
> 2. The recipient experiences a timeout or gateway reset (HTTP 504) after committing side-effects.
> 3. A container dies immediately after sending the byte stream but before writing the delivery attempt record to PostgreSQL.
>
> In all such cases, any resilient system must retry. Therefore, duplicate dispatches **will** happen across network disruptions.
> 
> To guarantee that partner receivers achieve **strict exactly-once side effects**, LedgerFlow implements the following contract:
> - **`event_id` (`payload.event_id` and `X-LedgerFlow-Event-Id` header):** Completely **STABLE** across all attempts, retries, and manual replays.
> - **`delivery_id` (`payload.delivery_id` and `X-LedgerFlow-Delivery-Id` header):** Completely **UNIQUE** per transmission attempt.
>
> **Receiver Requirement:** Partner endpoints must maintain a database table with a unique constraint on `event_id`. When a webhook arrives with an already-processed `event_id`, the partner must immediately acknowledge with HTTP `200 OK` without duplicating actions.

---

### 10.3 Operator Telemetry & Alerting Indicators

During a Redis failure or degradation event, monitor the following metrics exposed at `GET /metrics`:

| Metric Name | Expected Normal Value | Degraded Mode Value | Alert Severity |
| :--- | :--- | :--- | :--- |
| `redis_connected` | `1` | `0` | **Critical (P1)** |
| `redis_errors_total` | Constant / 0 | Rapidly increasing | **High (P2)** |
| `idempotency_fallback_total` | `0` | Increasing at rate of incoming transfers | **Warning (P3)** |
| `outbox_poller_errors_total` | `0` | Increasing (backed off exponentially) | **High (P2)** |
| `outbox_queue_depth{status="PENDING"}` | Low (<100) | Accumulating linearly with transfers | **High (P2)** |
| `ledger_conservation_discrepancy_paise` | Strictly `0` | Strictly `0` (must NEVER deviate) | **Disaster (P0)** |

**Structured Log Queries (Pino JSON):**
- Redis connection drop: `{"event": "redis_error"}`
- Reconnection attempt: `{"event": "redis_reconnecting", "attempt": ..., "delay_ms": ...}`
- Idempotency falling back to PostgreSQL: `{"event": "idempotency_redis_fallback"}`
- Outbox poller backoff: `{"event": "outbox_poller_error", "consecutive_errors": ...}`

---

### 10.4 Operator Step-by-Step Recovery Runbook

When an alert fires or Redis becomes unreachable, operators should execute the following five-phase runbook:

#### Phase 1: Triage and Ingress Verification
1. **Check API Liveness & Readiness:**
   ```bash
   # Verify API is alive
   curl -i http://localhost:3000/health/live
   # HTTP/1.1 200 OK {"status":"ok","uptime_seconds":...}

   # Verify API is serving in degraded mode
   curl -i http://localhost:3000/health/ready
   # HTTP/1.1 200 OK {"status":"degraded","ready":true,"degraded":true,"services":{"postgres":{"status":"up"},"redis":{"status":"down"}}}
   ```
2. **Confirm Financial Invariants:**
   ```bash
   curl -s http://localhost:3000/metrics | grep ledger_conservation_discrepancy_paise
   # Must output: ledger_conservation_discrepancy_paise 0
   ```
   Ensure the discrepancy is 0. Customers are safe to continue submitting transfers.

#### Phase 2: Inspect & Restore Redis Service
1. **Check Redis Process / Container Status:**
   ```bash
   # If running via Docker Compose
   docker compose ps redis
   docker compose logs --tail=100 redis

   # If running natively as a systemd service
   sudo systemctl status redis
   sudo journalctl -u redis -n 100 --no-pager
   ```
2. **Common Root Causes & Resolutions:**
   - **OOM Kill (`maxmemory` exceeded):** Check `redis-cli INFO memory`. If Redis was terminated due to memory pressure, increase Redis maxmemory in `redis.conf` or evict non-essential keys.
   - **Crash or Frozen Socket:** Restart the Redis container or daemon:
     ```bash
     docker compose restart redis
     # or: sudo systemctl restart redis
     ```
   - **Authentication Failure (`WRONGPASS` / `NOAUTH`):** Verify `REDIS_URL` in `.env` matches Redis credentials:
     ```bash
     redis-cli -u "$REDIS_URL" ping
     ```

#### Phase 3: Observe Automatic Reconnection
1. LedgerFlow clients will automatically reconnect using bounded exponential backoff with jitter (within 100ms - 3000ms).
2. Check that the readiness probe transitions to fully healthy:
   ```bash
   curl -i http://localhost:3000/health/ready
   # HTTP/1.1 200 OK {"status":"ok","ready":true,"degraded":false,"services":{"postgres":{"status":"up"},"redis":{"status":"up"}}}
   ```
3. Verify Redis metric recovers:
   ```bash
   curl -s http://localhost:3000/metrics | grep "redis_connected"
   # Output: redis_connected 1
   ```

#### Phase 4: Backlog Drainage & Outbox Sweep
1. Monitor the pending outbox queue depth as the poller drains accumulated events:
   ```bash
   curl -s http://localhost:3000/metrics | grep 'outbox_queue_depth{status="PENDING"}'
   ```
   The poller automatically switches to adaptive drain mode (50ms interval), enqueuing all pending events to BullMQ.
2. Watch worker logs:
   ```bash
   docker compose logs -f --tail=50 worker
   ```
   Confirm jobs are being completed (`Job completed.`).

#### Phase 5: Dead-Letter Audit & Replay (Optional)
1. If any events exhausted retries (e.g. partner endpoints were down alongside Redis), check dead-letter count:
   ```bash
   curl -s http://localhost:3000/metrics | grep 'outbox_queue_depth{status="DEAD_LETTER"}'
   ```
2. Replay dead-letter events safely using the admin API:
   ```bash
   curl -X POST http://localhost:3000/outbox/<event_id>/replay \
     -H "Authorization: Bearer <API_KEY>"
   ```
   The event will be re-enqueued with its original stable `event_id` for receiver deduplication.

#### Phase 6: Post-Incident Ledger Reconciliation
Trigger an on-demand reconciliation run to ensure 100% cryptographic balance integrity:
```bash
curl -X POST http://localhost:3000/admin/reconcile \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
# {"status":"COMPLETED","discrepancies_found":0,"accounts_reconciled":...}
```
