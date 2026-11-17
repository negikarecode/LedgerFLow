# LedgerFlow 🌊

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)](https://github.com/features/actions)
[![Tests](https://img.shields.io/badge/Tests-64%2F64%20Passing-brightgreen?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **LedgerFlow** is an enterprise-grade, multi-tenant, idempotent double-entry financial ledger and webhook delivery engine that guarantees strict balance conservation (0 paise lost or created), zero-overdraft concurrency control, cryptographic API-key multi-tenancy, and at-least-once signed webhook dispatch with automatic crash recovery.

---

## Architecture

LedgerFlow decouples synchronous money movement from asynchronous partner notification using the **Transactional Outbox Pattern** and a multi-tier **Idempotency Guard**.

```mermaid
flowchart LR
    Client["Client / Chaos UI<br/>(Bearer API Key Auth)"]
    API["Express API Server<br/>(Zod Validation + Scoped Idempotency)"]
    Redis[("Redis 7<br/>• Namespaced Mutex (NX)<br/>• Fast Replay Cache<br/>• BullMQ Work Queue")]
    Postgres[("PostgreSQL 16<br/>• merchants & api_keys<br/>• accounts (tenant-scoped)<br/>• ledger_entries (Immutable)<br/>• webhook_endpoints<br/>• outbox_events")]
    Worker["Outbox Worker<br/>(BullMQ Consumer + Exponential Backoff)"]
    SSRF["SSRF Defense Engine<br/>• DNS Rebinding Pinning<br/>• Private & Metadata Filter<br/>• Hop-by-Hop Redirect Check"]
    Merchant["Registered Webhook Receivers<br/>(Stripe-Style HMAC t=...,v1=...)"]

    Client -->|1. POST /transfers (Idempotency-Key)| API
    API -->|2. SET idemp:merchant:key LOCKED NX| Redis
    API -->|3. ACID Tx: Lock Accounts, Entries, Fan-out Outbox| Postgres
    API -->|4. Release lock & Cache response| Redis
    Worker -->|5. Sweep PENDING events into BullMQ| Postgres
    Worker -->|6. Process job with retry backoff| Redis
    Worker -->|7. Validate & pin target IP| SSRF
    SSRF -->|8. POST payload + HMAC signature| Merchant
    Worker -->|9. Mark event DELIVERED / DEAD_LETTER| Postgres
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

### 2. Comprehensive Test Suite (64/64 Passing)
LedgerFlow includes extensive automated integration, concurrency, security, and unit tests using **Vitest** and **Supertest**:

```bash
npm test
```

```
 ✓ tests/worker.test.ts (10 tests)
   ✓ Retry -> Recovery Pipeline: retries on merchant 500, recovers to DELIVERED on 200
 ✓ tests/auth.test.ts (15 tests)
   ✓ Admin Bootstrap Authentication (ADMIN_TOKEN): creates merchant & live API key
   ✓ Merchant API Key Authentication (requireApiKey): validates prefix & constant-time hash
   ✓ Multi-Tenancy Cross-Tenant Resource Isolation: returns 404 (not 403) on foreign accounts, ledgers, outboxes
   ✓ Namespaced Idempotency Keys across Tenants: identical keys between merchants never collide
 ✓ tests/webhooks.test.ts (16 tests)
   ✓ SSRF Security: blocks private IPv4 (10/8, 172.16/12, 192.168/16, 127/8) & IPv6
   ✓ SSRF Security: blocks AWS/GCP/Azure link-local metadata (169.254.169.254)
   ✓ SSRF Security: resolves hostnames & blocks DNS rebinding via IP pinning
   ✓ SSRF Security: validates redirects on every hop & blocks redirect to private IP
   ✓ Stripe-Style Signatures: verifies HMAC-SHA256 (t=...,v1=...) & rejects stale timestamps
   ✓ Endpoints CRUD: registers, lists, deletes endpoints & rotates secrets securely
   ✓ Fan-Out Outbox: automatically generates outbox event per active registered endpoint on transfer
 ✓ tests/api.test.ts (12 tests)
   ✓ Accounts & Ledger balance calculation (BIGINT paise)
 ✓ tests/transfers.test.ts (11 tests)
   ✓ Race-Condition Stress: 50 concurrent transfers; zero overdraft guarantee
   ✓ Deadlock Prevention: opposite-direction transfers (A->B and B->A); zero PostgreSQL deadlocks

 Test Files  5 passed (5)
      Tests  64 passed (64)
   Duration  9.15s
```

---

## Core Engineering Principles

### 1. Multi-Tenant Architecture & Cryptographic API Keys
LedgerFlow implements secure multi-tenancy with strict cryptographic guarantees:
- **API Key Format:** `lf_live_<random 32+ bytes base64url>`.
- **Zero Raw Key Storage:** Keys are SHA-256 hashed at rest. The full raw key is revealed **strictly once** at creation time.
- **Timing Attack Defense:** All key and admin token comparisons execute in constant time via Node.js `crypto.timingSafeEqual`.
- **Information Leakage Prevention:** Any attempt by a tenant to query, read, or transfer to/from a foreign tenant's account returns HTTP `404 Not Found` (never `403 Forbidden`), completely eliminating resource enumeration vulnerabilities.
- **Tenant-Namespaced Idempotency:** Redis locking (`idemp:<merchant_id>:<key>`) and PostgreSQL durable constraints (`PRIMARY KEY (merchant_id, key)`) ensure that two different merchants using identical idempotency keys will never collide or cross-contaminate.

### 2. Integer-Only Accounting (Paise, Not Floats)
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

### 4. Transactional Outbox & Fan-Out Delivery
Dual-write problems occur when an API writes to a database and publishes an event to an external service: if the network fails midway, systems desynchronize.
- LedgerFlow writes the financial ledger and all subscribed `outbox_events` records in a **single atomic PostgreSQL transaction**.
- `POST /transfers` does not accept raw client-specified URLs; instead, it looks up all registered `ACTIVE` webhook endpoints for the authenticated merchant subscribed to `transfer.completed` and enqueues outbox events atomically.
- A dedicated background worker consumes pending outbox events using BullMQ, dispatches HTTP POST requests to merchant endpoints, and attaches cryptographic signatures.
- Upstream outages trigger exponential backoff retries (`2s, 4s, 8s, 16s...`) before dead-letter routing.

### 5. Multi-Layer SSRF Defense & Stripe-Style Webhook Signatures
Webhooks dispatched to arbitrary partner URLs present severe Server-Side Request Forgery (SSRF) and replay risks:
- **Dedicated SSRF Engine (`src/security/ssrf.ts`):**
  - **Comprehensive CIDR Filtering:** Blocks private IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`), CGNAT (`100.64.0.0/10`), IPv6 loopback/ULA/link-local (`::1`, `fc00::/7`, `fe80::/10`), and cloud provider metadata services (`169.254.169.254` on AWS, GCP, Azure).
  - **DNS Rebinding Protection:** Resolves hostnames via DNS and pins the validated IP address at connection time using a custom HTTP/HTTPS `Agent` `lookup` callback, ensuring the socket connects exclusively to the verified IP.
  - **Hop-by-Hop Redirect Validation:** Re-resolves and inspects every redirect hop (up to 3 hops), immediately terminating any request redirecting to private or loopback addresses.
  - **Hard Timeouts & Size Caps:** 5-second socket timeout and 64 KB response size cap to prevent slowloris or denial-of-service memory exhaustion.
  - **Production Guard:** Enforces `https://` in production; supports `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` for local development and Docker demo suites.
- **Stripe-Style Webhook Signatures:**
  - Each endpoint is assigned a secret (`whsec_<64 hex bytes>`), revealed strictly once at creation and rotatable on demand.
  - Headers contain `X-LedgerFlow-Signature: t=<unix_timestamp>,v1=<hmac_sha256>`.
  - Receivers verify HMAC over `${t}.${payload}` and reject timestamps older than tolerance (e.g. 300s) to completely defeat replay attacks.

---

## API Reference

Interactive OpenAPI 3.0 documentation is available at [http://localhost:3000/docs](http://localhost:3000/docs).

| Method | Endpoint | Description | Key Headers / Body |
| :--- | :--- | :--- | :--- |
| `POST` | `/admin/merchants` | Admin bootstrap tenant & generate first API key | Header: `Authorization: Bearer <ADMIN_TOKEN>`<br/>Body: `{ name }` |
| `GET` | `/health` | PostgreSQL & Redis health check (Public) | Returns status, latencies |
| `GET` | `/accounts` | List accounts scoped to authenticated merchant | Header: `Authorization: Bearer <api_key>` |
| `POST` | `/accounts` | Create account with optional seed credit | Header: `Authorization: Bearer <api_key>`<br/>Body: `{ owner_name, currency, initial_credit_paise }` |
| `GET` | `/accounts/:id` | Get account details & recent ledger entries | Header: `Authorization: Bearer <api_key>` |
| `GET` | `/accounts/:id/ledger`| Get calculated balance & entry statement | Header: `Authorization: Bearer <api_key>` |
| `POST` | `/transfers` | Atomic transfer; enqueues outbox events to registered endpoints | Headers: `Authorization: Bearer <api_key>`, `Idempotency-Key`<br/>Body: `{ from_account_id, to_account_id, amount_paise }` |
| `GET` | `/webhook-endpoints` | List registered webhook endpoints for tenant | Header: `Authorization: Bearer <api_key>` |
| `POST` | `/webhook-endpoints` | Register new webhook endpoint (SSRF validated) | Header: `Authorization: Bearer <api_key>`<br/>Body: `{ url, event_types, status }` |
| `DELETE`| `/webhook-endpoints/:id` | Delete registered webhook endpoint | Header: `Authorization: Bearer <api_key>` |
| `POST` | `/webhook-endpoints/:id/rotate-secret` | Rotate webhook signing secret | Header: `Authorization: Bearer <api_key>` |
| `GET` | `/outbox` | View outbox events scoped to merchant | Header: `Authorization: Bearer <api_key>`<br/>Query: `?status=PENDING\|DELIVERED\|DEAD_LETTER` |
| `POST` | `/outbox/:id/replay` | Reset dead-letter event for immediate redelivery | Header: `Authorization: Bearer <api_key>` |
| `GET` | `/mock-merchant/status`| View status and verified HMAC payloads received | — (Public demo tool) |
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
  5. `npm test` (executes 64 Vitest integration test cases)

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
