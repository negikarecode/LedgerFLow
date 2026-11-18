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

### 2.1 Role-Based Access Control (RBAC) & Permissions
LedgerFlow enforces strict role separation between Platform Administrators and Tenant Merchants:

| Role | Credential Scheme | Allowed Endpoints | Prohibited Endpoints | Permissions & Scope |
| :--- | :--- | :--- | :--- | :--- |
| **Platform Administrator** | Bearer `<ADMIN_TOKEN>` (32+ chars) | `POST /admin/merchants`<br>`POST /admin/merchants/:id/keys`<br>`POST /admin/keys/:id/revoke`<br>`POST /admin/reconcile` | `/accounts/*`<br>`/transfers`<br>`/webhook-endpoints/*`<br>`/outbox/*` | Platform-level tenant onboarding, API key issuance/revocation, cluster reconciliation. Admin token is strictly rejected on merchant financial APIs. |
| **Tenant Merchant** | Bearer `lf_live_<token>` | `POST /accounts`<br>`GET /accounts`<br>`GET /accounts/:id`<br>`GET /accounts/:id/ledger`<br>`POST /transfers`<br>`/webhook-endpoints/*`<br>`/outbox/*` | `/admin/*` | Full read/write access to accounts, transfers, webhook endpoints, and outbox delivery logs **strictly scoped** to their own `merchant_id`. Access to `/admin/*` routes is rejected with 401 Unauthorized. |

### 2.2 API Key Lifecycle & Cryptographic Storage
1. **Key Generation:**
   - Generated with 256 bits of CSPRNG entropy: `crypto.randomBytes(32).toString('base64url')`.
   - Canonical format: `lf_live_<43 base64url characters>` (total 51 characters).
   - Indexed prefix: First 16 characters (`lf_live_xxxxxxxx`) used for indexed database lookup without exposing key material.
2. **Cryptographic Storage:**
   - **Zero Plaintext Storage:** Full API keys are never stored in the database, caches, or logs.
   - The PostgreSQL `api_keys` table stores only `key_prefix`, `key_hash` (`SHA-256(fullKey)`), `created_at`, `expires_at`, `revoked_at`, and `last_used_at`.
   - Full key is revealed **strictly once** upon creation in the admin response with a mandatory storage warning.
3. **Constant-Time Verification:**
   - Candidate keys are hashed with SHA-256 upon receipt.
   - Comparison against stored hashes in `auth.middleware.ts` uses constant-time string comparison (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.
4. **Key Revocation & Expiration:**
   - Keys can be revoked at any time via `POST /admin/keys/:id/revoke` (`revoked_at = NOW()`).
   - Keys support optional expiration (`expires_at`).
   - Both revoked and expired keys are rejected immediately with `401 Unauthorized`.
   - Malformed key formats (invalid prefix, incorrect length, invalid characters) are rejected before database querying.

### 2.3 Tenant Isolation Guarantees & Anti-Enumeration (404 Policy)
LedgerFlow enforces multi-tenant boundary isolation at the database query level across all resources:

1. **Mandatory Query Scoping:**
   - All queries on `accounts`, `transfers`, `outbox_events`, `delivery_attempts`, and `webhook_endpoints` enforce a mandatory `WHERE merchant_id = $1` clause bound to `req.merchant.id`.
   - Client-supplied `merchant_id` values in request bodies, query strings, or headers are **strictly ignored** and cannot override authenticated context.
2. **Anti-Enumeration via 404 Not Found:**
   - If a merchant attempts to query, view, or transfer to/from an account, outbox event, or webhook endpoint belonging to another tenant:
   - The system returns **HTTP 404 Not Found** (never HTTP 403 Forbidden).
   - This ensures foreign tenant resources are indistinguishable from non-existent UUIDs, preventing cross-tenant resource enumeration.
3. **Cross-Tenant Transfer Prevention (Theft Immunity):**
   - In `POST /transfers`, the row-level lock query enforces:
     ```sql
     SELECT id, merchant_id, balance_paise 
     FROM accounts 
     WHERE id IN ($1, $2) AND merchant_id = $3
     ORDER BY id FOR UPDATE;
     ```
   - Both `from_account_id` and `to_account_id` must match `merchant_id = $3`. If either account belongs to another merchant, `rows.length < 2` triggers an immediate rollback and returns `404 Not Found`. Zero funds move.
4. **Idempotency Key Tenant Namespacing:**
   - In PostgreSQL, the `idempotency_keys` table uses a composite primary key: `PRIMARY KEY (merchant_id, key)`.
   - In Redis, idempotency lock and cache keys are prefixed by tenant: `idemp:${merchantId}:${key}`.
   - Multiple merchants can use the exact same `Idempotency-Key` (e.g. `tx-001`) simultaneously without collisions, lock starvation, or cross-tenant cached replay leakage.
5. **Secret Masking:**
   - Webhook endpoint secrets are masked (`whsec_a1b2...c3d4`) on all listing and retrieval endpoints. Full secrets are revealed strictly once upon creation or rotation.

---

## 3. Server-Side Request Forgery (SSRF) Defense

Outbound webhook requests are routed through a dedicated security engine ([src/security/ssrf.ts](file:///home/aryan/LedgerFlow/src/security/ssrf.ts)) implementing multi-layered defense-in-depth across registration time, delivery time, DNS resolution, socket pinning, and network protocol boundaries.

### 3.1 Network Classification & Blocked CIDR Ranges
Every webhook destination URL and redirect target is parsed, stripped of brackets/zone IDs, normalized, and validated against an exhaustive CIDR and cloud metadata blocklist:

- **Private IPv4 (RFC 1918):** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- **Loopback & Current Network:** `127.0.0.0/8`, `0.0.0.0/8`
- **Cloud Metadata Services:**
  - Link-Local & IMDSv1/v2 (AWS, GCP, Azure, Oracle, DigitalOcean): `169.254.0.0/16` (including `169.254.169.254`)
  - Azure WireServer / Host GA: `168.63.129.16`
  - Alibaba Cloud ECS Metadata: `100.100.100.200` (within CGNAT `100.64.0.0/10`)
  - AWS IMDSv6 (IPv6): `fd00:ec2::254`
  - Metadata Hostnames: `metadata.google.internal`, `metadata`, `instance-data`, `metadata.tencentyun.com`
- **Carrier-Grade NAT (CGNAT, RFC 6598):** `100.64.0.0/10` (100.64.0.0 - 100.127.255.255)
- **Test Networks & Benchmarking:** TEST-NET-1 (`192.0.2.0/24`), TEST-NET-2 (`198.51.100.0/24`), TEST-NET-3 (`203.0.113.0/24`), Benchmark (`198.18.0.0/15`), IETF Protocol (`192.0.0.0/24`), 6to4 Anycast (`192.88.99.0/24`)
- **Multicast & Reserved:** `224.0.0.0/4`, `240.0.0.0/4`, Broadcast `255.255.255.255`
- **IPv6 Networks (128-bit word parsing):**
  - Loopback (`::1/128`, `0:0:0:0:0:0:0:1`, `0::1`, `[::1]`)
  - Unspecified (`::/128`, `0::0`, `::0`)
  - Unique Local Addresses ULA (`fc00::/7` covers `fc00` to `fdff`)
  - Link-Local Unicast (`fe80::/10`) with or without zone IDs (`fe80::1%eth0`)
  - Site-Local Unicast (`fec0::/10`, deprecated RFC 3879)
  - Multicast (`ff00::/8`)
  - Documentation (`2001:db8::/32`) and Benchmarking (`2001:2::/48`)
  - Discard Prefix (`100::/64`)
  - 6to4 Relay (`2002::/16`) and Teredo Tunneling (`2001:0000::/32`)
- **IPv4-Mapped & IPv4-Compatible IPv6:**
  - Dotted IPv4-mapped: `::ffff:127.0.0.1`, `::ffff:169.254.169.254`
  - Hexadecimal IPv4-mapped: `::ffff:7f00:1`, `::ffff:a9fe:a9fe` (extracts embedded IPv4 octets and evaluates against all IPv4 rules)
  - Deprecated IPv4-compatible: `::127.0.0.1`, `::7f00:1` (strictly blocked)
- **Unusual IP & Parser Representations:**
  - Single 32-bit integer decimal: `2130706433` (resolves to `127.0.0.1`)
  - Hexadecimal integers: `0x7f000001`
  - Octal representations: `0177.0.0.1`
  - Dotted shorthand: `127.1` (resolves to `127.0.0.1`), `0x7f.1`
  - Leading zeros: `127.000.000.001`

### 3.2 Port Whitelisting & Service Port Lockdown
To prevent port probing, cross-protocol exploitation, and lateral movement into internal services:
- **Restricted Sensitive Ports:** Disallows destinations targeting administrative, database, orchestration, and plain-text protocols:
  - System: `21` (FTP), `22` (SSH), `23` (Telnet), `25` (SMTP), `53` (DNS), `67/68` (DHCP), `69` (TFTP), `110` (POP3), `119` (NNTP), `123` (NTP), `135-139` (NetBIOS), `143` (IMAP), `161/162` (SNMP), `389/636` (LDAP), `445` (SMB)
  - Databases: `1433` (MSSQL), `1521` (Oracle), `3306` (MySQL), `5432` (PostgreSQL), `6379` (Redis), `11211` (Memcached), `27017` (MongoDB)
  - Infrastructure: `2375/2376` (Docker), `2379/2380` (etcd), `6443` (Kubernetes API), `8500` (Consul), `9090` (Prometheus), `9092` (Kafka), `9200/9300` (Elasticsearch), `10250/10255` (Kubelet)
  - Reserved: Port `0`, negative ports, or ports > 65535.
- **Production Port Whitelist:** In `production`, webhooks must target standard secure web ports: **443** (standard HTTPS) or **8443** (alternative HTTPS).

### 3.3 DNS Rebinding Defense & Socket Pinning
Standard HTTP clients resolve DNS at connection time, exposing applications to DNS rebinding attacks where an attacker's domain returns a public IP during registration, but changes TTL to 0 and resolves to `127.0.0.1` or `169.254.169.254` during dispatch.

LedgerFlow prevents DNS rebinding through deterministic IP pinning:
1. **Pre-dispatch DNS Resolution:** Immediately before establishing a TCP socket, `validateWebhookUrl` queries all DNS records (`dns.promises.lookup(host, { all: true })`).
2. **Comprehensive Validation:** Asserts that **every** resolved IP is safe and public. If even one IP is in a blocked range, the request is immediately rejected.
3. **Socket Pinning Callback:** Dispatches requests through a custom Node.js `Agent.lookup` callback that forces the socket connection exclusively to the pre-verified `pinnedIp`.
4. **TLS SNI & Hostname Integrity:** The `hostname` and `Host` header retain the original destination domain name (e.g. `merchant.example.com`). TLS Server Name Indication (SNI) and certificate validation (`checkServerIdentity`) verify the certificate against the intended domain name without breaking TLS.

### 3.4 Hop-by-Hop Redirect Validation
Standard HTTP client automatic redirect following is disabled. Instead:
- Redirects (HTTP 301, 302, 303, 307, 308) are intercepted manually.
- The active socket is destroyed immediately before following a redirect, preventing large redirect response bodies from streaming.
- Redirect chains are bounded by `maxRedirects = 3`.
- **Protocol Downgrade Prevention:** Redirects from HTTPS to HTTP are strictly blocked.
- Every redirect destination URL undergoes full URL parsing, port validation, DNS re-resolution, and IP range classification.

### 3.5 Timeouts, Memory Caps, & Proxy Isolation
- **Socket Connect Timeout:** Hard 3,000 ms timeout for TCP/TLS connection establishment.
- **Read Inactivity Timeout:** 5,000 ms inactivity timeout on socket reads.
- **Total Request Deadline:** Dedicated timer enforcing `timeoutMs` (5,000 - 10,000 ms). On expiry, the underlying socket is immediately destroyed.
- **Response Buffer Cap:**
  - Upfront `Content-Length` header check: responses declaring > 64 KB are rejected immediately without buffering.
  - Streaming chunk byte counter: aborts and destroys the socket if received chunks exceed 64 KB.
- **Proxy Isolation:** Direct socket instantiation with custom pinned-IP agents prevents ambient `HTTP_PROXY` or `HTTPS_PROXY` environment variables from routing traffic through uninspected internal proxies.

### 3.6 Security Boundaries & Residual Risks
- **In-Scope Protection:** LedgerFlow completely isolates all private networks (RFC 1918), loopback, link-local, cloud metadata services, container orchestration ports, and internal services from being accessed via webhook registration or delivery.
- **Residual Risks:**
  1. *Public Open Proxies:* If a merchant configures a public third-party URL that itself acts as an unauthenticated open proxy or web relay, that external proxy's behavior is outside LedgerFlow's network perimeter.
  2. *Intra-Public IP Rebinding:* If an attacker domain rebinds between two distinct public IP addresses owned by the merchant, both addresses pass SSRF checks as they are public IPs.
  3. *Merchant Endpoint Compromise:* LedgerFlow signs payloads using HMAC-SHA256 (`X-LedgerFlow-Signature`) with unique secrets per endpoint. If a merchant's external server is compromised, attacker impact is restricted to that merchant's received payloads; cross-tenant data access is blocked by database-level merchant isolation.

---

## 4. Webhook Signatures, Verification & Replay Protection

LedgerFlow signs every outbound HTTP webhook notification to guarantee authenticity, integrity, and non-repudiation. Dispatched webhooks follow Stripe-compatible signature conventions with enhanced delivery-level deduplication identifiers.

### 4.1 Canonical Message Specification
The signed message is constructed deterministically:
```
canonical_message = "${timestamp}.${raw_payload}"
```
- `${timestamp}`: Integer Unix epoch timestamp in seconds (e.g. `1710000000`).
- `.`: ASCII period delimiter (`0x2E`).
- `${raw_payload}`: Exact UTF-8 encoded HTTP request body string as transmitted over the wire.

HMAC algorithm: `HMAC-SHA256` producing a 64-character lowercase hexadecimal digest.

### 4.2 Signature Header Format
Webhooks include an `X-LedgerFlow-Signature` HTTP header:
```http
X-LedgerFlow-Signature: t=1710000000,v1=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```
During zero-downtime key rotation, LedgerFlow supports dual-signing by attaching multiple `v1=` signature digests:
```http
X-LedgerFlow-Signature: t=1710000000,v1=<new_secret_sig>,v1=<old_secret_sig>
```

### 4.3 Headers & Event Identity Taxonomy
Every webhook transmission includes three complementary identity headers:

| Header | Description | Mutability Across Retries |
| :--- | :--- | :--- |
| `X-LedgerFlow-Event-Id` | Unique UUID of the underlying domain event (e.g. `transfer.completed`). Also embedded in body as `event_id`. | **Stable & Immutable:** Identical across all retries and manual replays. Used by receivers for business idempotency. |
| `X-LedgerFlow-Delivery-Id` | Unique UUIDv4 of this specific transmission attempt. Also embedded in body as `delivery_id`. | **Unique Per Attempt:** Regenerated on every retry. Used for network transmission deduplication and replay attack prevention. |
| `X-LedgerFlow-Signature` | Header containing the Unix timestamp `t` and HMAC digest `v1`. | **Fresh Per Attempt:** Recomputed with a fresh timestamp on every retry to ensure timestamp freshness. |

### 4.4 Retry Semantics & Timestamp Freshness Policy
When a receiver responds with an error (e.g. HTTP 500, timeout, network disconnect), LedgerFlow schedules retries with exponential backoff:
1. **Event Identity Invariant:** `event_id` is never changed. Receivers use `event_id` to ensure business logic (such as crediting an internal ledger) executes strictly once.
2. **Fresh Delivery Identifier:** Each retry receives a new UUID `delivery_id` (`X-LedgerFlow-Delivery-Id` and `payload.delivery_id`).
3. **Fresh Timestamp & Signature:** The timestamp `t` is generated at dispatch time for that retry, and a new signature is computed.
   - *Why this is essential:* If retries reused the initial attempt's timestamp, subsequent retries delayed by exponential backoff (e.g. 5 to 30 minutes later) would be rejected as stale by the receiver's tolerance window. Fresh timestamps guarantee that legitimate retries pass freshness checks while remaining cryptographically bound to the unique `delivery_id`.

### 4.5 Two-Tier Receiver Replay Defense
Receivers must implement two layers of defense to prevent replay attacks:

1. **Tier 1: Timestamp Freshness Window (300s Tolerance):**
   - Stale threshold: Reject requests where `current_time - t > 300` (older than 5 minutes). Defeats delayed replay of intercepted packets.
   - Future clock skew threshold: Reject requests where `t - current_time > 60` (more than 60 seconds into the future). Prevents forward-dated replays.
2. **Tier 2: Delivery ID Deduplication Cache:**
   - Even within the 5-minute freshness window, an attacker could replay an exact intercepted packet.
   - The receiver must record seen `delivery_id` values in a fast cache (e.g. Redis) with a TTL of 300 seconds:
     ```redis
     SET "seen_delivery:${deliveryId}" "1" EX 300 NX
     ```
   - If `SETNX` returns 0 (key already exists), the request is a duplicate transmission and must be rejected with HTTP 409 Conflict or ignored.

### 4.6 Receiver Verification Example (Node.js / Express)

```typescript
import crypto from 'crypto';
import express, { Request, Response } from 'express';

const app = express();

// IMPORTANT: Express must capture raw body buffer for HMAC verification
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// In-memory or Redis delivery deduplication store (TTL: 300s)
const processedDeliveries = new Set<string>();

export function verifyLedgerFlowWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string | string[],
  toleranceSeconds = 300
): { valid: boolean; reason?: string; event?: any } {
  if (!signatureHeader) {
    return { valid: false, reason: 'Missing X-LedgerFlow-Signature header' };
  }

  // 1. Parse header components: t=<ts>, v1=<sig>
  const parts = signatureHeader.split(',');
  let timestampStr: string | null = null;
  const candidateSignatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.trim().split('=');
    if (key === 't') timestampStr = value;
    else if (key === 'v1' && value) candidateSignatures.push(value);
  }

  if (!timestampStr || candidateSignatures.length === 0) {
    return { valid: false, reason: 'Malformed signature header format' };
  }

  const timestamp = parseInt(timestampStr, 10);
  const now = Math.floor(Date.now() / 1000);

  // 2. Reject stale timestamps (>300s) and excessively future timestamps (>60s)
  if (now - timestamp > toleranceSeconds) {
    return { valid: false, reason: 'Signature timestamp outside tolerance window' };
  }
  if (timestamp - now > 60) {
    return { valid: false, reason: 'Signature timestamp is in the future' };
  }

  // 3. Compute expected HMAC-SHA256 over canonical message format: `${t}.${rawBody}`
  const canonicalMessage = `${timestamp}.${rawBody}`;
  const secrets = Array.isArray(secret) ? secret : [secret];
  let matched = false;

  for (const candidateSecret of secrets) {
    const expectedHmacHex = crypto
      .createHmac('sha256', candidateSecret)
      .update(canonicalMessage)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedHmacHex, 'hex');

    for (const candSig of candidateSignatures) {
      if (!/^[0-9a-fA-F]{64}$/.test(candSig)) continue;
      const receivedBuf = Buffer.from(candSig, 'hex');

      // 4. Constant-time comparison
      if (expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
        matched = true;
        break;
      }
    }
    if (matched) break;
  }

  if (!matched) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  const event = JSON.parse(rawBody);
  return { valid: true, event };
}

// Webhook endpoint receiver handler
app.post('/webhook', (req: any, res: Response) => {
  const signature = req.headers['x-ledgerflow-signature'] as string;
  const rawBody = req.rawBody;
  const WEBHOOK_SECRET = process.env.LEDGERFLOW_WEBHOOK_SECRET!;

  // 1. Verify cryptographic signature
  const verification = verifyLedgerFlowWebhook(rawBody, signature, WEBHOOK_SECRET);
  if (!verification.valid) {
    return res.status(401).json({ error: 'Unauthorized', reason: verification.reason });
  }

  const event = verification.event;
  const deliveryId = event.delivery_id;
  const eventId = event.event_id;

  // 2. Prevent replay attacks using delivery_id
  if (processedDeliveries.has(deliveryId)) {
    return res.status(409).json({ error: 'Conflict', message: 'Duplicate delivery_id (replay detected)' });
  }
  processedDeliveries.add(deliveryId);

  // 3. Prevent duplicate business logic execution using event_id
  console.log(`Processing event ${eventId} (delivery ${deliveryId}):`, event);

  res.status(200).json({ received: true });
});
```

### 4.7 Zero-Downtime Secret Rotation Protocol
When an endpoint secret is rotated via `POST /webhook-endpoints/:id/rotate-secret`:
1. The old secret remains active during a migration grace period.
2. Receivers pass `[newSecret, oldSecret]` into `verifyLedgerFlowWebhook`.
3. If dual-signing is enabled, LedgerFlow signs with both secrets (`v1=<newSig>,v1=<oldSig>`).
4. Once the receiver has confirmed receipt under the new secret, the old secret is permanently decommissioned.


---

## 5. Production Hardening & Feature Gating

| Feature | Environment Variable | Default | Production Recommendation |
| :--- | :--- | :--- | :--- |
| **Demo & Simulation Routes** | `DEMO_MODE` | `false` | Keep `false`. Gates destructive `/demo/reset` and mock-merchant simulation routes with 403 Forbidden. |
| **Metrics Protection** | `METRICS_TOKEN` | *Empty* | Set a secret token. Requires `Authorization: Bearer <token>` on `GET /metrics`. |
| **Grafana Anonymous Access** | `GRAFANA_AUTH_ANONYMOUS_ENABLED` | `false` | Keep `false`. Requires authenticated user login on Grafana port 3001. |
| **Private IP Webhook Dispatch** | `ALLOW_PRIVATE_WEBHOOK_TARGETS` | `false` | Set to `false` in production. Only permits public HTTPS URLs. |
| **API Rate Limiting** | `RATE_LIMIT_ENABLED` | `true` | Keep `true`. Enforces dual-engine sliding-window rate limits across public, tenant, auth, and expensive tiers. |
| **Global IP Rate Limit** | `RATE_LIMIT_GLOBAL_MAX` | `300` | Requests/min per client IP on public and pre-auth endpoints. |
| **Tenant API Rate Limit** | `RATE_LIMIT_TENANT_MAX` | `1200` | Requests/min per authenticated merchant ID on transactional endpoints. |
| **Expensive Operation Limit** | `RATE_LIMIT_EXPENSIVE_MAX` | `60` | Requests/min per tenant/IP on computationally or I/O intensive routes. |
| **Auth Failure Threshold** | `RATE_LIMIT_AUTH_FAIL_MAX` | `20` | Failed attempts/min per IP before blocking with HTTP 429. |
| **Request Body Size Limit** | `BODY_SIZE_LIMIT` | `256kb` | Maximum allowed request payload size. Rejected early with HTTP 413. |
| **Request Processing Timeout** | `REQUEST_TIMEOUT_MS` | `15000` | Server-side request deadline (15s). Terminated with HTTP 504. |
| **Reverse Proxy Trust** | `TRUST_PROXY` | `false` | Set to `true` or subnet behind verified proxies (e.g. Cloudflare, Fly.io). When `false`, `X-Forwarded-For` is ignored. |

---

## 6. Rate Limiting, DoS Defense & Resource Exhaustion Protection

LedgerFlow implements a defense-in-depth traffic protection architecture designed to safeguard against brute-force attacks, multi-tenant resource starvation, memory exhaustion, and slow-client DoS attacks.

### 6.1 Dual-Engine Sliding Window Architecture
LedgerFlow utilizes a high-precision sliding-window algorithm rather than simple fixed counters or leaky buckets:
1. **Primary Redis Engine (Atomic Sorted Sets):**
   - Each rate limit window is represented as a Redis sorted set (`ZSET`) keyed by tier and identifier.
   - Evaluated atomically via Lua script:
     ```lua
     local key = KEYS[1]
     local now = tonumber(ARGV[1])
     local window = tonumber(ARGV[2])
     local limit = tonumber(ARGV[3])
     local clearBefore = now - window

     redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
     local currentRequests = redis.call('ZCARD', key)

     if currentRequests < limit then
       redis.call('ZADD', key, now, now .. ':' .. math.random(100000, 999999))
       redis.call('EXPIRE', key, math.ceil(window / 1000) * 2)
       return { 1, limit - currentRequests - 1, 0 }
     else
       local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
       local resetMs = window
       if oldest and #oldest >= 2 then
         resetMs = math.max(0, math.ceil(tonumber(oldest[2]) + window - now))
       end
       return { 0, 0, resetMs }
     end
     ```
   - Microsecond accuracy eliminates window-edge burst doubling (common in fixed-window limiters).
2. **In-Memory Fallback Engine (`InMemorySlidingWindowLimiter`):**
   - If Redis is unavailable, disconnected, or times out (>500ms), `consumeRateLimit` immediately falls back to an in-memory sliding window limiter.
   - Includes an automatic background garbage collection timer running every 60 seconds to prune stale window timestamps, preventing memory leaks during sustained failover.
   - Fallback transitions increment the Prometheus metric `rateLimitFallbackTotal`.

### 6.2 Multi-Tier Protection Boundaries

| Tier | Middleware | Key Scheme | Default Limit | Target Endpoints | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Global / Public** | `publicRateLimiter` | `ratelimit:public:ip:<clientIp>` | 300 req / min | All public routes (`/`, `/docs`, demo routes) | Prevents unauthenticated traffic flooding. Automatically skips `/health/*`, `/livez`, `/readyz`, and `/metrics`. |
| **Tenant Financial** | `tenantRateLimiter` | `ratelimit:tenant:tenant:<merchantId>` | 1,200 req / min | `/accounts/*`, `/transfers`, `/outbox/*`, `/webhook-endpoints/*` | Protects core banking endpoints with high burst capacity while guaranteeing multi-tenant isolation. |
| **Expensive Ops** | `expensiveRateLimiter` | `ratelimit:expensive:<id>:<path>` | 60 req / min | `POST /admin/reconcile`<br>`POST /outbox/replay-batch`<br>`POST /webhook-endpoints`<br>`POST .../rotate-secret` | Throttles compute-intensive reconciliation scans, bulk outbox replays, and SSRF/DNS-resolving webhook creations. |
| **Auth Brute-Force** | `authFailureTracker` | `ratelimit:auth_fail:<clientIp>` | 20 failures / min | `requireApiKey`<br>`requireAdminToken` | Detects repeated invalid API key or admin token attempts per IP and blocks subsequent requests with HTTP 429 before database lookups. |

### 6.3 RFC RateLimit Headers & Error Responses
All rate-limited responses attach standard HTTP headers:
- `X-RateLimit-Limit`: Total permitted request quota within the window.
- `X-RateLimit-Remaining`: Remaining request quota in the current window.
- `X-RateLimit-Reset`: Unix epoch timestamp (seconds) when quota refreshes.
- `Retry-After`: Integer seconds until the client is permitted to retry (on HTTP 429).

When rate limits are exceeded, the API responds with **HTTP 429 Too Many Requests**:
```json
{
  "error": "Too Many Requests",
  "message": "Tenant API rate limit exceeded. Please retry after 12 seconds.",
  "retry_after_seconds": 12
}
```

### 6.4 Early Payload Size Guard & Body Limits (HTTP 413)
To prevent memory exhaustion, Slowloris body streaming attacks, and parser DoS:
1. **Early Content-Length Inspection (`earlyPayloadSizeGuard`):**
   - Intercepts incoming requests before body streaming or JSON parsing occurs.
   - If `Content-Length > 262,144` bytes (256 KB), immediately returns **HTTP 413 Payload Too Large** without allocating memory:
     ```json
     {
       "error": "Payload Too Large",
       "message": "Request payload exceeded maximum size limit of 256KB"
     }
     ```
2. **Streaming Parser Body Limit:**
   - `express.json({ limit: env.BODY_SIZE_LIMIT || '256kb' })` and `express.urlencoded(...)` enforce body limits on chunked transfer requests where `Content-Length` is absent or falsified.
   - The central `errorHandler` catches `status: 413` and `entity.too.large` errors, returning standard 413 JSON responses.

### 6.5 Server-Side Request Timeout Deadline (HTTP 504)
To prevent slow-request resource exhaustion and hung database/socket connections:
- `requestTimeoutGuard(env.REQUEST_TIMEOUT_MS || 15000)`: Mounts a strict 15-second deadline on all incoming HTTP requests.
- If request processing does not complete within `REQUEST_TIMEOUT_MS`, the middleware responds with **HTTP 504 Gateway Timeout**:
  ```json
  {
    "error": "Gateway Timeout",
    "message": "Request processing exceeded timeout deadline of 15000ms"
  }
  ```
- Logs a structured warning event `{ event: 'request_timeout', method, url, timeoutMs }` for operator observability.

### 6.6 Proxy Trust & IP Spoofing Defense
IP-based rate limiters are vulnerable to spoofing if an attacker provides random `X-Forwarded-For` headers.
- **Strict Untrusted Default:** When `TRUST_PROXY=false` (the default), `getClientIp(req)` strictly uses the raw TCP socket remote address (`req.socket.remoteAddress`), completely ignoring `X-Forwarded-For`, `X-Real-IP`, and `Client-IP`.
- **Verified Proxy Mode:** In production environments behind trusted reverse proxies or load balancers (e.g. AWS ALB, Cloudflare, Fly.io), operators configure `TRUST_PROXY=true` (or specific subnet/hop counts). Express then securely parses `X-Forwarded-For` according to proxy trust boundaries.

### 6.7 Degraded Mode Fallback & Operational Tradeoffs
- **Fail-Safe Invariant:** Protective rate limits are **never disabled** when Redis is unavailable. The system fails safe, not open.
- **Operational Tradeoffs:**
  - *Local Memory Enforcement:* During a Redis outage, rate limit windows are enforced in local process memory (`InMemorySlidingWindowLimiter`).
  - *Cluster Coordination:* In a multi-replica deployment during a Redis failure, limits are enforced per-instance rather than globally. While this allows higher cumulative throughput across multiple nodes during failover, each individual node remains strictly protected against resource exhaustion and crash loops.
  - *Observability:* Operators are alerted to fallback operations via the `rateLimitFallbackTotal` counter and Redis connection health metrics.

