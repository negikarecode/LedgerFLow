# LedgerFlow Deployment & Operations Guide

This guide details how to securely configure, run, and maintain LedgerFlow across **Local Development**, **Testing**, and **Hardened Production** environments.

---

## 1. Environment Architecture & Separation

LedgerFlow strictly separates configuration across environments:

| Aspect | Local Development (`development`) | Automated Testing (`test`) | Hardened Production (`production`) |
| :--- | :--- | :--- | :--- |
| **Ingress Container Target** | `Dockerfile (development)` | Host / Vitest runner | `Dockerfile (production)` |
| **Container User** | `node` (UID 1000) | Current user | `node` (UID 1000, non-root) |
| **API Code Execution** | Hot-reloading via `tsx` | Vitest ESM runner | Optimized compiled `node dist/api/server.js` |
| **Worker Execution** | Hot-reloading via `tsx` | Isolated test worker | Optimized compiled `node dist/worker/index.js` |
| **Database & Redis Ports** | Bound to `127.0.0.1` on host | Local test instances | **Unexposed to host network** (internal Docker network only) |
| **API Ingress Root (`/`)** | Interactive Chaos Simulator UI | N/A | Safe JSON service status |
| **Demo Endpoints (`/demo/*`)** | Enabled (gated by `DEMO_MODE`) | Enabled for test fixtures | **Strictly unmounted / HTTP 403 / 404** |
| **Mock Merchant (`/mock-merchant/*`)** | Enabled for interactive loop | Enabled for test webhooks | **Strictly unmounted / HTTP 403 / 404** |
| **SSRF Target Validation** | Private targets allowed if enabled | Configurable per test | **Private IPs strictly forbidden (unconditional)** |
| **Secret Verification** | Permissive fallback defaults | Permissive fallback defaults | **Fail-fast validation (32+ chars, no default placeholders)** |

---

## 2. Local Development & Demo Setup

### Option A: Local Docker Compose (Recommended for Local Demo)

The root [docker-compose.yml](file:///home/aryan/LedgerFlow/docker-compose.yml) starts the full development environment with hot-reloading:

```bash
# 1. Clone repository
git clone https://github.com/negikarecode/LedgerFLow.git
cd LedgerFLow

# 2. Copy development configuration
cp .env.example .env

# 3. Start local development stack
docker compose up -d --build

# 4. View logs
docker compose logs -f api worker
```

**Local Endpoints:**
- **Interactive Chaos Simulator UI:** [http://localhost:3000](http://localhost:3000)
- **Interactive Swagger OpenAPI Docs:** [http://localhost:3000/docs](http://localhost:3000/docs)
- **Grafana Live Observability Dashboard:** [http://localhost:3001](http://localhost:3001) (`admin` / `admin`)
- **Prometheus Raw Metrics:** [http://localhost:9090](http://localhost:9090)
- **API Health Check:** [http://localhost:3000/health](http://localhost:3000/health)

### Option B: Native Node.js Development

If PostgreSQL and Redis are running natively on your workstation:

```bash
# 1. Install dependencies
npm install

# 2. Run migrations
npm run migrate

# 3. Start API dev server in Terminal 1
npm run dev

# 4. Start asynchronous outbox worker in Terminal 2
npm run worker:dev
```

---

## 3. Production Hardening & Deployment

### 3.1 Security Invariants in Production

When `NODE_ENV=production`, LedgerFlow enforces the following safeguards:

1. **Fail-Fast Secret Validation:**
   - `ADMIN_TOKEN`: Must be provided, must be $\ge 32$ characters, and cannot match known insecure defaults (e.g. `default-admin-token-secret-99999`).
   - `WEBHOOK_SECRET`: Must be provided, must be $\ge 32$ characters, and cannot match known insecure defaults (e.g. `default-ledgerflow-secret-key-12345`).
   - `DATABASE_URL`: Must be provided and cannot use local development default credentials (`postgres:postgres@localhost`).
   - Missing or weak secrets halt the process at startup before accepting network connections.
2. **SSRF Lockdown:**
   - `ALLOW_PRIVATE_WEBHOOK_TARGETS`: Strictly prohibited. Startup fails if set to `true`.
   - The SSRF engine unconditionally blocks loopback (`127.0.0.0/8`), private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and cloud metadata IP ranges (`169.254.169.254`).
3. **Demo & Simulation Lockout:**
   - `DEMO_MODE`: Strictly prohibited. Startup fails if set to `true`.
   - `/demo/reset`, `/mock-merchant/crash`, `/mock-merchant/reset`, and `/mock-merchant/status` are completely unmounted and return `404 Not Found` or `403 Forbidden`.
   - Demo credentials (e.g. `DEFAULT_DEMO_MERCHANT_ID`) are never assumed in production.
4. **Secret Masking in Logs:**
   - Database and Redis connection passwords are redacted (`postgres://user:***@host:5432/db`) in all logs and error messages.
   - Internal 500 error stack traces and internal database errors are withheld from external API responses.
5. **Non-Root Execution:**
   - Production Docker containers run as unprivileged user `node` (UID 1000).
6. **Network & Port Isolation:**
   - Production database and Redis containers do **not** publish ports to the host network; communication is restricted to an isolated internal Docker bridge network.

### 3.2 Generating Production Secrets

Before deploying to production, generate cryptographically random secrets:

```bash
# Generate high-entropy 32-byte hex secrets (64 characters)
export ADMIN_TOKEN=$(openssl rand -hex 32)
export WEBHOOK_SECRET=$(openssl rand -hex 32)
export POSTGRES_PASSWORD=$(openssl rand -hex 24)
export METRICS_TOKEN=$(openssl rand -hex 24)
```

### 3.3 Option 1: Docker Compose Production Stack

Use [docker-compose.prod.yml](file:///home/aryan/LedgerFlow/docker-compose.prod.yml) for VPS or self-hosted deployment:

```bash
# 1. Create secure production .env
cat <<EOF > .env.production
NODE_ENV=production
PORT=3000
POSTGRES_USER=ledgerflow_admin
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=ledgerflow_prod
ADMIN_TOKEN=$(openssl rand -hex 32)
WEBHOOK_SECRET=$(openssl rand -hex 32)
METRICS_TOKEN=$(openssl rand -hex 24)
DEMO_MODE=false
ALLOW_PRIVATE_WEBHOOK_TARGETS=false
EOF

# 2. Launch production stack
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# 3. Verify health
docker compose -f docker-compose.prod.yml ps
curl -i http://localhost:3000/health/ready
```

### 3.4 Option 2: Fly.io Deployment

The repository includes a hardened [fly.toml](file:///home/aryan/LedgerFlow/fly.toml) configuring non-root production containers and readiness checks:

```bash
# 1. Launch app
fly launch --no-deploy

# 2. Provision managed Postgres & Redis
fly postgres create --name ledgerflow-db
fly postgres attach ledgerflow-db

fly redis create --name ledgerflow-cache

# 3. Set mandatory production secrets
fly secrets set \
  ADMIN_TOKEN=$(openssl rand -hex 32) \
  WEBHOOK_SECRET=$(openssl rand -hex 32) \
  METRICS_TOKEN=$(openssl rand -hex 24) \
  DEMO_MODE=false \
  ALLOW_PRIVATE_WEBHOOK_TARGETS=false

# 4. Deploy
fly deploy
```

### 3.5 Option 3: Render Blueprint (Infrastructure as Code)

The [render.yaml](file:///home/aryan/LedgerFlow/render.yaml) blueprint provisions:
- Managed PostgreSQL 16 with automatic connection string injection.
- Managed Redis instance.
- Web Service (`ledgerflow-api`) with automated zero-touch secret generation and `/health/ready` check.
- Background Outbox Worker (`ledgerflow-worker`) sharing secrets and database access.

---

## 4. Health Checks: Liveness vs. Readiness

LedgerFlow provides separated health endpoints:

### Liveness Probe (`GET /health/live` or `/livez`)
- **Purpose:** Verifies that the Node.js process is alive, running, and event loop responsive.
- **Dependency Checks:** **None**. Does not touch PostgreSQL or Redis.
- **Target Use:** Kubernetes / Nomad / ECS liveness probe (`livenessProbe.httpGet`). Prevents catastrophic container restart loops during transient database maintenance.

### Readiness Probe (`GET /health/ready` or `/readyz`)
- **Purpose:** Verifies whether the instance is ready to receive and process traffic.
- **PostgreSQL:** **Strictly required**. Returns `503 Service Unavailable` (`ready: false`) if unreachable.
- **Redis:** **Non-blocking accelerator**. If Redis is unreachable but PostgreSQL is healthy, returns `200 OK` (`status: "degraded"`, `ready: true`, `degraded: true`). Traffic continues to route to the instance via PostgreSQL durable fallback.
- **Target Use:** Load balancer health check, Kubernetes readiness probe (`readinessProbe.httpGet`), Fly.io / Render health check.

---

## 5. Production Pre-Flight Checklist

Before routing live production payments:

- [ ] `NODE_ENV=production` is set in the runtime environment.
- [ ] `ADMIN_TOKEN` is generated via `openssl rand -hex 32` and stored in a secret manager.
- [ ] `WEBHOOK_SECRET` is generated via `openssl rand -hex 32`.
- [ ] `DEMO_MODE=false` and `ALLOW_PRIVATE_WEBHOOK_TARGETS=false` are verified.
- [ ] PostgreSQL and Redis ports (5432, 6379) are blocked from public internet access.
- [ ] TLS termination is configured (HTTPS reverse proxy or cloud load balancer).
- [ ] Database connection pool (`DB_POOL_MAX`) is calibrated against PostgreSQL max connections.
- [ ] `/health/live` and `/health/ready` probes are registered with the container orchestrator.
- [ ] Run `npm run test` to verify all automated security and invariant test suites pass.
