# Production Deployment Guide

LedgerFlow is designed to run as containerized microservices: an Express API web server, an asynchronous BullMQ worker process, PostgreSQL 16, and Redis 7.

---

## 1. Quick Deploy Options

### Option A: Render Blueprint (Infrastructure as Code)
The repository includes a `render.yaml` specification that provisions:
- Managed PostgreSQL 16
- Managed Redis
- Web Service (`ledgerflow-api`) running `npm run start`
- Background Worker (`ledgerflow-worker`) running `npm run worker`

1. Fork or push this repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com/), click **New** $\to$ **Blueprint**.
3. Select your repository. Render automatically reads `render.yaml`, provisions the databases, configures environment variables, and launches both services.

### Option B: Docker Compose (Production or Self-Hosted VPS)
To run on a dedicated Linux VPS (Ubuntu, Debian, etc.):

```bash
# Clone the repository
git clone https://github.com/negikarecode/LedgerFLow.git
cd LedgerFLow

# Configure production environment
cp .env.example .env
# Edit .env with strong secrets:
# ADMIN_TOKEN=$(openssl rand -hex 32)
# WEBHOOK_SECRET=$(openssl rand -hex 32)
# DEMO_MODE=false
# ALLOW_PRIVATE_WEBHOOK_TARGETS=false
# GRAFANA_AUTH_ANONYMOUS_ENABLED=false

# Launch production stack in background
docker compose up -d --build
```

### Option C: Fly.io
The repository includes a `fly.toml` configuration:
```bash
# Launch app and provision Postgres & Redis
fly launch
fly postgres create
fly redis create
fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32) WEBHOOK_SECRET=$(openssl rand -hex 32)
fly deploy
```

---

## 2. Production Checklist & Hardening

Before routing real traffic, ensure these settings are verified:

1. **`DEMO_MODE=false`:**
   - Disables destructive `/demo/reset`, `/mock-merchant/reset`, and mock crash controls with HTTP 403 Forbidden.
2. **`ALLOW_PRIVATE_WEBHOOK_TARGETS=false`:**
   - Enforces HTTPS and blocks SSRF attempts against private/internal/cloud-metadata IP ranges.
3. **`METRICS_TOKEN`:**
   - Set a secret token to require `Authorization: Bearer <token>` on `GET /metrics`.
4. **Grafana Authentication:**
   - Ensure `GRAFANA_AUTH_ANONYMOUS_ENABLED=false` so the dashboard requires user authentication.
5. **Database Connection Pool:**
   - Configure `DB_POOL_MAX` to match your database server's max connection capacity (default `60`).
