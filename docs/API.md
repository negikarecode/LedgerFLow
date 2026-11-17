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

*Subsequent identical requests with the same `Idempotency-Key` return the identical 201 response with `X-Idempotent-Replay: true` header without moving funds.*

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

## Error Codes Reference

| HTTP Code | Error Code | Description |
| :--- | :--- | :--- |
| `401` | `UNAUTHORIZED` | Missing or invalid API key / admin token. |
| `403` | `DEMO_MODE_DISABLED` | Attempted to call `/demo/reset` or `/mock-merchant/*` when `DEMO_MODE=false`. |
| `404` | `NOT_FOUND` | Resource not found or owned by a different merchant. |
| `409` | `IDEMPOTENT_OPERATION_IN_PROGRESS` | Concurrent identical request currently executing. |
| `422` | `INSUFFICIENT_FUNDS` | Sender account has insufficient balance to complete debit. |
| `422` | `IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD` | Idempotency key reused with mismatched request parameters. |
| `422` | `SSRF_VALIDATION_FAILED` | Target URL resolved to a private, loopback, or metadata address. |
| `429` | `RATE_LIMITED` | Endpoint token bucket capacity exceeded. |
| `500` | `INTERNAL_SERVER_ERROR` | Unexpected database or internal system error. |
