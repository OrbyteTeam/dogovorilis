// Оценка клиента и факты для показателей надёжности (ЗАДАЧА_08 E, SPEC §7.11, миграция 0008).
import type { Queryable } from '../pool.js';
import type { FinishedDealFacts } from '../../domain/reliability.js';

export type DealRating = { dealId: number; clientUserId: number; score: number; comment: string | null; createdAt: Date };

/** Оценка один раз на сделку: повтор (двойное нажатие, вторая попытка) ничего не меняет — вернётся null. */
export async function createOnce(q: Queryable, a: { dealId: number; clientUserId: number; score: number }): Promise<DealRating | null> {
  const res = await q.query<{ deal_id: string | number; client_user_id: string | number; score: number; comment: string | null; created_at: Date }>(
    `INSERT INTO deal_ratings (deal_id, client_user_id, score) VALUES ($1, $2, $3)
     ON CONFLICT (deal_id) DO NOTHING
     RETURNING deal_id, client_user_id, score, comment, created_at`,
    [a.dealId, a.clientUserId, a.score],
  );
  const r = res.rows[0];
  return r ? { dealId: Number(r.deal_id), clientUserId: Number(r.client_user_id), score: r.score, comment: r.comment, createdAt: r.created_at } : null;
}

export async function byDeal(q: Queryable, dealId: number): Promise<DealRating | null> {
  const res = await q.query<{ deal_id: string | number; client_user_id: string | number; score: number; comment: string | null; created_at: Date }>(
    'SELECT deal_id, client_user_id, score, comment, created_at FROM deal_ratings WHERE deal_id = $1',
    [dealId],
  );
  const r = res.rows[0];
  return r ? { dealId: Number(r.deal_id), clientUserId: Number(r.client_user_id), score: r.score, comment: r.comment, createdAt: r.created_at } : null;
}

/** Комментарий — один раз, только к своей оценке и только если его ещё нет. */
export async function setCommentOnce(q: Queryable, a: { dealId: number; clientUserId: number; comment: string; now: Date }): Promise<boolean> {
  const res = await q.query(
    `UPDATE deal_ratings SET comment = $3, commented_at = $4
     WHERE deal_id = $1 AND client_user_id = $2 AND comment IS NULL`,
    [a.dealId, a.clientUserId, a.comment, a.now],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Факты по завершённым не-демо сделкам исполнителя (closed / cancelled). Демо в показатели не входят (задача E):
 * в них клиент — сам исполнитель.
 */
export async function finishedFacts(q: Queryable, sellerUserId: number): Promise<FinishedDealFacts[]> {
  const res = await q.query<{
    status: 'closed' | 'cancelled';
    confirmed_at: Date | null;
    done_at: Date | null;
    paid_at: Date | null;
    closed_at: Date | null;
    cancelled_by_role: 'seller' | 'client' | 'system' | null;
    disputed: boolean;
    receipt_at: Date | null;
    closed_by_mode: boolean;
    score: number | null;
  }>(
    `SELECT d.status, d.confirmed_at, d.done_at, d.paid_at, d.closed_at, d.cancelled_by_role,
       EXISTS (SELECT 1 FROM deal_events e WHERE e.deal_id = d.id AND e.type = 'payment.not_received') AS disputed,
       (SELECT min(r.created_at) FROM receipts r WHERE r.deal_id = d.id) AS receipt_at,
       EXISTS (SELECT 1 FROM deal_events e WHERE e.deal_id = d.id AND e.type = 'deal.closed' AND e.payload->>'reason' = 'tax_mode_none') AS closed_by_mode,
       (SELECT dr.score FROM deal_ratings dr WHERE dr.deal_id = d.id) AS score
     FROM deals d
     WHERE d.seller_user_id = $1 AND NOT d.demo AND d.status IN ('closed', 'cancelled')`,
    [sellerUserId],
  );
  return res.rows.map((r) => ({
    status: r.status,
    confirmedAt: r.confirmed_at,
    doneAt: r.done_at,
    paidAt: r.paid_at,
    closedAt: r.closed_at,
    cancelledByRole: r.cancelled_by_role,
    transferDisputed: r.disputed,
    receiptAt: r.receipt_at,
    closedWithoutChequeByMode: r.closed_by_mode,
    score: r.score,
  }));
}
