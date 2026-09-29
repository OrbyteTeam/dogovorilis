// Таблица time_proposals — «Другое время» от клиента (ЗАДАЧА_08 D, SPEC §7.10, миграция 0007) и выборка занятости.
import type { Queryable } from '../pool.js';
import type { TimeProposal, TimeProposalStatus } from '../../types.js';

const COLS = 'id, deal_id, proposed_by_user_id, scheduled_at, base_version, status, accepted_version, created_at, resolved_at';

type ProposalRow = {
  id: string | number;
  deal_id: string | number;
  proposed_by_user_id: string | number;
  scheduled_at: Date;
  base_version: number;
  status: TimeProposalStatus;
  accepted_version: number | null;
  created_at: Date;
  resolved_at: Date | null;
};

function mapProposal(r: ProposalRow): TimeProposal {
  return {
    id: Number(r.id),
    dealId: Number(r.deal_id),
    proposedByUserId: Number(r.proposed_by_user_id),
    scheduledAt: r.scheduled_at,
    baseVersion: r.base_version,
    status: r.status,
    acceptedVersion: r.accepted_version,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/** Прежнее ожидающее предложение сделки вытесняется новым: одновременно ждёт не больше одного. */
export async function supersedePending(q: Queryable, dealId: number, now: Date): Promise<void> {
  await q.query(`UPDATE time_proposals SET status = 'superseded', resolved_at = $2 WHERE deal_id = $1 AND status = 'pending'`, [dealId, now]);
}

export async function create(
  q: Queryable,
  a: { dealId: number; proposedByUserId: number; scheduledAt: Date; baseVersion: number },
): Promise<TimeProposal> {
  const res = await q.query<ProposalRow>(
    `INSERT INTO time_proposals (deal_id, proposed_by_user_id, scheduled_at, base_version)
     VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
    [a.dealId, a.proposedByUserId, a.scheduledAt, a.baseVersion],
  );
  return mapProposal(res.rows[0]!);
}

export async function byId(q: Queryable, id: number): Promise<TimeProposal | null> {
  const res = await q.query<ProposalRow>(`SELECT ${COLS} FROM time_proposals WHERE id = $1`, [id]);
  return res.rows[0] ? mapProposal(res.rows[0]) : null;
}

export async function lockById(q: Queryable, id: number): Promise<TimeProposal | null> {
  const res = await q.query<ProposalRow>(`SELECT ${COLS} FROM time_proposals WHERE id = $1 FOR UPDATE`, [id]);
  return res.rows[0] ? mapProposal(res.rows[0]) : null;
}

export async function resolve(q: Queryable, id: number, status: Exclude<TimeProposalStatus, 'pending'>, now: Date, acceptedVersion: number | null = null): Promise<void> {
  await q.query(`UPDATE time_proposals SET status = $2, resolved_at = $3, accepted_version = $4 WHERE id = $1`, [id, status, now, acceptedVersion]);
}

/** Ожидающее предложение сделки (для кнопки «Принять» в карточке исполнителя). */
export async function pendingForDeal(q: Queryable, dealId: number): Promise<TimeProposal | null> {
  const res = await q.query<ProposalRow>(`SELECT ${COLS} FROM time_proposals WHERE deal_id = $1 AND status = 'pending' LIMIT 1`, [dealId]);
  return res.rows[0] ? mapProposal(res.rows[0]) : null;
}

/**
 * Визиты исполнителя, которые занимают время (SPEC §7.10): сделки в scheduled / awaiting_prepayment /
 * awaiting_acceptance с датой, плюс удержания — принятое предложение, версия с которым ждёт подтверждения клиента.
 * Демо-сделки время не занимают: в них клиент — сам исполнитель. Текущая сделка исключается.
 * Окно — по началу визита: визит длиннее 12 часов не бывает (0006), поэтому запас слева 12 часов.
 */
export async function busyForSeller(
  q: Queryable,
  a: { sellerUserId: number; excludeDealId: number; from: Date; to: Date },
): Promise<Array<{ start: Date; durationMin: number | null }>> {
  const res = await q.query<{ start: Date; duration_min: number | null }>(
    `SELECT v.scheduled_at AS start, d.duration_min
     FROM deals d
     JOIN deal_versions v ON v.deal_id = d.id AND v.version = d.current_version
     WHERE d.seller_user_id = $1
       AND d.id <> $2
       AND NOT d.demo
       AND v.scheduled_at IS NOT NULL
       AND v.scheduled_at > $3::timestamptz - interval '12 hours'
       AND v.scheduled_at < $4
       AND (
         d.status IN ('scheduled', 'awaiting_prepayment', 'awaiting_acceptance')
         OR (d.status IN ('awaiting_confirmation', 'changes_requested') AND EXISTS (
               SELECT 1 FROM time_proposals p
               WHERE p.deal_id = d.id AND p.status = 'accepted' AND p.accepted_version = d.current_version))
       )
     ORDER BY v.scheduled_at`,
    [a.sellerUserId, a.excludeDealId, a.from, a.to],
  );
  return res.rows.map((r) => ({ start: r.start, durationMin: r.duration_min }));
}
