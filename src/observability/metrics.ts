import { Registry, Histogram, Counter, Gauge, collectDefaultMetrics } from 'prom-client';
import { Request, Response, NextFunction } from 'express';
import { pool, query } from '../db/pool';
import { circuitBreaker } from '../worker/circuit-breaker';

export const metricsRegistry = new Registry();

// Collect Node.js process / runtime metrics
collectDefaultMetrics({
  register: metricsRegistry,
  prefix: 'ledgerflow_',
});

/**
 * 1. HTTP Request Duration Histogram
 */
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds partitioned by method, route, and status code',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * 2. Transfers Total by Outcome
 */
export const transfersTotal = new Counter({
  name: 'transfers_total',
  help: 'Total number of transfers processed by outcome',
  labelNames: ['outcome'],
  registers: [metricsRegistry],
});

/**
 * 3. Idempotency Replays Counter
 */
export const idempotencyReplaysTotal = new Counter({
  name: 'idempotency_replays_total',
  help: 'Total number of idempotent replays served without executing new transfers',
  registers: [metricsRegistry],
});

/**
 * 4. Outbox Queue Depth Gauge
 */
export const outboxQueueDepth = new Gauge({
  name: 'outbox_queue_depth',
  help: 'Current number of transactional outbox events by status',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

/**
 * 5. Webhook Delivery Duration Histogram
 */
export const webhookDeliveryDurationSeconds = new Histogram({
  name: 'webhook_delivery_duration_seconds',
  help: 'Duration of outbound webhook dispatches in seconds',
  labelNames: ['status_code', 'endpoint_id'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

/**
 * 6. Webhook Deliveries Total by Result
 */
export const webhookDeliveriesTotal = new Counter({
  name: 'webhook_deliveries_total',
  help: 'Total webhook delivery attempts by result',
  labelNames: ['result', 'endpoint_id'],
  registers: [metricsRegistry],
});

/**
 * 7. Circuit Breaker State Gauge (0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN)
 */
export const circuitBreakerStateGauge = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state per endpoint (0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN)',
  labelNames: ['endpoint_id'],
  registers: [metricsRegistry],
});

/**
 * 8. PostgreSQL Database Pool Usage Gauge
 */
export const dbPoolConnections = new Gauge({
  name: 'db_pool_connections',
  help: 'PostgreSQL client connection pool usage',
  labelNames: ['state'],
  registers: [metricsRegistry],
});

/**
 * 9. Double-Entry Ledger Conservation Invariant Discrepancy Gauge
 * Must strictly equal 0 paise at all times.
 */
export const ledgerConservationDiscrepancyPaise = new Gauge({
  name: 'ledger_conservation_discrepancy_paise',
  help: 'Double-entry ledger balance conservation discrepancy in paise (0 = verified healthy)',
  registers: [metricsRegistry],
});

/**
 * Normalizes HTTP route paths to prevent high-cardinality metrics explosion from UUIDs.
 */
export function normalizeRoute(path: string): string {
  // Replace UUIDv4 with :id
  let normalized = path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id'
  );

  // Strip query parameters
  const queryIndex = normalized.indexOf('?');
  if (queryIndex !== -1) {
    normalized = normalized.slice(0, queryIndex);
  }

  // Remove trailing slashes
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized || '/';
}

/**
 * Express middleware to record HTTP duration histogram.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime();

  res.on('finish', () => {
    // Avoid scraping metrics on the /metrics path itself
    if (req.path === '/metrics') return;

    const diff = process.hrtime(start);
    const durationSec = diff[0] + diff[1] / 1e9;
    const route = normalizeRoute(req.baseUrl ? `${req.baseUrl}${req.path}` : req.path);

    httpRequestDurationSeconds.observe(
      {
        method: req.method,
        route,
        status_code: res.statusCode.toString(),
      },
      durationSec
    );
  });

  next();
}

/**
 * Updates all periodic system gauges (DB pool, outbox depth, breaker states, and ledger conservation).
 */
export async function updateSystemMetrics(): Promise<void> {
  // 1. DB Pool Connections
  try {
    dbPoolConnections.set({ state: 'total' }, pool.totalCount);
    dbPoolConnections.set({ state: 'idle' }, pool.idleCount);
    dbPoolConnections.set({ state: 'waiting' }, pool.waitingCount);
  } catch {}

  // 2. Outbox Queue Depth
  try {
    const depthRes = await query(
      `SELECT status, COUNT(*)::INT as count FROM outbox_events GROUP BY status`
    );
    const counts: Record<string, number> = {
      PENDING: 0,
      DELIVERED: 0,
      DEAD_LETTER: 0,
    };
    for (const row of depthRes.rows) {
      counts[row.status] = Number(row.count);
    }
    outboxQueueDepth.set({ status: 'PENDING' }, counts.PENDING);
    outboxQueueDepth.set({ status: 'DELIVERED' }, counts.DELIVERED);
    outboxQueueDepth.set({ status: 'DEAD_LETTER' }, counts.DEAD_LETTER);
  } catch {}

  // 3. Circuit Breaker States per Endpoint
  try {
    const endpointsRes = await query(`SELECT id FROM webhook_endpoints WHERE status = 'ACTIVE'`);
    for (const ep of endpointsRes.rows) {
      const status = await circuitBreaker.getStatus(ep.id);
      let stateVal = 0;
      if (status.state === 'HALF_OPEN') stateVal = 1;
      else if (status.state === 'OPEN') stateVal = 2;
      circuitBreakerStateGauge.set({ endpoint_id: ep.id }, stateVal);
    }
  } catch {}

  // 4. Double-Entry Balance Conservation & Account Cache Consistency Invariant
  // For all transfer transactions (where a DEBIT entry exists), total debits must mathematically
  // equal total credits, AND all account balance_paise must strictly match the ledger SUM.
  try {
    const auditRes = await query(`
      SELECT (
        COALESCE((
          SELECT SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END) -
                 SUM(CASE WHEN entry_type = 'CREDIT' AND transaction_id IN (
                   SELECT transaction_id FROM ledger_entries WHERE entry_type = 'DEBIT'
                 ) THEN amount ELSE 0 END)
          FROM ledger_entries
        ), 0) +
        COALESCE((
          SELECT SUM(ABS(a.balance_paise - COALESCE(s.computed, 0)))
          FROM accounts a
          LEFT JOIN (
            SELECT account_id, SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END) AS computed
            FROM ledger_entries 
            GROUP BY account_id
          ) s ON a.id = s.account_id
          WHERE a.balance_paise != COALESCE(s.computed, 0)
        ), 0)
      )::BIGINT AS discrepancy_paise
    `);
    const discrepancy = Number(auditRes.rows[0]?.discrepancy_paise || 0);
    ledgerConservationDiscrepancyPaise.set(discrepancy);
  } catch {}
}

/**
 * Controller handler for GET /metrics.
 * If METRICS_TOKEN is set in environment, requires Bearer token authentication.
 */
export async function getMetricsHandler(req: Request, res: Response): Promise<void> {
  const metricsToken = process.env.METRICS_TOKEN;
  if (metricsToken) {
    const authHeader = req.headers.authorization;
    const queryToken = req.query.token as string | undefined;
    const provided = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : queryToken;

    if (!provided || provided !== metricsToken) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Valid METRICS_TOKEN required to access metrics.',
      });
      return;
    }
  }

  await updateSystemMetrics();
  res.setHeader('Content-Type', metricsRegistry.contentType);
  res.send(await metricsRegistry.metrics());
}
