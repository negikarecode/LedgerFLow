import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { requestLogger } from '../observability/logger';
import { metricsMiddleware, getMetricsHandler } from '../observability/metrics';
import {
  earlyPayloadSizeGuard,
  requestTimeoutGuard,
  publicRateLimiter,
} from './middlewares/rate-limit.middleware';
import { healthRouter } from './routes/health.route';
import { adminRouter } from './routes/admin.route';
import { accountsRouter } from './routes/accounts.route';
import { transfersRouter } from './routes/transfers.route';
import { outboxRouter } from './routes/outbox.route';
import { webhookEndpointsRouter } from './routes/webhook-endpoints.route';
import { merchantRouter } from './routes/merchant.route';
import { demoRouter } from './routes/demo.route';
import { docsRouter } from './docs/swagger';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { env } from '../config/env';

export function createApp(): Express {
  const app = express();

  // Configure Trust Proxy
  const trustProxyConfig = env.TRUST_PROXY;
  if (trustProxyConfig === 'true') {
    app.set('trust proxy', true);
  } else if (trustProxyConfig === 'false') {
    app.set('trust proxy', false);
  } else {
    const num = parseInt(trustProxyConfig, 10);
    app.set('trust proxy', isNaN(num) ? trustProxyConfig : num);
  }

  // Security and utility middlewares
  app.use(
    helmet({
      contentSecurityPolicy: false, // Allows Swagger UI and dashboard assets to load
    })
  );
  app.use(cors());

  // Early payload size guard rejects requests with Content-Length > 256kb upfront
  app.use(earlyPayloadSizeGuard(262144));

  // Request body parsing with strict size limit
  app.use(express.json({ limit: env.BODY_SIZE_LIMIT || '256kb' }));
  app.use(express.urlencoded({ extended: true, limit: env.BODY_SIZE_LIMIT || '256kb' }));

  // Enforce server-side request processing deadline
  app.use(requestTimeoutGuard(env.REQUEST_TIMEOUT_MS || 15000));

  app.use(requestLogger);
  app.use(metricsMiddleware);

  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
  }

  // Prometheus Metrics endpoint
  app.get('/metrics', getMetricsHandler);

  // Global public rate limiter (protects public endpoints; skips health and metrics)
  app.use(publicRateLimiter);

  const isProduction = env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production';

  // Static files and UI: Only mounted in non-production environments
  if (!isProduction) {
    const candidateDirs = [
      path.join(process.cwd(), 'public'),
      path.join(__dirname, '../public'),
      path.join(__dirname, '../../public'),
    ];
    const publicDir = candidateDirs.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || candidateDirs[0];
    app.use(express.static(publicDir));

    // Serve Chaos Simulator UI on root if index.html exists
    app.get('/', (req, res, next) => {
      res.sendFile(path.join(publicDir, 'index.html'), (err) => {
        if (err) next();
      });
    });
  } else {
    // Production root status response
    app.get('/', (req, res) => {
      res.json({
        name: 'LedgerFlow API',
        version: '1.0.0',
        environment: 'production',
        docs: '/docs',
        health: '/health',
      });
    });
  }

  // Swagger Documentation
  app.use(docsRouter);

  // Core API Routes
  app.use(healthRouter);
  app.use(adminRouter);
  app.use(accountsRouter);
  app.use(transfersRouter);
  app.use(outboxRouter);
  app.use(webhookEndpointsRouter);

  // Non-production demo & simulation routers
  if (!isProduction) {
    app.use(merchantRouter);
    app.use(demoRouter);
  }

  // Error Handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
