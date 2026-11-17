# Security Architecture & Threat Model

This document outlines the security architecture, threat model, authentication mechanisms, and network defenses implemented in LedgerFlow.

---

## 1. Threat Model & Boundaries

LedgerFlow processes financial transactions and dispatches asynchronous HTTP webhooks to partner systems. The core threat model addresses four threat vectors:

1. **Cross-Tenant Data Access & Enumeration:** Unauthorized access, enumeration, or balance manipulation across merchants.
2. **Server-Side Request Forgery (SSRF):** Exploitation of webhook dispatching to target internal infrastructure, localhost ports, or cloud instance metadata services (AWS/GCP/Azure).
3. **Webhook Replay & Payload Tampering:** Interception and replaying of signed webhook notifications.
4. **Timing Attacks & Credential Leakage:** Side-channel extraction of API keys or administrative secrets via response latency analysis.

---

## 2. Multi-Tenant Authentication & Access Control

### API Key Format and Hashing
- **Format:** `lf_live_<32 bytes base64url>` (e.g., `lf_live_k9F3...`).
- **Storage:** API keys are never stored in plaintext. The system stores a SHA-256 hash (`key_hash`) along with a short 8-character prefix (`key_prefix`) used for indexed database lookup.
- **Exposure:** The full key is revealed **strictly once** upon creation.
- **Timing Safe Verification:** Key validation in `requireApiKey` uses constant-time string comparison (`crypto.timingSafeEqual`) to prevent timing side channels.

### Resource Isolation & 404 Anti-Enumeration
All database queries on `accounts`, `ledger_entries`, `outbox_events`, `delivery_attempts`, and `webhook_endpoints` include a mandatory `WHERE merchant_id = $1` clause.

If a merchant attempts to query, view, or transfer to/from an account belonging to another tenant:
- The system returns **HTTP 404 Not Found** (never HTTP 403 Forbidden).
- This prevents attackers from enumerating valid account UUIDs across the multi-tenant database.

### Admin Bootstrap
Tenant registration and initial API key creation are isolated to `POST /admin/merchants`, authenticated using an `ADMIN_TOKEN` secret via Bearer authentication:
```bash
curl -X POST http://localhost:3000/admin/merchants \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme Payments"}'
```

---

## 3. Server-Side Request Forgery (SSRF) Defense

Outbound webhook requests are routed through a dedicated security engine ([src/security/ssrf.ts](file:///home/aryan/LedgerFlow/src/security/ssrf.ts)) implementing defense-in-depth:

### CIDR IP Filtering
Every webhook target URL hostname is resolved and checked against blocked CIDR ranges:
- **Private IPv4:** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`
- **Carrier-Grade NAT (CGNAT):** `100.64.0.0/10`
- **Cloud Metadata Services:** `169.254.169.254` (AWS, Google Cloud, Azure, Oracle Cloud metadata)
- **IPv6:** `::1/128` (loopback), `fc00::/7` (Unique Local Addresses), `fe80::/10` (link-local)

### DNS Rebinding Defense & IP Pinning
Standard HTTP clients resolve DNS at connection time, exposing the application to DNS rebinding attacks (where a DNS entry resolves to a benign public IP at registration, but switches to `127.0.0.1` or `169.254.169.254` during webhook dispatch).

LedgerFlow prevents this by:
1. Resolving DNS records before dispatch and validating each IP against blocked CIDRs.
2. Pinning the HTTP connection socket directly to the validated IP using a custom `lookup` callback on Node.js `http.Agent` / `https.Agent`.
3. Setting the `Host` header to the original domain name for TLS SNI and virtual host resolution.

### Hop-by-Hop Redirect Validation
Standard HTTP client redirect following is disabled. Instead, redirects (HTTP 301, 302, 307, 308) are followed manually up to 3 hops. Each redirect target undergoes full DNS re-resolution, protocol validation, and CIDR filtering before a connection is opened.

### Memory & Connection Limits
- **Socket Timeout:** Hard 5,000 ms timeout on every outbound HTTP request.
- **Response Buffer Cap:** Incoming response streams are capped at 64 KB to protect against memory exhaustion from oversized partner responses.

---

## 4. Webhook Signatures & Replay Protection

### Signature Construction
Every dispatched webhook includes an `X-LedgerFlow-Signature` header structured like Stripe webhooks:
```http
X-LedgerFlow-Signature: t=1731850000,v1=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```
- `t`: Unix timestamp in seconds when the signature was generated.
- `v1`: Hex-encoded `HMAC-SHA256(endpoint_secret, "${t}.${raw_payload}")`.

### Verification Protocol for Receivers
Partner receivers should verify signatures using:
1. Extract `t` and `v1` from the header.
2. Verify timestamp freshness: `Math.abs(Date.now() / 1000 - t) <= 300` (reject requests older than 5 minutes to defeat replay attacks).
3. Compute `expected = HMAC-SHA256(secret, "${t}.${raw_body}")`.
4. Compare `expected` and `v1` using constant-time equality (`crypto.timingSafeEqual`).

---

## 5. Production Hardening & Feature Gating

| Feature | Environment Variable | Default | Production Recommendation |
| :--- | :--- | :--- | :--- |
| **Demo & Simulation Routes** | `DEMO_MODE` | `false` | Keep `false`. Gates destructive `/demo/reset` and mock-merchant simulation routes with 403 Forbidden. |
| **Metrics Protection** | `METRICS_TOKEN` | *Empty* | Set a secret token. Requires `Authorization: Bearer <token>` on `GET /metrics`. |
| **Grafana Anonymous Access** | `GRAFANA_AUTH_ANONYMOUS_ENABLED` | `false` | Keep `false`. Requires authenticated user login on Grafana port 3001. |
| **Private IP Webhook Dispatch** | `ALLOW_PRIVATE_WEBHOOK_TARGETS` | `false` | Set to `false` in production. Only permits public HTTPS URLs. |
