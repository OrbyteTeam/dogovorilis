// Пул соединений Postgres. Подключение с ретраем: compose ждёт db healthy, но ретрай всё равно нужен
// (SPEC §4.4 п. 2 — 10 попыток × 3 с).
import pg from 'pg';
import { log } from '../logger.js';

// BIGINT (oid 20) приходит из pg строкой. Все наши bigint-поля — id и копейки (≤ 10^11),
// это безопасно для Number (MAX_SAFE_INTEGER ≈ 9·10^15). Парсим в number, чтобы домен не знал про строки.
pg.types.setTypeParser(20, (v: string) => Number(v));
// NUMERIC (1700) в схеме не используется — оставляем как есть (строка), чтобы не потерять точность случайно.

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
/** Всё, что умеет выполнять запрос: пул или клиент внутри транзакции. Репозитории принимают именно это. */
export type Queryable = { query: pg.Pool['query'] };

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) throw new Error('пул БД не создан: вызовите connectDb() при старте');
  return pool;
}

export async function connectDb(connectionString: string, attempts = 10, delayMs = 3000): Promise<pg.Pool> {
  const p = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  p.on('error', (err) => log.error({ err: err.message }, 'db: ошибка простаивающего соединения'));

  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const c = await p.connect();
      try {
        await c.query('SELECT 1');
      } finally {
        c.release();
      }
      pool = p;
      log.info({ attempt: i }, 'db: подключено');
      return p;
    } catch (e) {
      lastError = e;
      log.warn({ attempt: i, of: attempts, err: (e as Error).message }, 'db: не подключилось, повтор');
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  await p.end().catch(() => {});
  throw new Error(`не удалось подключиться к БД за ${attempts} попыток: ${(lastError as Error)?.message}`);
}

export async function closeDb(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/**
 * Транзакция. Все переходы сделки выполняются здесь же, вместе с `SELECT … FOR UPDATE`
 * строки deals (SPEC §5.2 «Конкурентность»).
 */
export async function inTx<T>(fn: (c: DbClient) => Promise<T>, db: pg.Pool = getPool()): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
