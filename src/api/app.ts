import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { healthRouter } from './routes/health.route';
import { accountsRouter } from './routes/accounts.route';
import { docsRouter } from './docs/swagger';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';

export function createApp(): Express {
  const app = express();

  // Security and utility middlewares
  app.use(
    helmet({
      contentSecurityPolicy: false, // Allows Swagger UI assets to load without CSP issues
    })
  );
  app.use(cors());
  app.use(express.json());

  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
  }

  // Swagger Documentation
  app.use(docsRouter);

  // Core API Routes
  app.use(healthRouter);
  app.use(accountsRouter);

  // Error Handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
