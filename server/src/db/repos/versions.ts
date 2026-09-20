// Таблица deal_versions (SPEC §8): версия условий не редактируется, добавляется новая.
import type { Queryable } from '../pool.js';
import type { CancelRule, DealVersion } from '../../types.js';

const COLS = `id, deal_id, version, title, description, scheduled_at, total_kopecks, prepayment_kopecks,
  cancel_rule, photo_max_token, change_request_text, created_by_user_id, created_at,
  confirmed_at, confirmed_by_user_id`;

type VersionRow = {
  id: number;
  deal_id: number;
  version: number;
  title: string;
  description: string | null;
  scheduled_at: Date | null;
  total_kopecks: number;
  prepayment_kopecks: number;
  cancel_rule: CancelRule;
  photo_max_token: string | null;
  change_request_text: string | null;
  created_by_user_id: number;
  created_at: Date;
  confirmed_at: Date | null;
  confirmed_by_user_id: number | null;
};

function mapVersion(r: VersionRow): DealVersion {
  return {
    id: r.id,
    dealId: r.deal_id,
    version: r.version,
    title: r.title,
    description: r.description,
    scheduledAt: r.scheduled_at,
    totalKopecks: r.total_kopecks,
    prepaymentKopecks: r.prepayment_kopecks,
    cancelRule: r.cancel_rule,
    photoMaxToken: r.photo_max_token,
    changeRequestText: r.change_request_text,
    createdByUserId: r.created_by_user_id,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    confirmedByUserId: r.confirmed_by_user_id,
  };
}

export async function create(
  q: Queryable,
  a: {
    dealId: number;
    version: number;
    title: string;
    description: string | null;
    scheduledAt: Date | null;
    totalKopecks: number;
    prepaymentKopecks: number;
    cancelRule: CancelRule;
    photoMaxToken: string | null;
    changeRequestText: string | null;
    createdByUserId: number;
  },
): Promise<DealVersion> {
  const res = await q.query<VersionRow>(
    `INSERT INTO deal_versions
       (deal_id, version, title, description, scheduled_at, total_kopecks, prepayment_kopecks,
        cancel_rule, photo_max_token, change_request_text, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLS}`,
    [
      a.dealId,
      a.version,
      a.title,
      a.description,
      a.scheduledAt,
      a.totalKopecks,
      a.prepaymentKopecks,
      a.cancelRule,
      a.photoMaxToken,
      a.changeRequestText,
      a.createdByUserId,
    ],
  );
  return mapVersion(res.rows[0]!);
}

export async function byVersion(q: Queryable, dealId: number, version: number): Promise<DealVersion | null> {
  const res = await q.query<VersionRow>(
    `SELECT ${COLS} FROM deal_versions WHERE deal_id = $1 AND version = $2`,
    [dealId, version],
  );
  return res.rows[0] ? mapVersion(res.rows[0]) : null;
}

export async function listByDeal(q: Queryable, dealId: number): Promise<DealVersion[]> {
  const res = await q.query<VersionRow>(
    `SELECT ${COLS} FROM deal_versions WHERE deal_id = $1 ORDER BY version`,
    [dealId],
  );
  return res.rows.map(mapVersion);
}

/** Клиент нажал «Подтверждаю» именно на этой версии (SPEC §5.2 T3). */
export async function markConfirmed(
  q: Queryable,
  dealId: number,
  version: number,
  userId: number,
  at: Date,
): Promise<void> {
  await q.query(
    `UPDATE deal_versions
     SET confirmed_at = $4, confirmed_by_user_id = $3
     WHERE deal_id = $1 AND version = $2`,
    [dealId, version, userId, at],
  );
}

/** 0 — версий ещё нет. */
export async function maxVersion(q: Queryable, dealId: number): Promise<number> {
  const res = await q.query<{ max_version: number }>(
    `SELECT COALESCE(MAX(version), 0) AS max_version FROM deal_versions WHERE deal_id = $1`,
    [dealId],
  );
  return Number(res.rows[0]?.max_version ?? 0);
}
