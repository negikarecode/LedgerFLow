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

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    console.log(`[Migrations] Executing ${file}...`);
    try {
      await pool.query(sql);
      console.log(`[Migrations] Successfully executed ${file}`);
    } catch (err) {
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
