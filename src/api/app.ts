import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { requestLogger } from '../observability/logger';
import { metricsMiddleware, getMetricsHandler } from '../observability/metrics';
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

export function createApp(): Express {
  const app = express();

  // Security and utility middlewares
  app.use(
    helmet({
      contentSecurityPolicy: false, // Allows Swagger UI and dashboard assets to load
    })
  );
  app.use(cors());
  app.use(express.json());
  app.use(requestLogger);
  app.use(metricsMiddleware);

  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
  }

  // Prometheus Metrics endpoint
  app.get('/metrics', getMetricsHandler);

  // Static files for Chaos Simulator UI
  const candidateDirs = [
    path.join(process.cwd(), 'public'),
    path.join(__dirname, '../public'),
    path.join(__dirname, '../../public'),
  ];
  const publicDir = candidateDirs.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || candidateDirs[0];
  app.use(express.static(publicDir));

  // Swagger Documentation
  app.use(docsRouter);

  // Core API Routes
  app.use(healthRouter);
  app.use(adminRouter);
  app.use(accountsRouter);
  app.use(transfersRouter);
  app.use(outboxRouter);
  app.use(webhookEndpointsRouter);
  app.use(merchantRouter);
  app.use(demoRouter);

  // Serve Chaos Simulator UI on root if index.html exists
  app.get('/', (req, res, next) => {
    res.sendFile(path.join(publicDir, 'index.html'), (err) => {
      if (err) next();
    });
  });

  // Error Handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
