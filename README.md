# LedgerFlow 🌊

**LedgerFlow** is an idempotent double-entry payment and webhook delivery engine built with TypeScript, Node.js, Express, PostgreSQL, and Redis.

---

## Architecture Overview

- **Double-Entry Ledger (`src/db/`):** Financial amounts are stored strictly as integers in **paise** (1 INR = 100 paise; never floats). All account balance changes produce immutable `CREDIT` / `DEBIT` records in `ledger_entries`.
- **Idempotency Guarantee:** Pre-engineered `idempotency_keys` table to store payload hashes, execution locks, and cached response payloads to prevent double-charges.
- **Transactional Outbox (`outbox_events`):** Outbox pattern ensures guaranteed at-least-once delivery of webhook notifications.
- **Webhook Worker (`src/worker/`):** High-throughput asynchronous webhook worker stub powered by **BullMQ** with exponential backoff retry support.
- **API Server (`src/api/`):** Express REST API with Zod schema validation, structured error handling, and interactive Swagger UI documentation at `/docs`.

---

## Project Structure

```text
LedgerFlow/
├── src/
│   ├── api/
│   │   ├── controllers/         # Request handling logic (health, accounts)
│   │   ├── docs/                # OpenAPI 3.0 specification & Swagger UI
│   │   ├── middlewares/         # Zod validator & global error handlers
│   │   ├── routes/              # Express route definitions
│   │   ├── schemas/             # Zod input validation schemas
│   │   ├── app.ts               # Express application setup
│   │   └── server.ts            # Application bootstrapper & graceful shutdown
│   ├── db/
│   │   ├── migrations/
│   │   │   └── 001_init.sql     # PostgreSQL schema DDL (4 core tables)
│   │   ├── pool.ts              # pg connection pool & health checker
│   │   └── migrate.ts           # Migration runner
│   ├── redis/
│   │   └── client.ts            # ioredis client & health checker
│   ├── worker/
│   │   └── index.ts             # BullMQ webhook worker entry point
│   ├── config/
│   │   └── env.ts               # Type-safe environment config
│   └── index.ts                 # Main exports
├── tests/
│   └── api.test.ts              # Vitest & Supertest automated test suite
├── Dockerfile                   # Multi-stage container build
├── docker-compose.yml           # Compose orchestrating Postgres 16, Redis 7, & API
├── package.json
└── tsconfig.json
```

---

## Database Schema (`001_init.sql`)

1. **`accounts`**:
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `owner_name TEXT NOT NULL`
   - `currency TEXT NOT NULL DEFAULT 'INR'`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

2. **`ledger_entries`**:
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `transaction_id UUID NOT NULL`
   - `account_id UUID NOT NULL REFERENCES accounts(id)`
   - `entry_type TEXT NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT'))`
   - `amount BIGINT NOT NULL CHECK (amount > 0)` *(Paise, integer)*
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

3. **`idempotency_keys`**:
   - `key TEXT PRIMARY KEY`
   - `request_hash TEXT NOT NULL`
   - `response_status INT`
   - `response_body JSONB`
   - `locked_at TIMESTAMPTZ`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

4. **`outbox_events`**:
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `event_type TEXT NOT NULL`
   - `payload JSONB NOT NULL`
   - `target_url TEXT NOT NULL`
   - `status TEXT NOT NULL CHECK (status IN ('PENDING', 'DELIVERED', 'DEAD_LETTER')) DEFAULT 'PENDING'`
   - `attempts INT NOT NULL DEFAULT 0`
   - `next_retry_at TIMESTAMPTZ`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

---

## Quick Start with Docker Compose

Ensure Docker daemon access is enabled for your user:
```bash
# If needed, grant docker socket permissions:
sudo chmod 666 /var/run/docker.sock
```

Start all services (PostgreSQL 16, Redis 7, and LedgerFlow API):
```bash
docker compose up -d
```

Check health status:
```bash
curl http://localhost:3000/health
```

Expected output:
```json
{
  "status": "ok",
  "timestamp": "2026-11-17T01:00:00.000Z",
  "services": {
    "postgres": { "status": "up", "latencyMs": 2 },
    "redis": { "status": "up", "latencyMs": 1 }
  }
}
```

---

## API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Verifies PostgreSQL (`SELECT 1`) and Redis (`PING`) |
| `GET` | `/docs` | Interactive Swagger UI documentation |
| `GET` | `/docs.json` | OpenAPI 3.0 specification |
| `GET` | `/accounts` | List accounts with calculated ledger balances |
| `POST` | `/accounts` | Create an account with optional seed credit in paise |
| `GET` | `/accounts/:id` | Get account details with recent ledger entries |

### Example: Create Account with Seed Credit

```bash
curl -X POST http://localhost:3000/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "owner_name": "Aarav Patel",
    "currency": "INR",
    "initial_credit_paise": 50000
  }'
```

Response (`201 Created`):
```json
{
  "id": "e9b2c3a4-8f7d-4b2c-9a1d-3e5f7a9b1c2d",
  "owner_name": "Aarav Patel",
  "currency": "INR",
  "balance_paise": 50000,
  "initial_transaction_id": "4a7b9c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d",
  "created_at": "2026-11-17T01:00:00.000Z"
}
```

---

## Development & Testing

```bash
# Run unit & API integration tests
npm test

# Build TypeScript
npm run build

# Run API in watch mode
npm run dev

# Run BullMQ worker stub
npm run worker:dev
```
