# LedgerFlow Benchmark & Performance Report

**Generated:** `2026-11-17T14:40:15.955Z`  
**Command:** `npm run benchmark` (or `API_URL=http://localhost:3000 npm run benchmark`)

---

## 1. Test Environment & Machine Specifications

All benchmarks were executed locally against the containerized production stack (PostgreSQL 16, Redis 7, Express API, BullMQ Worker):

| Component | Specification |
| :--- | :--- |
| **CPU Model** | Intel(R) Core(TM) i3-2120 CPU @ 3.30GHz |
| **CPU Cores** | 4 cores |
| **Total System Memory** | 7.64 GB RAM |
| **Operating System** | linux (7.0.0-43-generic, x64) |
| **Node.js Runtime** | v24.22.0 |
| **PostgreSQL Database** | PostgreSQL 16-alpine (max connections: 100, pool max: 60) |
| **Redis Cache / Broker** | Redis 7-alpine (in-memory + persistence) |

---

## 2. Summary of Scenarios & Realistic Findings

LedgerFlow tests three distinct concurrency paradigms to provide honest, transparent numbers without cherry-picking:

1. **Scenario 1: Hot-Account Contention Test (500 req on 1 pair):**
   - **Characteristics:** All 500 requests compete for the *exact same* account pair.
   - **Key Finding:** Throughput is ~**62.1 req/s** with p95 latency ~**7854.8 ms**. Latency is intentionally dominated by row-lock serialization (`SELECT ... FOR UPDATE`) to guarantee mathematical double-entry balance conservation (0 paise lost or created).
2. **Scenario 2: Realistic Multi-Account Throughput (100 Accounts, Ramping Concurrency):**
   - **Characteristics:** 100 accounts (50 senders, 50 receivers), random distinct pairs, 80% unique transactions, 15% cached replays, 5% in-flight duplicates.
   - **Key Finding:** As concurrency ramps from 10 to 50, throughput reaches **59.7 req/s** with p95 latencies between **586.0 ms** and **1987.1 ms**.
3. **Scenario 3: Webhook Delivery Lag & Fault Isolation:**
   - **Characteristics:** End-to-end event delivery lag measured across event rates, plus a 20% failing endpoint chaos test.
   - **Key Finding:** Median delivery lag is **1048.0 ms**. When 20% of partner endpoints fail (500 Internal Server Error), their distributed circuit breaker trips to `OPEN`, preventing queue starvation and allowing healthy endpoints to deliver with 100% success rate.

---

## 3. Detailed Benchmark Results

### Scenario 1: Hot-Account Contention Test
> **Note:** Measures worst-case lock queuing under maximum single-pair contention. NOT representative of multi-account throughput.

| Metric | Result | Description |
| :--- | :--- | :--- |
| **Total Requests** | `500` | 350 unique, 50 cache replay, 100 in-flight dup |
| **Throughput (req/s)** | **`62.1 req/s`** | Bounded by row-level serialization |
| **p50 Latency (Median)**| `4839.91 ms` | Half of requests completed within this time |
| **p90 Latency** | `7810.01 ms` | 90th percentile latency |
| **p95 Latency** | `7854.84 ms` | 95th percentile latency |
| **p99 Latency** | `7912.51 ms` | Worst-case tail latency under contention |
| **201 Created count** | `95` | Fresh transfers committed |
| **201 Replay count** | `69` | Fast-path idempotent replays (`X-Idempotent-Replay: true`) |
| **409 Conflict count** | `71` | In-flight duplicate key lock rejections |
| **422 Insufficient count** | `265` | Zero-overdraft protection triggered |
| **500 Server Errors** | `0` | Zero deadlocks, zero crashes |
| **Net Discrepancy** | **`0 paise`** | **✅ Exact conservation verified** |

---

### Scenario 2: Realistic Multi-Account Throughput (Ramping Concurrency)
> **Setup:** 100 seeded wallets (50 senders, 50 receivers, ₹5,000.00 each), random distinct pairings, 80% unique transactions, 15% cached replays, 5% in-flight duplicates.

| Concurrency Tier | Total Requests | Total Duration | Throughput (req/s) | p50 Latency | p90 Latency | p95 Latency | p99 Latency | 500 Errors | Balance Invariant |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Concurrency 10** | `250` | `4.31s` | **`58.0 req/s`** | `134.52 ms` | `402.45 ms` | `586.02 ms` | `881.38 ms` | `0` | **`Δ = 0 paise`** ✅ |
| **Concurrency 25** | `400` | `6.70s` | **`59.7 req/s`** | `405.64 ms` | `635.01 ms` | `794.27 ms` | `928.65 ms` | `0` | **`Δ = 0 paise`** ✅ |
| **Concurrency 50** | `600` | `13.50s` | **`44.4 req/s`** | `1008.56 ms` | `1836.04 ms` | `1987.12 ms` | `2506.03 ms` | `0` | **`Δ = 0 paise`** ✅ |

---

### Scenario 3A: End-to-End Webhook Delivery Lag
> **Measurement:** Elapsed time from database commit timestamp (`outbox_events.created_at`) to partner HTTP acknowledgement (`200 OK`).

| Event Ingestion Rate | Events Sent | Events Delivered | p50 Delivery Lag | p95 Delivery Lag | p99 Delivery Lag | Average Lag |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **10 events/sec** | `25` | `25` | **`1048.0 ms`** | `2793.0 ms` | `2987.0 ms` | `1246.0 ms` |
| **25 events/sec** | `40` | `40` | **`988.0 ms`** | `1914.0 ms` | `2332.0 ms` | `931.5 ms` |
| **50 events/sec** | `60` | `60` | **`375.0 ms`** | `1244.0 ms` | `1434.0 ms` | `581.3 ms` |

---

### Scenario 3B: Fault Isolation (20% Failing Endpoints)
> **Setup:** 5 registered partner webhook endpoints (4 healthy, 1 returning HTTP 500 server error).

| Metric | Result | Operational Status |
| :--- | :--- | :--- |
| **Total Registered Endpoints** | `5` | 4 healthy (80%), 1 crashing (20%) |
| **Healthy Deliveries Received** | `48` | **100% delivered to healthy partners** |
| **Failing Endpoint Circuit Breaker** | `OPEN` | **Tripped to OPEN**; requests paused without burning retries |
| **Healthy Partner Delivery Lag** | `690.7 ms` | Zero latency penalty on healthy traffic |
| **Queue Starvation Verified** | `0` | **Zero queue starvation** confirmed |

---

## 4. Architectural Bottlenecks Profiled & Fixed

1. **Eliminated $O(N)$ Balance Scan (`balance_paise` Column on `accounts`):**
   - *Previous Bottleneck:* Every transfer performed `SELECT COALESCE(SUM(...)) FROM ledger_entries WHERE account_id = $1`, scanning all historical ledger entries sequentially under the lock.
   - *Fix Implemented:* Added a cached `balance_paise BIGINT NOT NULL DEFAULT 0` column on `accounts` with a database-level `CHECK (balance_paise >= 0)` constraint. Balances are updated in the *exact same transaction* under the existing `SELECT ... FOR UPDATE` lock in $O(1)$ time.
2. **Continuous Account Balance Reconciliation:**
   - Implemented `reconcileAccountBalances()` and `POST /admin/reconcile`. Periodically compares `accounts.balance_paise` with the immutable ledger `SUM` and double-entry debits/credits, alerting immediately on any discrepancy.
3. **Database Connection Pool Sizing:**
   - Increased PostgreSQL pool max to `60` (configured via `DB_POOL_MAX`) to allow up to 60 concurrent database transactions without socket timeouts.
4. **Outbox Polling Index Optimization:**
   - Added a composite partial index `idx_outbox_events_pending_polling ON outbox_events(status, next_retry_at, created_at) WHERE status = 'PENDING'` for instant queue sweeps.
