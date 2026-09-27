// Таблица deals (SPEC §8). Переходы статусов — только через lock* + update, под транзакцией домена (SPEC §5.2).
import type { Queryable } from '../pool.js';
import type { DayScheduleItem, Deal, DealListItem, DealStatus, TemplateKey } from '../../types.js';
import { TERMINAL_STATUSES } from '../../types.js';

const COLS = `id, public_id, seller_user_id, client_user_id, demo, template, current_version, status,
  status_changed_at, client_joined_at, confirmed_at, done_at, accepted_at, paid_at, closed_at,
  cancelled_at, cancelled_by_role, cancel_reason, cancel_refund_expected, refund_sent_at, refund_received_at,
  expires_at, created_at, updated_at`;

type DealRow = {
  id: number;
  public_id: string;
  seller_user_id: number;
  client_user_id: number | null;
  demo: boolean;
  template: TemplateKey;
  current_version: number;
  status: DealStatus;
  status_changed_at: Date;
  client_joined_at: Date | null;
  confirmed_at: Date | null;
  done_at: Date | null;
  accepted_at: Date | null;
  paid_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by_role: 'seller' | 'client' | 'system' | null;
  cancel_reason: string | null;
  cancel_refund_expected: boolean | null;
  refund_sent_at: Date | null;
  refund_received_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type DealListItemRow = {
  public_id: string;
  status: DealStatus;
  demo: boolean;
  seller_user_id: string | number;
  updated_at: Date;
  title: string;
  scheduled_at: Date | null;
  total_kopecks: string | number;
  prepayment_kopecks: string | number;
  paid_kopecks: string | number;
};

function mapDeal(r: DealRow): Deal {
  return {
    id: r.id,
    publicId: r.public_id,
    sellerUserId: r.seller_user_id,
    clientUserId: r.client_user_id,
    demo: r.demo,
    template: r.template,
    currentVersion: r.current_version,
    status: r.status,
    statusChangedAt: r.status_changed_at,
    clientJoinedAt: r.client_joined_at,
    confirmedAt: r.confirmed_at,
    doneAt: r.done_at,
    acceptedAt: r.accepted_at,
    paidAt: r.paid_at,
    closedAt: r.closed_at,
    cancelledAt: r.cancelled_at,
    cancelledByRole: r.cancelled_by_role,
    cancelReason: r.cancel_reason,
    cancelRefundExpected: r.cancel_refund_expected,
    refundSentAt: r.refund_sent_at,
    refundReceivedAt: r.refund_received_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function create(
  q: Queryable,
  a: { publicId: string; sellerUserId: number; template: TemplateKey; expiresAt: Date },
): Promise<Deal> {
  const res = await q.query<DealRow>(
    `INSERT INTO deals (public_id, seller_user_id, template, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLS}`,
    [a.publicId, a.sellerUserId, a.template, a.expiresAt],
  );
  return mapDeal(res.rows[0]!);
}

export async function byId(q: Queryable, id: number): Promise<Deal | null> {
  const res = await q.query<DealRow>(`SELECT ${COLS} FROM deals WHERE id = $1`, [id]);
  return res.rows[0] ? mapDeal(res.rows[0]) : null;
}

export async function byPublicId(q: Queryable, publicId: string): Promise<Deal | null> {
  const res = await q.query<DealRow>(`SELECT ${COLS} FROM deals WHERE public_id = $1`, [publicId]);
  return res.rows[0] ? mapDeal(res.rows[0]) : null;
}

/** SELECT … FOR UPDATE — все переходы идут только через это (SPEC §5.2 «Конкурентность»). */
export async function lockById(q: Queryable, id: number): Promise<Deal | null> {
  const res = await q.query<DealRow>(`SELECT ${COLS} FROM deals WHERE id = $1 FOR UPDATE`, [id]);
  return res.rows[0] ? mapDeal(res.rows[0]) : null;
}

/** То же по публичному идентификатору из диплинка. */
export async function lockByPublicId(q: Queryable, publicId: string): Promise<Deal | null> {
  const res = await q.query<DealRow>(`SELECT ${COLS} FROM deals WHERE public_id = $1 FOR UPDATE`, [publicId]);
  return res.rows[0] ? mapDeal(res.rows[0]) : null;
}

export type DealPatch = Partial<
  Pick<
    Deal,
    | 'clientUserId'
    | 'demo'
    | 'currentVersion'
    | 'status'
    | 'statusChangedAt'
    | 'clientJoinedAt'
    | 'confirmedAt'
    | 'doneAt'
    | 'acceptedAt'
    | 'paidAt'
    | 'closedAt'
    | 'cancelledAt'
    | 'cancelledByRole'
    | 'cancelReason'
    | 'cancelRefundExpected'
    | 'refundSentAt'
    | 'refundReceivedAt'
    | 'expiresAt'
  >
>;

/** Явная карта полей патча в колонки: автопреобразование имён легко ломается при переименованиях. */
const PATCH_COLUMNS: { readonly [K in keyof Required<DealPatch>]: string } = {
  clientUserId: 'client_user_id',
  demo: 'demo',
  currentVersion: 'current_version',
  status: 'status',
  statusChangedAt: 'status_changed_at',
  clientJoinedAt: 'client_joined_at',
  confirmedAt: 'confirmed_at',
  doneAt: 'done_at',
  acceptedAt: 'accepted_at',
  paidAt: 'paid_at',
  closedAt: 'closed_at',
  cancelledAt: 'cancelled_at',
  cancelledByRole: 'cancelled_by_role',
  cancelReason: 'cancel_reason',
  cancelRefundExpected: 'cancel_refund_expected',
  refundSentAt: 'refund_sent_at',
  refundReceivedAt: 'refund_received_at',
  expiresAt: 'expires_at',
};

export async function update(q: Queryable, id: number, patch: DealPatch): Promise<Deal> {
  const sets: string[] = [];
  const params: unknown[] = [id];

  for (const key of Object.keys(PATCH_COLUMNS) as (keyof DealPatch)[]) {
    if (!(key in patch)) continue;
    params.push(patch[key] ?? null);
    sets.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
  }

  // Пустой патч — записывать нечего, отдаём текущее состояние.
  if (sets.length === 0) {
    const current = await byId(q, id);
    if (!current) throw new Error(`deals.update: сделка ${id} не найдена`);
    return current;
  }

  const res = await q.query<DealRow>(
    `UPDATE deals SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
    params,
  );
  if (!res.rows[0]) throw new Error(`deals.update: сделка ${id} не найдена`);
  return mapDeal(res.rows[0]);
}

const AWAITING_PAYMENT_STATUSES: readonly DealStatus[] = ['awaiting_prepayment', 'awaiting_payment'];

export async function listForUser(
  q: Queryable,
  userId: number,
  a: { role: 'seller' | 'client' | 'all'; filter: 'active' | 'awaiting_payment' | 'done' | 'all'; limit?: number },
): Promise<Deal[]> {
  const params: unknown[] = [userId];
  const where: string[] =
    a.role === 'seller'
      ? ['seller_user_id = $1']
      : a.role === 'client'
        ? ['client_user_id = $1']
        : ['(seller_user_id = $1 OR client_user_id = $1)'];

  if (a.filter === 'active') {
    params.push(TERMINAL_STATUSES as readonly string[]);
    where.push(`NOT (status = ANY($${params.length}::text[]))`);
  } else if (a.filter === 'done') {
    params.push(TERMINAL_STATUSES as readonly string[]);
    where.push(`status = ANY($${params.length}::text[])`);
  } else if (a.filter === 'awaiting_payment') {
    params.push(AWAITING_PAYMENT_STATUSES as readonly string[]);
    where.push(`status = ANY($${params.length}::text[])`);
  }

  params.push(a.limit ?? 50);
  const res = await q.query<DealRow>(
    `SELECT ${COLS} FROM deals
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(mapDeal);
}

/**
 * Список для экрана «Мои сделки» (SPEC §7.4): одним запросом с текущей версией и суммой
 * подтверждённых платежей. Отдельно от listForUser, чтобы не ходить за каждой сделкой в getBundleById.
 */
export async function listItemsForUser(
  q: Queryable,
  userId: number,
  a: { role: 'seller' | 'client' | 'all'; filter: 'active' | 'awaiting_payment' | 'done' | 'all'; limit?: number },
): Promise<DealListItem[]> {
  const params: unknown[] = [userId];
  const where: string[] =
    a.role === 'seller'
      ? ['d.seller_user_id = $1']
      : a.role === 'client'
        ? ['d.client_user_id = $1']
        : ['(d.seller_user_id = $1 OR d.client_user_id = $1)'];

  if (a.filter === 'active') {
    params.push(TERMINAL_STATUSES as readonly string[]);
    where.push(`NOT (d.status = ANY($${params.length}::text[]))`);
  } else if (a.filter === 'done') {
    params.push(TERMINAL_STATUSES as readonly string[]);
    where.push(`d.status = ANY($${params.length}::text[])`);
  } else if (a.filter === 'awaiting_payment') {
    params.push(AWAITING_PAYMENT_STATUSES as readonly string[]);
    where.push(`d.status = ANY($${params.length}::text[])`);
  }

  params.push(a.limit ?? 50);
  const res = await q.query<DealListItemRow>(
    `SELECT d.public_id, d.status, d.demo, d.seller_user_id, d.updated_at,
            v.title, v.scheduled_at, v.total_kopecks, v.prepayment_kopecks,
            COALESCE(p.paid, 0) AS paid_kopecks
     FROM deals d
     JOIN deal_versions v ON v.deal_id = d.id AND v.version = d.current_version
     LEFT JOIN LATERAL (
       SELECT SUM(amount_kopecks) AS paid FROM payments
       WHERE deal_id = d.id AND status = 'succeeded'
     ) p ON TRUE
     WHERE ${where.join(' AND ')}
     ORDER BY d.updated_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return res.rows.map((r) => ({
    publicId: r.public_id,
    status: r.status,
    demo: r.demo,
    role: Number(r.seller_user_id) === userId ? 'seller' : 'client',
    title: r.title,
    scheduledAt: r.scheduled_at,
    totalKopecks: Number(r.total_kopecks),
    prepaymentKopecks: Number(r.prepayment_kopecks),
    paidKopecks: Number(r.paid_kopecks),
    updatedAt: r.updated_at,
  }));
}

type DayScheduleRow = {
  public_id: string;
  status: DealStatus;
  demo: boolean;
  title: string;
  scheduled_at: Date;
  prepayment_kopecks: string | number;
  client_first_name: string | null;
  client_last_name: string | null;
};

/**
 * Записи исполнителя на сутки [from, to) в указанных статусах — состав утренней сводки (ЗАДАЧА_04 B2).
 * Считается заново в момент отправки: что изменилось с момента планирования, в сводку попадёт как есть.
 */
export async function listDaySchedule(
  q: Queryable,
  a: { sellerUserId: number; from: Date; to: Date; statuses: readonly DealStatus[] },
): Promise<DayScheduleItem[]> {
  const res = await q.query<DayScheduleRow>(
    `SELECT d.public_id, d.status, d.demo, v.title, v.scheduled_at, v.prepayment_kopecks,
            u.first_name AS client_first_name, u.last_name AS client_last_name
     FROM deals d
     JOIN deal_versions v ON v.deal_id = d.id AND v.version = d.current_version
     LEFT JOIN users u ON u.max_user_id = d.client_user_id
     WHERE d.seller_user_id = $1 AND d.status = ANY($2::text[])
       AND v.scheduled_at >= $3 AND v.scheduled_at < $4
     ORDER BY v.scheduled_at, d.id`,
    [a.sellerUserId, [...a.statuses], a.from, a.to],
  );
  return res.rows.map((r) => ({
    publicId: r.public_id,
    status: r.status,
    demo: r.demo,
    title: r.title,
    scheduledAt: r.scheduled_at,
    prepaymentKopecks: Number(r.prepayment_kopecks),
    // Как displayName в карточке: у пользователя MAX без имени — «без имени», а не «клиента нет».
    clientName: r.client_first_name === null ? null : [r.client_first_name, r.client_last_name].filter(Boolean).join(' ').trim() || 'без имени',
  }));
}
