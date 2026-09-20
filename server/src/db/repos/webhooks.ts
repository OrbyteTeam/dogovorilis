// Таблица webhook_log — каждая доставка вебхука и её идемпотентность (SPEC §9.6).
import type { Queryable } from '../pool.js';

export type WebhookProvider = 'yookassa' | 'tbank' | 'max';

/** Записать доставку до обработки; id нужен, чтобы потом проставить result. */
export async function record(
  q: Queryable,
  a: { provider: WebhookProvider; externalId: string | null; event: string | null; payload: unknown },
): Promise<number> {
  const res = await q.query<{ id: number }>(
    `INSERT INTO webhook_log (provider, external_id, event, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [a.provider, a.externalId, a.event, JSON.stringify(a.payload ?? null)],
  );
  return res.rows[0]!.id;
}

/** result: ok | ignored:<reason> | error:<text> (SPEC §9.6). */
export async function markResult(q: Queryable, id: number, result: string): Promise<void> {
  await q.query(`UPDATE webhook_log SET result = $2, processed_at = now() WHERE id = $1`, [id, result]);
}

/**
 * Идемпотентность по (provider, external_id, provider_status) — SPEC §9.6.
 * Отдельной колонки provider_status в схеме нет: её роль играет `event`, поэтому
 * record() для платёжных вебхуков вызывается с event = статус провайдера
 * (ЮKassa: `payment.succeeded`; Т-Банк: `CONFIRMED`). Ошибочные попытки не считаются
 * обработкой — такой вебхук можно повторить.
 */
export async function alreadyProcessed(
  q: Queryable,
  provider: WebhookProvider,
  externalId: string,
  providerStatus: string,
): Promise<boolean> {
  const res = await q.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM webhook_log
       WHERE provider = $1
         AND external_id = $2
         AND event = $3
         AND processed_at IS NOT NULL
         AND COALESCE(result, '') NOT LIKE 'error%'
     ) AS ok`,
    [provider, externalId, providerStatus],
  );
  return res.rows[0]?.ok === true;
}
