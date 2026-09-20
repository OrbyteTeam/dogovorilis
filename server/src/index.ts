// СКЕЛЕТ сервера. Назначение: чтобы `docker compose up` из чистого клона поднимал сервис,
// применял миграции и отвечал на /healthz. Реальная логика собирается по docs/SPEC.md и ЗАДАЧА_01.md.
// Слои: src/transport (bot, http), src/domain, src/db, src/integrations.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

const cfg = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? '',
  maxMode: (process.env.MAX_MODE ?? 'off') as 'polling' | 'webhook' | 'off',
  maxBotToken: process.env.MAX_BOT_TOKEN ?? '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8080}`,
  webappDist: path.resolve(here, '..', '..', 'webapp', 'dist'),
  migrationsDir: path.resolve(here, '..', 'migrations'),
};

async function runMigrations(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const files = (await readdir(cfg.migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rowCount) continue;
      const sql = await readFile(path.join(cfg.migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    client.release();
  }
  return applied;
}

async function main() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
  const applied = await runMigrations(pool);
  app.log.info({ applied }, 'migrations checked');

  app.get('/healthz', async () => ({ ok: true, service: 'dogovorilis', mode: cfg.maxMode }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch (e) {
      reply.code(503);
      return { ok: false, error: (e as Error).message };
    }
  });

  await app.register(fastifyStatic, { root: cfg.webappDist, prefix: '/app/', decorateReply: false });
  app.get('/app', (_req, reply) => reply.redirect('/app/'));

  if (cfg.maxMode !== 'off') {
    if (!cfg.maxBotToken) {
      app.log.warn('MAX_MODE задан, но MAX_BOT_TOKEN пуст — бот не запущен (скелет).');
    } else {
      app.log.info({ mode: cfg.maxMode }, 'bot: запуск описан в docs/SPEC.md §4.4 и ЗАДАЧА_01.md — в скелете не реализован');
    }
  }

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  app.log.info({ url: cfg.publicBaseUrl }, 'skeleton up');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
