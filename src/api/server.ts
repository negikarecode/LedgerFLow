import { app } from './app';
import { env } from '../config/env';
import { closePool } from '../db/pool';
import { closeRedis } from '../redis/client';
import { runMigrations } from '../db/migrate';

async function bootstrap() {
  try {
    console.log('[LedgerFlow API] Starting server...');

    // Attempt to ensure migrations are run on startup
    try {
      await runMigrations();
    } catch (migErr: any) {
      console.warn('[LedgerFlow API] Warning: Automatic migration run failed or skipped:', migErr.message);
    }

    const server = app.listen(env.PORT, () => {
      console.log(`[LedgerFlow API] Server running at http://localhost:${env.PORT}`);
      console.log(`[LedgerFlow API] Swagger Docs available at http://localhost:${env.PORT}/docs`);
      console.log(`[LedgerFlow API] Health check at http://localhost:${env.PORT}/health`);
    });

    const shutdown = async (signal: string) => {
      console.log(`[LedgerFlow API] Received ${signal}. Gracefully shutting down...`);
      server.close(async () => {
        console.log('[LedgerFlow API] Closed HTTP server.');
        try {
          await closePool();
          console.log('[LedgerFlow API] Closed PostgreSQL pool.');
          await closeRedis();
          console.log('[LedgerFlow API] Closed Redis connection.');
          process.exit(0);
        } catch (err) {
          console.error('[LedgerFlow API] Error during shutdown:', err);
          process.exit(1);
        }
      });

      // Force exit after 10s if graceful shutdown hangs
      setTimeout(() => {
        console.error('[LedgerFlow API] Forced shutdown due to timeout.');
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('[LedgerFlow API] Fatal startup error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrap();
}
