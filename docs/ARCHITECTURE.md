# LedgerFlow Architecture & Design Decisions

This document details the architectural patterns, database schemas, concurrency controls, and distributed guarantees implemented in LedgerFlow.

```mermaid
flowchart LR
    Client["Client / Chaos UI<br/>(Bearer API Key Auth)"]
    API["Express API Server<br/>(Zod Validation + Scoped Idempotency)"]
    Redis[("Redis 7<br/>• Namespaced Mutex (NX)<br/>• Fast Replay Cache<br/>• BullMQ Work Queue<br/>• Circuit Breaker State<br/>• Token Bucket Rate Limiter (Lua)")]
    Postgres[("PostgreSQL 16<br/>• merchants & api_keys<br/>• accounts (tenant-scoped, cached balance)<br/>• ledger_entries (Immutable)<br/>• webhook_endpoints & cb_state<br/>• outbox_events & delivery_attempts")]
    Worker["Outbox Worker<br/>(BullMQ Consumer + Concurrency Guard + Fair Poller)"]
    SSRF["SSRF Defense Engine<br/>• DNS Rebinding Pinning<br/>• Private & Metadata Filter<br/>• Hop-by-Hop Redirect Check"]
    Merchant["Registered Webhook Receivers<br/>(Stripe-Style HMAC t=...,v1=...<br/>Dedupe: X-LedgerFlow-Event-Id)"]

    Client -->|1. POST /transfers (Idempotency-Key)| API
    API -->|2. SET idemp:merchant:key LOCKED NX| Redis
    API -->|3. ACID Tx: Lock Accounts, Update Balances, Entries, Outbox| Postgres
    API -->|4. Release lock & Cache response| Redis
    Worker -->|5. Sweep PENDING events (fair partition)| Postgres
    Worker -->|6. Process job: Check Circuit Breaker & Rate Limit| Redis
    Worker -->|7. Validate & pin target IP (hard timeout)| SSRF
    SSRF -->|8. POST payload + HMAC signature (event_id, delivery_id)| Merchant
    Worker -->|9. Record delivery_attempt & update breaker state| Postgres
```

---

## 1. Design Decisions & Tradeoffs

### Why Transactional Outbox?
In distributed systems, updating a database and publishing an event (or invoking a webhook) in the same handler creates a dual-write hazard:
- If the database commits but the network dispatch fails, the event is lost.
- If the network call succeeds but the database rolls back, the partner receives a phantom notification.

LedgerFlow writes outbox events inside the **exact same ACID transaction** as `ledger_entries` and `accounts.balance_paise`. The database commit guarantees that either both persist or neither does. A decoupled background worker polls and dispatches events asynchronously with at-least-once delivery guarantees.

### Why Redis Plus PostgreSQL for Idempotency?
- **Why Not Pure Redis?** Redis is in-memory and volatile. An eviction, crash, or flush clears all locks; concurrent client retries after a restart could double-execute transfers. Furthermore, a long-running database transaction could outlive a Redis TTL lock.
- **Why Not Pure PostgreSQL?** Relying solely on PostgreSQL forces every request (including rapid client double-clicks and repeated polling replays) to perform disk I/O, row locks, and write transactions on an `idempotency_keys` table, creating index bloat and connection pool saturation under high concurrency.
- **The Hybrid Architecture:**
  - **Redis as Fast-Path Mutex & Cache:** Redis provides sub-millisecond mutex locking (`SET idemp:<merchant_id>:<key> <token> EX 30 NX`) and an in-memory replay cache. Sibling requests arriving while a transaction is in-flight receive HTTP 409 Conflict in <1ms without touching PostgreSQL.
  - **PostgreSQL as Durable Source of Truth:** Correctness *never* relies on Redis. At transaction start, LedgerFlow executes `INSERT INTO idempotency_keys ... ON CONFLICT (merchant_id, key) DO UPDATE ... RETURNING ...` under a `PRIMARY KEY (merchant_id, key)`. If Redis is down or lock keys expire, transactions serialize cleanly on PostgreSQL row locks: the second transaction waits for the first to commit, discovers the completed status and cached response, and returns the idempotent replay without moving funds.

### Why BullMQ?
BullMQ provides battle-tested job queuing on top of Redis streams and hashes: worker concurrency pooling, delayed retries with exponential backoff and jitter, worker heartbeat monitoring, and clean shutdown hooks without the operational overhead of Kafka or RabbitMQ for single-cluster deployments.

LedgerFlow pairs BullMQ with a fair outbox poller running `ROW_NUMBER() OVER (PARTITION BY endpoint_id ORDER BY created_at ASC) <= 5`, ensuring events across heterogeneous endpoints are interleaved fairly before being handed to BullMQ.

### What Would Change at 100x Scale? (e.g., 50,000+ transfers/sec)
1. **WAL-Based CDC via Debezium & Kafka:** Polling PostgreSQL with `SELECT ... FOR UPDATE SKIP LOCKED` introduces read amplification and autovacuum overhead at 50,000 events/sec. At scale, the transactional outbox table is read via PostgreSQL Write-Ahead Log (WAL) replication slots using Debezium, streaming mutations directly into Apache Kafka or Apache Pulsar partitioned by `endpoint_id`.
2. **Horizontal Tenant Sharding:** Because transfers occur strictly between accounts of the *same* merchant, database tables (`accounts`, `ledger_entries`, `idempotency_keys`) can be sharded horizontally across independent PostgreSQL clusters using `merchant_id` as the shard key.
3. **Read/Write Splitting & Connection Pooling:** Deploy PgBouncer in transaction pooling mode alongside read replicas for balance statements (`GET /accounts/:id/ledger`), historical attempt queries (`GET /outbox/:id`), and continuous reconciliation jobs.
4. **Dedicated Webhook Egress Gateway:** Route outbound webhook HTTP traffic through an isolated Kubernetes egress node pool with proxies (Envoy / Squid) to strictly enforce network policies, IP pinning, and prevent socket/port exhaustion on the main API and worker clusters.

---

## 2. Core Invariants & Engineering Guarantees

### Integer-Only Accounting (Paise, Not Floats)
IEEE 754 floating-point arithmetic causes rounding errors (`0.1 + 0.2 === 0.30000000000000004`). LedgerFlow stores all amounts strictly as 64-bit integers (`BIGINT`) representing **paise** (1 INR = 100 paise; e.g. ₹500.25 = 50,025 paise).

Balances are maintained as a cached `balance_paise BIGINT NOT NULL CHECK (balance_paise >= 0)` on the `accounts` table, updated atomically in the same transaction under row-level lock. All historical movements are recorded in an append-only `ledger_entries` table (`CREDIT` / `DEBIT`), with a continuous reconciliation job verifying that `accounts.balance_paise` equals `SUM(CREDIT) - SUM(DEBIT)` with zero discrepancy.

### Deadlock-Free Concurrency Control
When Alice sends money to Bob while Bob sends money to Alice concurrently, unordered row-locking causes database deadlocks (`40P01 deadlocks detected`). LedgerFlow prevents deadlocks deterministically by sorting account UUIDs lexicographically before acquiring locks:

```typescript
const [firstId, secondId] = [from_account_id, to_account_id].sort();
await client.query(
  `SELECT id, balance_paise FROM accounts WHERE id IN ($1, $2) AND merchant_id = $3 ORDER BY id FOR UPDATE`,
  [firstId, secondId, merchantId]
);
```

### Per-Endpoint Circuit Breaker & Rate Limiter
A single failing, slow, or malicious partner endpoint must not monopolize worker queues for healthy partners:
- **Distributed Circuit Breaker (`CLOSED` / `OPEN` / `HALF_OPEN`):** Tracks failure state in Redis with PostgreSQL fallback. Trips to `OPEN` after 10 consecutive failures or >50% error rate in a rolling window. While `OPEN`, jobs are delayed without hitting the network or burning retry attempts. Transitions to `HALF_OPEN` after a 30s cooldown and allows a single probe request.
- **Token Bucket Rate Limiting (Redis Lua):** Restricts dispatch rate per endpoint (default 10 req/s, burst 20). Excess jobs are delayed, never dropped.
- **Concurrency & Fair Polling:** In-flight concurrency is capped at 3 per endpoint, and outbox polling partitions events by `endpoint_id` so healthy endpoints are never starved by failing ones.
