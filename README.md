# LedgerFlow 🌊

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)](https://github.com/features/actions)
[![Tests](https://img.shields.io/badge/Tests-102%2F102%20Passing-brightgreen?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **LedgerFlow** is a multi-tenant double-entry financial ledger and webhook delivery engine built with TypeScript, PostgreSQL 16, and Redis 7. It prevents overdrafts with ordered row-level locking, enforces idempotency across rapid retries via a hybrid Redis/PostgreSQL layer, and decouples money movement from partner notifications using the Transactional Outbox pattern with per-endpoint circuit breakers and SSRF protection.

![LedgerFlow Chaos Simulator Demo](docs/images/demo.gif)
*Interactive Mission Control: Live Double-Entry Ledger, Chaos Stress Engine, and Real-Time Webhook Outbox.*

---

## Documentation Map

- 🏛️ **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):** Detailed system design, data flows, and tradeoff analysis.
- 📊 **[docs/BENCHMARKS.md](docs/BENCHMARKS.md):** Multi-account load profiles, contention analysis, and profiling bottleneck breakdown.
- 🛡️ **[docs/FAILURE_MODES.md](docs/FAILURE_MODES.md):** Code-level analysis of 8 catastrophic failure scenarios, invariants, and recovery paths.
- 🔒 **[docs/SECURITY.md](docs/SECURITY.md):** Multi-tenant authentication, SSRF engine, DNS pinning, and HMAC signatures.
- 📖 **[docs/API.md](docs/API.md):** Complete endpoint reference, schemas, error codes, and curl examples.
- 🚀 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md):** Production checklists, Render blueprint (`render.yaml`), and Fly.io deployment.

---

## Architecture

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

## Quickstart (One-Command Setup)

Run the full stack (API, Worker, PostgreSQL 16, Redis 7, Prometheus, Grafana, and Chaos UI) via Docker Compose:

```bash
docker compose up -d --build
```

- **Chaos Simulator UI:** [http://localhost:3000](http://localhost:3000)
- **Interactive Swagger 3.0 API Docs:** [http://localhost:3000/docs](http://localhost:3000/docs)
- **Grafana Metrics Dashboard:** [http://localhost:3001](http://localhost:3001)
- **Prometheus Raw Metrics:** [http://localhost:3000/metrics](http://localhost:3000/metrics)

---

## 60-Second Chaos Demo

Open **[http://localhost:3000](http://localhost:3000)** in your browser to run live stress tests:

1. **20x Double-Tap Protection:** Click `⚡ Simulate 20x Double-Tap`. Fires 20 parallel requests with the identical `Idempotency-Key`. Exactly 1 transfer commits (`201 Created`); remaining in-flight requests return `409 Conflict` or a cached `201` replay. Money moves once.
2. **20x Overdraft Race Guard:** Click `💥 Simulate 20x Race Condition`. 20 parallel transfers attempt to debit ₹500 simultaneously from an account holding only ₹500. Alphabetical row-level locking (`SELECT ... FOR UPDATE`) ensures exactly 1 debit succeeds (`201 Created`) and 19 fail safely (`422 Insufficient Funds`). Final balance: ₹0.00.
3. **Crash Recovery & At-Least-Once Webhooks:** Click `Crash Merchant` to simulate partner downtime (500 errors). Submit a transfer: money moves synchronously, while the webhook moves to `RETRYING` with exponential backoff. Click `Recover Merchant`: the worker re-dispatches and transitions status to `DELIVERED`.

---

## Design Decisions & Tradeoffs

- **Why Transactional Outbox?** Discarding the dual-write hazard. Writing ledger entries and `outbox_events` in the same database transaction guarantees that events are persisted if and only if money moves.
- **Why Redis + PostgreSQL for Idempotency?** Redis acts as a fast-path mutex (`SET NX EX 30`) and replay cache (<1ms response). PostgreSQL acts as the durable source of truth with `PRIMARY KEY (merchant_id, key)`: if Redis restarts or flushes, concurrent requests serialize on database row locks and replay safely without double-debiting.
- **Why BullMQ with Fair Polling?** BullMQ provides concurrency control, exponential backoff, and worker pooling. A fair SQL poller (`ROW_NUMBER() OVER PARTITION BY endpoint_id`) interleaves events across endpoints so high-volume or dead merchants cannot starve healthy queues.
- **What Changes at 100x Scale?** Replace outbox polling with WAL Change Data Capture (Debezium + Kafka/Pulsar) to eliminate table churn; shard PostgreSQL horizontally by `merchant_id`; and route outbound webhooks through dedicated egress proxies.

*(Read the full architectural breakdown in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).)*

---

## Benchmarks & Bottleneck Analysis

Measured on an Intel Core i3-2120 CPU @ 3.30 GHz (2 physical cores / 4 threads, 7.6 GB RAM) running PostgreSQL 16, Redis 7, Prometheus, Grafana, API, and Worker:

| Workload | Concurrency | Throughput | p50 Latency | p95 Latency | 500 Errors | Balance Invariant |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Hot-Account Contention (1 pair)** | 50 | **62.1 req/s** | 4,839 ms | 7,855 ms | 0 | $\Delta = 0$ paise ✅ |
| **Realistic Multi-Account (100 pairs)** | 10 | **58.0 req/s** | **135 ms** | 586 ms | 0 | $\Delta = 0$ paise ✅ |
| **Realistic Multi-Account (100 pairs)** | 25 | **59.7 req/s** | **406 ms** | 794 ms | 0 | $\Delta = 0$ paise ✅ |
| **Realistic Multi-Account (100 pairs)** | 50 | **44.4 req/s** | **1,009 ms** | 1,987 ms | 0 | $\Delta = 0$ paise ✅ |

> **Contention vs. Throughput Takeaway:** Spreading traffic across 100 accounts eliminated lock-wait queuing (p50 latency dropped from 4,839 ms to 135 ms). However, throughput remained ~45–60 req/s because the system bottleneck on this host is CPU and serial network I/O: each transfer runs 11 sequential PostgreSQL queries and 4 Redis calls inside a single Node.js process alongside databases and monitoring.  
> *(See profiling breakdown and scaling paths in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).)*

---

## Security & Production Hardening

- **Multi-Tenant Scoping:** All queries filter on `merchant_id` foreign key. Querying foreign accounts returns 404 (not 403) to prevent resource enumeration.
- **API Keys & Timing Defense:** Keys (`lf_live_...`) are stored as SHA-256 hashes and compared in constant time (`crypto.timingSafeEqual`).
- **SSRF Defense Engine:** Outbound webhooks resolve DNS and block private IPv4, IPv6, CGNAT, and cloud metadata (`169.254.169.254`). Sockets are pinned to the validated IP to defeat DNS rebinding. Redirects are inspected hop-by-hop.
- **Replay-Tolerant Signatures:** Dispatches include Stripe-style `X-LedgerFlow-Signature: t=<unix>,v1=<hmac>`, rejecting timestamps older than 300 seconds.
- **Environment Flags:** `DEMO_MODE=false` by default to disable destructive reset routes in production. Optional `METRICS_TOKEN` protects `/metrics`.

*(See detailed threat modeling in [docs/SECURITY.md](docs/SECURITY.md).)*

---

## Automated Test Suite (102/102 Passing)

```bash
npm test
```

```
 ✓ tests/circuit-breaker.test.ts (6 tests)
 ✓ tests/delivery-attempts.test.ts (9 tests)
 ✓ tests/idempotency.test.ts (9 tests)
 ✓ tests/reconciliation.test.ts (5 tests)
 ✓ tests/worker.test.ts (10 tests)
 ✓ tests/auth.test.ts (17 tests)
 ✓ tests/webhooks.test.ts (16 tests)
 ✓ tests/observability.test.ts (7 tests)
 ✓ tests/api.test.ts (12 tests)
 ✓ tests/transfers.test.ts (11 tests)

 Test Files  10 passed (10)
      Tests  102 passed (102)
   Duration  41.8s
```

---

## Local Development (Without Docker)

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev          # Terminal 1: API server
npm run worker:dev   # Terminal 2: Outbox worker
npm test             # Run test suite
npm run benchmark    # Run concurrency benchmark
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
