# API Reference & Integration Guide

Interactive OpenAPI 3.0 documentation is available at `http://localhost:3000/docs`.

---

## Authentication

All merchant routes require an API key passed in the `Authorization` header:
```http
Authorization: Bearer lf_live_<key>
```

Administrative routes require the `ADMIN_TOKEN`:
```http
Authorization: Bearer <ADMIN_TOKEN>
```

Metrics (`GET /metrics`) optionally requires:
```http
Authorization: Bearer <METRICS_TOKEN>
```

---

## Endpoints Overview

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/admin/merchants` | Admin | Create merchant and generate initial API key |
| `POST` | `/admin/reconcile` | Admin | Trigger full balance reconciliation against ledger |
| `GET` | `/health` | Public | Service health and component latency check |
| `GET` | `/health/live` | Public | Liveness probe (verifies process is running) |
| `GET` | `/health/ready` | Public | Readiness probe (verifies PostgreSQL; handles Redis degraded mode) |
| `GET` | `/metrics` | Public / Token | Prometheus metrics text endpoint |
| `GET` | `/accounts` | Merchant | List accounts scoped to the authenticated tenant |
| `POST` | `/accounts` | Merchant | Create a new financial account with initial balance |
| `GET` | `/accounts/:id` | Merchant | Fetch account details and recent transactions |
| `GET` | `/accounts/:id/ledger` | Merchant | Retrieve verified balance and full ledger statement |
| `POST` | `/transfers` | Merchant | Atomic double-entry transfer with idempotency |
| `GET` | `/webhook-endpoints` | Merchant | List registered webhook endpoints |
| `POST` | `/webhook-endpoints` | Merchant | Register new webhook endpoint (SSRF validated) |
| `GET` | `/webhook-endpoints/:id` | Merchant | Get endpoint details, circuit breaker state & rate limits |
| `DELETE` | `/webhook-endpoints/:id` | Merchant | Deregister webhook endpoint |
| `POST` | `/webhook-endpoints/:id/rotate-secret` | Merchant | Rotate endpoint signing secret |
| `GET` | `/outbox` | Merchant | Query outbox events (supports status, endpoint, cursor) |
| `GET` | `/outbox/:id` | Merchant | Fetch outbox event with all delivery attempts |
| `POST` | `/outbox/:id/replay` | Merchant | Reset a dead-lettered or delivered event for re-delivery |
| `POST` | `/outbox/replay-batch` | Merchant | Batch replay all dead-lettered events for an endpoint |
| `GET` | `/mock-merchant/status` | Demo | View mock receiver status & captured payloads |
| `POST` | `/mock-merchant/crash` | Demo | Toggle mock receiver 500 error simulation |
| `POST` | `/mock-merchant/reset` | Demo | Truncate and reset demo balances (Alice & Bob) |
| `POST` | `/demo/reset` | Demo | Truncate outbox/ledger and re-seed demo accounts |

---

## Core Operations

### 1. Execute an Idempotent Transfer
```bash
curl -X POST http://localhost:3000/transfers \
  -H "Authorization: Bearer lf_live_YOUR_KEY" \
  -H "Idempotency-Key: 7b34e5a9-408a-40a1-9bb4-39f50eefc3d8" \
  -H "Content-Type: application/json" \
  -d '{
    "from_account_id": "0df81e7d-c20e-4361-b1e7-d655f462bbcb",
    "to_account_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    "amount_paise": 25000
  }'
```

**Response (`201 Created`):**
```json
{
  "transaction_id": "c928424a-2f46-4cb8-842d-2092dddf3607",
  "status": "COMPLETED",
  "from_account_id": "0df81e7d-c20e-4361-b1e7-d655f462bbcb",
  "to_account_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "amount_paise": 25000,
  "created_at": "2026-11-17T12:00:00.000Z"
}
```

*Subsequent identical requests with the same `Idempotency-Key` return the identical 201 response with `X-Idempotent-Replay: true` header without moving funds. See [docs/IDEMPOTENCY.md](file:///home/aryan/LedgerFlow/docs/IDEMPOTENCY.md) for full contract specifications.*

---

### Financial Amount Validation & Accounting Rules

All monetary values across LedgerFlow are strictly represented as **positive integer paise** (1 INR = 100 paise; ₹1.00 = 100 paise). Floating-point values, decimals, strings, negative numbers, zero, NaN, Infinity, and unsafe JavaScript integers are deterministically rejected.

#### Numeric Representation & Limits
- **Unit:** Integer Paise (`amount_paise`, `balance_paise`, `initial_credit_paise`).
- **Minimum Transfer Amount:** `1` paise (₹0.01). Amounts `<= 0` return `400 Bad Request`.
- **Maximum Safe Amount:** `9,007,199,254,740,991` paise (`Number.MAX_SAFE_INTEGER`, ₹90,071,992,547,409.91).
- **PostgreSQL Column Type:** `BIGINT` (64-bit integer, max $9.22 \times 10^{18}$) with DB check constraints `balance_paise <= 9007199254740991` and `amount <= 9007199254740991`.
- **Overflow Protection:** If a transfer would cause the recipient account balance to exceed `9,007,199,254,740,991` paise, the API returns `422 Unprocessable Entity` (`Transfer would exceed maximum supported account balance`) and rolls back all mutations atomically.
- **Double-Entry Zero-Sum Invariant:** Every transfer atomically inserts exactly one `DEBIT` and one `CREDIT` of equal value into immutable `ledger_entries`, guaranteeing $\sum \text{CREDIT} - \sum \text{DEBIT} = 0$.

#### Rejection Matrix
| Input | Example | HTTP Status | Response Error |
| :--- | :--- | :--- | :--- |
| Negative amount | `-100` | `400` | `Validation failed: amount_paise must be greater than 0` |
| Zero amount | `0` | `400` | `Validation failed: amount_paise must be greater than 0` |
| Floating point / decimal | `10.50`, `0.99` | `400` | `Validation failed: amount_paise must be an integer` |
| Ambiguous strings | `"1000"`, `"₹50"`, `"$10"` | `400` | `Validation failed: amount_paise must be a valid number` |
| Unsafe JavaScript integer | `9007199254740992`, `1e20` | `400` | `Validation failed: amount_paise must not exceed 9007199254740991` |
| Insufficient funds | `sender.balance < amount` | `422` | `Unprocessable Entity: Insufficient funds` |
| Recipient balance overflow | `receiver.balance + amount > MAX` | `422` | `Unprocessable Entity: Transfer would exceed maximum supported account balance` |

---

### 2. Register Webhook Endpoint
```bash
curl -X POST http://localhost:3000/webhook-endpoints \
  -H "Authorization: Bearer lf_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.partner.com/webhooks/ledger",
    "event_types": ["transfer.completed"],
    "status": "ACTIVE"
  }'
```

**Response (`201 Created`):**
```json
{
  "endpoint": {
    "id": "e8a93141-9497-40c2-9e91-8fa49de4a709",
    "merchant_id": "b1031c51-518d-4ad4-aa3b-825bbbbd828f",
    "url": "https://api.partner.com/webhooks/ledger",
    "secret": "whsec_34f89d81...",
    "event_types": ["transfer.completed"],
    "status": "ACTIVE",
    "created_at": "2026-11-17T12:00:00.000Z"
  }
}
```

---

### 3. Independent Balance Reconciliation & Audit
Trigger an authoritative, read-only verification of account balances and double-entry invariants inside snapshot isolation (`REPEATABLE READ READ ONLY`). See [docs/RECONCILIATION.md](file:///home/aryan/LedgerFlow/docs/RECONCILIATION.md) for full operator runbook.

```bash
curl -X POST http://localhost:3000/admin/reconcile \
  -H "Authorization: Bearer default-admin-token-secret-99999" \
  -H "Content-Type: application/json" \
  -d '{
    "merchant_id": "00000000-0000-0000-0000-000000000001",
    "account_id": "a1b2c3d4-0000-0000-0000-000000000001",
    "auto_repair": false
  }'
```

**Response (`200 OK`):**
```json
{
  "timestamp": "2026-11-18T12:05:00.000Z",
  "total_accounts_checked": 1,
  "total_transactions_checked": 25,
  "discrepancies_found": 0,
  "integrity_violations_found": 0,
  "discrepancies": [],
  "integrity_violations": [],
  "double_entry_net_discrepancy_paise": 0,
  "status": "HEALTHY"
}
```

---

## Error Codes Reference

| HTTP Code | Error Code | Description |
| :--- | :--- | :--- |
| `400` | `VALIDATION_FAILED` | Request schema violation (malformed UUID, negative/float/unsafe amount, missing required headers). |
| `401` | `UNAUTHORIZED` | Missing or invalid API key / admin token. |
| `403` | `DEMO_MODE_DISABLED` | Attempted to call `/demo/reset` or `/mock-merchant/*` when `DEMO_MODE=false`. |
| `404` | `NOT_FOUND` | Resource not found or owned by a different merchant. |
| `409` | `IDEMPOTENT_OPERATION_IN_PROGRESS` | Concurrent identical request currently executing. |
| `422` | `INSUFFICIENT_FUNDS` | Sender account has insufficient balance to complete debit. |
| `422` | `BALANCE_OVERFLOW` | Transfer would exceed maximum supported account balance (`9,007,199,254,740,991` paise). |
| `422` | `IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD` | Idempotency key reused with mismatched request parameters. |
| `422` | `SSRF_VALIDATION_FAILED` | Target URL resolved to a private, loopback, or metadata address. |
| `429` | `RATE_LIMITED` | Endpoint token bucket capacity exceeded. |
| `500` | `INTERNAL_SERVER_ERROR` | Unexpected database or internal system error. |
