import fs from 'fs';
import path from 'path';
import { pool } from './pool';

export async function runMigrations(): Promise<void> {
  // Resolve migrations directory whether running via tsx (src/) or compiled (dist/)
  let migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    const fallbackSrc = path.resolve(__dirname, '../../src/db/migrations');
    if (fs.existsSync(fallbackSrc)) {
      migrationsDir = fallbackSrc;
    } else {
      const fallbackRoot = path.join(process.cwd(), 'src/db/migrations');
      if (fs.existsSync(fallbackRoot)) {
        migrationsDir = fallbackRoot;
      }
    }
  }

  console.log(`[Migrations] Scanning ${migrationsDir}...`);

  // Ensure schema_migrations table exists to track applied migrations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const checkResult = await pool.query(
      `SELECT filename FROM schema_migrations WHERE filename = $1`,
      [file]
    );

    if (checkResult.rows.length > 0) {
      console.log(`[Migrations] Migration ${file} already applied, skipping.`);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    console.log(`[Migrations] Executing ${file}...`);
    try {
      await pool.query('BEGIN');
      await pool.query(sql);
      await pool.query(
        `INSERT INTO schema_migrations (filename) VALUES ($1)`,
        [file]
      );
      await pool.query('COMMIT');
      console.log(`[Migrations] Successfully executed ${file}`);
    } catch (err) {
      await pool.query('ROLLBACK').catch(() => {});
      console.error(`[Migrations] Error executing ${file}:`, err);
      throw err;
    }
  }
}

if (require.main === module) {
  runMigrations()
    .then(async () => {
      console.log('[Migrations] All migrations completed successfully.');
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[Migrations] Failed to run migrations:', err);
      await pool.end();
      process.exit(1);
    });
}
