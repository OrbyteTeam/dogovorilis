// Раннер миграций: server/migrations/*.sql по алфавиту, каждая в транзакции,
// учёт в таблице schema_migrations (SPEC §4.4 п. 3). Перенесён из index.ts.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { log } from '../logger.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rowCount) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log.info({ migration: file }, 'миграция применена');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`миграция ${file} не применилась: ${(e as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
  return applied;
}
