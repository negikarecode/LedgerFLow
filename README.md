# LedgerFlow 🌊

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)](https://github.com/features/actions)
[![Tests](https://img.shields.io/badge/Tests-33%2F33%20Passing-brightgreen?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **LedgerFlow** is a fault-tolerant, idempotent double-entry financial ledger and webhook delivery engine that guarantees strict balance conservation (0 paise lost or created), zero-overdraft concurrency control, and at-least-once signed webhook dispatch with automatic crash recovery.

---

## Architecture

LedgerFlow decouples synchronous money movement from asynchronous partner notification using the **Transactional Outbox Pattern** and a multi-tier **Idempotency Guard**.

```mermaid
flowchart LR
    Client["Client / Chaos UI<br/>(Browser / REST Client)"]
    API["Express API Server<br/>(Zod Validation + Idempotency Middleware)"]
    Redis[("Redis 7<br/>• In-Flight Mutex (NX)<br/>• Fast 24h Replay Cache<br/>• BullMQ Work Queue")]
    Postgres[("PostgreSQL 16<br/>• accounts<br/>• ledger_entries (Immutable)<br/>• idempotency_keys (Durable)<br/>• outbox_events (Transactional)")]
    Worker["Outbox Worker<br/>(BullMQ Consumer + Exponential Backoff)"]
    Merchant["Mock Merchant Receiver<br/>(HMAC-SHA256 Signature Verification)"]

    Client -->|1. POST /transfers with Idempotency-Key| API
    API -->|2. SET idemp:key LOCKED NX (Acquire mutex)| Redis
    API -->|3. ACID Tx: SELECT FOR UPDATE, Debit/Credit, Outbox insert| Postgres
    API -->|4. Release lock & Cache 201 response| Redis
    Worker -->|5. Sweep PENDING events into BullMQ| Postgres
    Worker -->|6. Process job with retry backoff| Redis
    Worker -->|7. POST payload + X-LedgerFlow-Signature| Merchant
    Worker -->|8. Mark event DELIVERED / DEAD_LETTER| Postgres
```

---

## One-Command Setup

Run the entire production stack (API server, Background Worker, PostgreSQL 16, Redis 7, and interactive Chaos Simulator UI) with a single command:

```bash
docker compose up -d --build
```

Verify service health:
```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "timestamp": "2026-11-17T11:14:53.447Z",
  "services": {
    "postgres": { "status": "up", "latencyMs": 2 },
    "redis": { "status": "up", "latencyMs": 1 }
  }
}
```

Interactive interfaces:
- **Chaos Simulator & Webhook Dashboard:** [http://localhost:3000](http://localhost:3000)
- **Interactive Swagger 3.0 API Docs:** [http://localhost:3000/docs](http://localhost:3000/docs)

---

## 60-Second Chaos Demo

Open **[http://localhost:3000](http://localhost:3000)** in your browser to experience the real-time visual Chaos Simulator.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  LedgerFlow Interactive Mission Control                                                │
│  ┌──────────────────────┐  ┌─────────────────────────┐  ┌───────────────────────────┐  │
│  │   Accounts & Ledger  │  │  Chaos Stress Engine    │  │  Mock Merchant Receiver   │  │
│  │   • Alice: ₹1,000.00 │  │  [⚡ Double-Tap (20x)]  │  │  Status: [200 OK] (Healthy│  │
│  │   • Bob:     ₹500.00 │  │  [💥 Race Cond  (20x)]  │  │  [Crash Merchant]         │  │
│  │   • Net:   ₹1,500.00 │  │                         │  │                           │  │
│  └──────────────────────┘  └─────────────────────────┘  └───────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1. Test "Double-Tap" Protection (Shared Idempotency Key)
1. In the **Chaos Stress Engine** panel, click **`⚡ Simulate 20x Double-Tap (Shared Key)`**.
2. **What Happens:** The frontend fires 20 parallel requests simultaneously using the **exact same `Idempotency-Key`**.
3. **Guaranteed Outcome:**
   - Request 1 acquires the Redis mutex and executes atomically (HTTP `201 Created`).
   - Sibling requests in-flight receive HTTP `409 Conflict` (request in progress) or cached HTTP `201` with `X-Idempotent-Replay: true`.
   - **Funds are debited exactly ONCE.** The ledger balance never suffers double deduction.

### 2. Test Race Condition & Zero-Overdraft Guard
1. Select an account with ₹500 balance (50,000 paise).
2. Click **`💥 Simulate 20x Race Condition (Overdraft Guard)`**.
3. **What Happens:** 20 parallel transfers attempt to debit ₹500 *each* at the exact same millisecond (total attempted debit: ₹10,000).
4. **Guaranteed Outcome:**
   - PostgreSQL row-level locks (`SELECT FOR UPDATE`) serialized by alphabetical account ID guarantee zero race conditions.
   - **Exactly 1 transfer succeeds** (`201 Created`).
   - **19 transfers fail safely** (`422 Unprocessable Entity - Insufficient funds`).
   - Final balance is ₹0.00. Zero overdraft permitted.

### 3. Test Merchant Crash Recovery & At-Least-Once Webhooks
1. In the **Mock Merchant Receiver** panel, click **`Crash Merchant`**.
   - Mock merchant now simulates upstream outage returning HTTP `500 Server Error`.
2. Initiate any transfer with webhook enabled.
3. Observe the **Transactional Outbox**:
   - The transfer succeeds immediately with funds moved (`201 Created`).
   - The webhook event enters status `PENDING`, then transitions to `RETRYING` as BullMQ catches upstream failures and applies exponential backoff (`attempts: 1, 2, 3...`).
4. Click **`Recover Merchant`** (restores HTTP `200 OK`).
5. Within seconds, the background worker re-delivers the webhook, verifies the merchant response, and transitions the outbox status to `DELIVERED`.

---

## Benchmarks & Correctness

### 1. 500-Request Concurrency Benchmark
Run the automated stress harness against the live Docker stack:

```bash
npm run benchmark
```

#### Real Benchmark Results:
```
=================================================================================
               LEDGERFLOW LOAD BENCHMARK & CONCURRENCY SUITE                     
=================================================================================
[1/4] Verifying API Server health at http://localhost:3000...
  ✓ Connected to API Server (PostgreSQL + Redis UP)

[2/4] Seeding Benchmark Wallets in PostgreSQL...
  ✓ Account A (Sender)   : 912969a6-ee52-487b-864a-ed62dcdf3512 | Balance: ₹1000.00 (100000 paise)
  ✓ Account B (Receiver) : b6290e2b-173e-4c9b-b727-f7d5475cbbb4 | Balance: ₹500.00 (50000 paise)
  ✓ Total Seeded Balance : ₹1500.00 (150000 paise)
  ✓ Pre-settled 5 transfers to test completed idempotency cache replays

[3/4] Preparing 500 concurrent transfer requests...
  ✓ Workload Mix: 350 unique keys + 50 cache replay keys + 100 in-flight duplicate keys
  ✓ Firing 500 concurrent POST /transfers (Transfer Amount: 1000 paise each)...

[4/4] Verifying Double-Entry Ledger Conservation Invariants...

=================================================================================
                          BENCHMARK SUMMARY REPORT                               
=================================================================================
┌─────────┬────────────────────────────────┬──────────────────────────────┐
│ (index) │ Metric                         │ Value                        │
├─────────┼────────────────────────────────┼──────────────────────────────┤
│ 0       │ 'Total Requests'               │ '500'                        │
│ 1       │ 'Requests/sec'                 │ '153.5 req/s'                │
│ 2       │ 'p50 Latency (ms)'             │ '2517.92 ms'                 │
│ 3       │ 'p95 Latency (ms)'             │ '2991.86 ms'                 │
│ 4       │ 'p99 Latency (ms)'             │ '3043.66 ms'                 │
│ 5       │ '201 Created count'            │ '95'                         │
│ 6       │ '422 Insufficient Funds count' │ '265'                        │
│ 7       │ 'X-Idempotent-Replay count'    │ '50'                         │
│ 8       │ '409 Conflict count'           │ '90'                         │
│ 9       │ '500 Server Errors count'      │ '0'                          │
│ 10      │ 'Initial Seeded Sum'           │ '₹1500.00 (150000 paise)'    │
│ 11      │ 'Final Ledger Sum'             │ '₹1500.00 (150000 paise)'    │
│ 12      │ 'Net Discrepancy'              │ '0 paise'                    │
│ 13      │ 'Ledger Audit Status'          │ '✅ 0 paise lost or created' │
└─────────┴────────────────────────────────┴──────────────────────────────┘
```

### 2. Comprehensive Test Suite (33/33 Passing)
LedgerFlow includes extensive automated integration and unit tests using **Vitest** and **Supertest**:

```bash
npm test
```

```
 ✓ tests/api.test.ts (12 tests) 248ms
 ✓ tests/transfers.test.ts (11 tests) 8379ms
   ✓ Validation & Header Checks > should return 400 Bad Request when Idempotency-Key header is missing
   ✓ Validation & Header Checks > should return 400 Bad Request when from_account_id equals to_account_id
   ✓ Normal Transfer & Outbox Creation > should atomically transfer funds between accounts and record outbox event
   ✓ Race-Condition Stress Test > should handle 50 concurrent transfers of 20000 paise on 50000 paise account: exactly 2 succeed (201), 48 fail (422), final balance 10000
   ✓ Opposite-Direction Deadlock Test > should fire concurrent A -> B and B -> A transfers and assert zero PostgreSQL deadlocks
 ✓ tests/worker.test.ts (10 tests) 1166ms
   ✓ Signature Generation & Verification > should sign payload with sha256 HMAC and verify successfully
   ✓ Outbox Worker & Mock Merchant Suite > should retry on merchant 500, then recover to DELIVERED on merchant 200

 Test Files  3 passed (3)
      Tests  33 passed (33)
   Duration  12.43s
```

---

## Core Engineering Principles

### 1. Integer-Only Accounting (Paise, Not Floats)
IEEE 754 floating-point arithmetic causes rounding errors (`0.1 + 0.2 === 0.30000000000000004`). LedgerFlow stores all amounts strictly as 64-bit integers (`BIGINT`) representing **paise** (1 INR = 100 paise; e.g. ₹500.25 = 50,025 paise). Balance calculations utilize SQL `SUM()` aggregations over immutable `CREDIT` and `DEBIT` entries.

### 2. Deadlock-Free Concurrency Control
When Alice sends money to Bob while Bob sends money to Alice concurrently, naive row-locking (`SELECT FOR UPDATE`) causes database deadlocks (`40P01 deadlocks detected`). LedgerFlow prevents deadlocks deterministically by sorting account UUIDs lexicographically before acquiring locks:

```typescript
// Sort IDs alphabetically to enforce consistent locking order across all transactions
const [firstId, secondId] = [from_account_id, to_account_id].sort();
await client.query(
  `SELECT id FROM accounts WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`,
  [firstId, secondId]
);
```

### 3. Multi-Layer Idempotency Guard
Idempotency ensures that network retries or accidental double-clicks never duplicate transfers:
1. **Redis Fast-Lock (NX + EX):** An atomic `SET idemp:<key> LOCKED EX 30 NX` immediately rejects concurrent duplicate submissions with `409 Conflict`.
2. **PostgreSQL Durable Store:** On commit, the original HTTP status and response payload are written to `idempotency_keys` inside the **same database transaction** as the ledger entries.
3. **Subsequent Replays:** Return the cached response with header `X-Idempotent-Replay: true` in <2ms without touching the ledger.

### 4. Transactional Outbox & HMAC Webhooks
Dual-write problems occur when an API writes to a database and publishes an event to an external service: if the network fails midway, systems desynchronize.
- LedgerFlow writes the financial ledger and the `outbox_events` record in a **single atomic PostgreSQL transaction**.
- A dedicated background worker consumes pending outbox events using BullMQ, dispatches HTTP POST requests to merchant endpoints, and attaches an `X-LedgerFlow-Signature: sha256=<hmac>` header computed with the merchant's secret key.
- Upstream outages trigger exponential backoff retries (`2s, 4s, 8s, 16s...`) before dead-letter routing.

---

## API Reference

Interactive OpenAPI 3.0 documentation is available at [http://localhost:3000/docs](http://localhost:3000/docs).

| Method | Endpoint | Description | Key Headers / Body |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | PostgreSQL & Redis health check | Returns status, latencies |
| `GET` | `/accounts` | List accounts with computed balances | — |
| `POST` | `/accounts` | Create account with seed credit | `{ owner_name, currency, initial_credit_paise }` |
| `GET` | `/accounts/:id` | Get account details & recent ledger entries | — |
| `GET` | `/accounts/:id/ledger`| Get calculated balance & entry statement | — |
| `POST` | `/transfers` | Atomic transfer between accounts | Header: `Idempotency-Key` (required)<br/>Body: `{ from_account_id, to_account_id, amount_paise, webhook_url }` |
| `GET` | `/outbox` | View outbox events and delivery status | Query: `?status=PENDING\|DELIVERED\|DEAD_LETTER` |
| `GET` | `/mock-merchant/events`| View events received by mock merchant | — |
| `POST` | `/mock-merchant/crash` | Toggle mock merchant crash mode | `{ "crash": true \| false }` |

---

## Continuous Integration (GitHub Actions)

LedgerFlow includes an automated CI pipeline defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml):
- **Triggers:** All `push` and `pull_request` events to `main` and `master`.
- **Services:** Isolated containerized `postgres:16-alpine` and `redis:7-alpine`.
- **Pipeline Stages:**
  1. `npm ci` (clean dependency installation)
  2. `tsc --noEmit` (strict TypeScript type verification)
  3. `npm run migrate` (applies schema migrations)
  4. `npm run build` (builds production artifacts)
  5. `npm test` (executes 33 Vitest integration test cases)

---

## Local Development (Without Docker)

If you prefer running services directly on your host:

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env

# 3. Run database migrations
npm run migrate

# 4. Start API server in dev mode
npm run dev

# 5. Start background outbox worker
npm run worker:dev

# 6. Run test suite
npm test

# 7. Run concurrency benchmark
npm run benchmark
```

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
