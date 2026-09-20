// Таблица payments (SPEC §8, §9): не более одного живого платежа на (deal_id, kind) — частичный уникальный индекс.
import type { Queryable } from '../pool.js';
import type { Payment, PaymentKind, PaymentProvider, PaymentRail, PaymentStatus } from '../../types.js';

// raw (последний ответ провайдера) наружу не отдаём — он только для разбора инцидентов.
const COLS = `id, deal_id, kind, rail, provider, status, amount_kopecks, idempotence_key,
  provider_payment_id, provider_status, confirmation_url, qr_payload,
  claimed_at, succeeded_at, canceled_at, expires_at, created_at, updated_at`;

/** Статусы, которые частичный уникальный индекс считает «живыми». */
const LIVE_STATUSES: readonly PaymentStatus[] = ['pending', 'claimed', 'succeeded'];

type PaymentRow = {
  id: number;
  deal_id: number;
  kind: PaymentKind;
  rail: PaymentRail;
  provider: PaymentProvider;
  status: PaymentStatus;
  amount_kopecks: number;
  idempotence_key: string;
  provider_payment_id: string | null;
  provider_status: string | null;
  confirmation_url: string | null;
  qr_payload: string | null;
  claimed_at: Date | null;
  succeeded_at: Date | null;
  canceled_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function mapPayment(r: PaymentRow): Payment {
  return {
    id: r.id,
    dealId: r.deal_id,
    kind: r.kind,
    rail: r.rail,
    provider: r.provider,
    status: r.status,
    amountKopecks: r.amount_kopecks,
    idempotenceKey: r.idempotence_key,
    providerPaymentId: r.provider_payment_id,
    providerStatus: r.provider_status,
    confirmationUrl: r.confirmation_url,
    qrPayload: r.qr_payload,
    claimedAt: r.claimed_at,
    succeededAt: r.succeeded_at,
    canceledAt: r.canceled_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function create(
  q: Queryable,
  a: {
    dealId: number;
    kind: PaymentKind;
    rail: PaymentRail;
    provider: PaymentProvider;
    amountKopecks: number;
    idempotenceKey: string;
    expiresAt?: Date | null;
  },
): Promise<Payment> {
  const res = await q.query<PaymentRow>(
    `INSERT INTO payments (deal_id, kind, rail, provider, amount_kopecks, idempotence_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLS}`,
    [a.dealId, a.kind, a.rail, a.provider, a.amountKopecks, a.idempotenceKey, a.expiresAt ?? null],
  );
  return mapPayment(res.rows[0]!);
}

export async function byId(q: Queryable, id: number): Promise<Payment | null> {
  const res = await q.query<PaymentRow>(`SELECT ${COLS} FROM payments WHERE id = $1`, [id]);
  return res.rows[0] ? mapPayment(res.rows[0]) : null;
}

/** Под блокировкой строки платежа: вебхук и опрос провайдера могут прийти одновременно (SPEC §9.6). */
export async function lockById(q: Queryable, id: number): Promise<Payment | null> {
  const res = await q.query<PaymentRow>(`SELECT ${COLS} FROM payments WHERE id = $1 FOR UPDATE`, [id]);
  return res.rows[0] ? mapPayment(res.rows[0]) : null;
}

export async function listByDeal(q: Queryable, dealId: number): Promise<Payment[]> {
  const res = await q.query<PaymentRow>(`SELECT ${COLS} FROM payments WHERE deal_id = $1 ORDER BY id`, [dealId]);
  return res.rows.map(mapPayment);
}

/** Живой платёж (pending|claimed|succeeded) по паре (сделка, вид) — его защищает частичный уникальный индекс. */
export async function live(q: Queryable, dealId: number, kind: PaymentKind): Promise<Payment | null> {
  const res = await q.query<PaymentRow>(
    `SELECT ${COLS} FROM payments
     WHERE deal_id = $1 AND kind = $2 AND status = ANY($3::text[])`,
    [dealId, kind, LIVE_STATUSES as readonly string[]],
  );
  return res.rows[0] ? mapPayment(res.rows[0]) : null;
}

export async function byProviderPaymentId(
  q: Queryable,
  provider: PaymentProvider,
  providerPaymentId: string,
): Promise<Payment | null> {
  const res = await q.query<PaymentRow>(
    `SELECT ${COLS} FROM payments WHERE provider = $1 AND provider_payment_id = $2`,
    [provider, providerPaymentId],
  );
  return res.rows[0] ? mapPayment(res.rows[0]) : null;
}

export type PaymentPatch = Partial<
  Pick<
    Payment,
    | 'status'
    | 'providerPaymentId'
    | 'providerStatus'
    | 'confirmationUrl'
    | 'qrPayload'
    | 'claimedAt'
    | 'succeededAt'
    | 'canceledAt'
    | 'expiresAt'
  >
> & { raw?: unknown };

/** Явная карта полей патча в колонки — без автопреобразования имён. */
const PATCH_COLUMNS: { readonly [K in keyof Required<PaymentPatch>]: string } = {
  status: 'status',
  providerPaymentId: 'provider_payment_id',
  providerStatus: 'provider_status',
  confirmationUrl: 'confirmation_url',
  qrPayload: 'qr_payload',
  claimedAt: 'claimed_at',
  succeededAt: 'succeeded_at',
  canceledAt: 'canceled_at',
  expiresAt: 'expires_at',
  raw: 'raw',
};

export async function update(q: Queryable, id: number, patch: PaymentPatch): Promise<Payment> {
  const sets: string[] = [];
  const params: unknown[] = [id];

  for (const key of Object.keys(PATCH_COLUMNS) as (keyof PaymentPatch)[]) {
    if (!(key in patch)) continue;
    if (key === 'raw') {
      params.push(JSON.stringify(patch.raw ?? null));
      sets.push(`raw = $${params.length}::jsonb`);
      continue;
    }
    params.push(patch[key] ?? null);
    sets.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
  }

  if (sets.length === 0) {
    const current = await byId(q, id);
    if (!current) throw new Error(`payments.update: платёж ${id} не найден`);
    return current;
  }

  const res = await q.query<PaymentRow>(
    `UPDATE payments SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
    params,
  );
  if (!res.rows[0]) throw new Error(`payments.update: платёж ${id} не найден`);
  return mapPayment(res.rows[0]);
}

/**
 * Для опроса провайдера планировщиком (SPEC §10.3): rail=link, status=pending,
 * создан > 30 с назад, не опрашивался 60 с (метка опроса — updated_at).
 * Истёкший expires_at здесь не отсекается: домен по нему переводит платёж в `expired`.
 */
export async function dueForPolling(q: Queryable, now: Date, limit: number): Promise<Payment[]> {
  const res = await q.query<PaymentRow>(
    `SELECT ${COLS} FROM payments
     WHERE rail = 'link'
       AND status = 'pending'
       AND created_at < $1::timestamptz - interval '30 seconds'
       AND updated_at < $1::timestamptz - interval '60 seconds'
     ORDER BY updated_at
     LIMIT $2`,
    [now, limit],
  );
  return res.rows.map(mapPayment);
}
