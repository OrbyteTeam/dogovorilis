// Таблица deal_events — журнал событий сделки (SPEC §5.4, §8).
import type { Queryable } from '../pool.js';
import type { ActorRole, DealEvent, DealEventType } from '../../types.js';

const COLS = 'id, deal_id, seq, type, actor_user_id, actor_role, payload, created_at';

type EventRow = {
  id: number;
  deal_id: number;
  seq: number;
  type: DealEventType;
  actor_user_id: number | null;
  actor_role: ActorRole;
  payload: Record<string, unknown>;
  created_at: Date;
};

function mapEvent(r: EventRow): DealEvent {
  return {
    id: r.id,
    dealId: r.deal_id,
    seq: r.seq,
    type: r.type,
    actorUserId: r.actor_user_id,
    actorRole: r.actor_role,
    payload: r.payload ?? {},
    createdAt: r.created_at,
  };
}

/**
 * seq = max(seq)+1 внутри той же транзакции; вызывающий уже держит блокировку строки deals (SPEC §5.4).
 * Номер считается тем же оператором INSERT, отдельного чтения нет.
 */
export async function append(
  q: Queryable,
  a: {
    dealId: number;
    type: DealEventType;
    actorUserId: number | null;
    actorRole: ActorRole;
    payload?: Record<string, unknown>;
  },
): Promise<DealEvent> {
  const res = await q.query<EventRow>(
    `INSERT INTO deal_events (deal_id, seq, type, actor_user_id, actor_role, payload)
     SELECT $1, COALESCE(MAX(e.seq), 0) + 1, $2, $3, $4, $5::jsonb
     FROM deal_events e
     WHERE e.deal_id = $1
     RETURNING ${COLS}`,
    [a.dealId, a.type, a.actorUserId, a.actorRole, JSON.stringify(a.payload ?? {})],
  );
  return mapEvent(res.rows[0]!);
}

export async function listByDeal(q: Queryable, dealId: number, limit?: number): Promise<DealEvent[]> {
  const res = await q.query<EventRow>(
    `SELECT ${COLS} FROM deal_events WHERE deal_id = $1 ORDER BY seq LIMIT $2`,
    [dealId, limit ?? 200],
  );
  return res.rows.map(mapEvent);
}

/** Однократность эффектов: событие такого типа по сделке уже записано. */
export async function existsOfType(q: Queryable, dealId: number, type: DealEventType): Promise<boolean> {
  const res = await q.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM deal_events WHERE deal_id = $1 AND type = $2) AS ok`,
    [dealId, type],
  );
  return res.rows[0]?.ok === true;
}

/**
 * Сколько сделок источника `source` пользователь создал после `since` — для лимита пробных сделок.
 * Источник пишется в payload события deal.created; считаем по журналу, а не в памяти, чтобы лимит
 * пережил рестарт процесса.
 */
export async function countCreatedSince(q: Queryable, a: { sellerUserId: number; source: string; since: Date }): Promise<number> {
  const res = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM deal_events e JOIN deals d ON d.id = e.deal_id
     WHERE d.seller_user_id = $1 AND e.type = 'deal.created' AND e.payload->>'source' = $2 AND e.created_at > $3`,
    [a.sellerUserId, a.source, a.since],
  );
  return res.rows[0]?.n ?? 0;
}
