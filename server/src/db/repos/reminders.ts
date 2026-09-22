// Таблица reminders — материализованные напоминания планировщика (SPEC §10).
import type { Queryable } from '../pool.js';
import type { Reminder, ReminderKind, ReminderStatus } from '../../types.js';

const COLS = 'id, deal_id, kind, recipient_role, due_at, dedupe_key, status, attempts, last_error, sent_at';

type ReminderRow = {
  id: number;
  deal_id: number;
  kind: ReminderKind;
  recipient_role: 'seller' | 'client';
  due_at: Date;
  dedupe_key: string;
  status: ReminderStatus;
  attempts: number;
  last_error: string | null;
  sent_at: Date | null;
};

function mapReminder(r: ReminderRow): Reminder {
  return {
    id: r.id,
    dealId: r.deal_id,
    kind: r.kind,
    recipientRole: r.recipient_role,
    dueAt: r.due_at,
    dedupeKey: r.dedupe_key,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    sentAt: r.sent_at,
  };
}

export type PlannedReminder = {
  kind: ReminderKind;
  recipientRole: 'seller' | 'client';
  dueAt: Date;
  dedupeKey: string;
};

/**
 * Материализация набора (SPEC §10.1). Уникальный dedupe_key защищает от дублей; строка с тем же ключом:
 * - погашенная перепланированием (`cancelled` + `replanned`) — оживает: pending, новый срок, попытки с нуля;
 * - любая другая (pending, sent, failed, погашенная планировщиком по state_changed / no_chat / sending_disabled) —
 *   не трогается: отправленное не уходит второй раз, а отменённое по делу не воскресает.
 * Возвращает число вставленных и оживлённых строк.
 */
export async function planMany(q: Queryable, dealId: number, items: PlannedReminder[]): Promise<number> {
  if (items.length === 0) return 0;
  const res = await q.query(
    `INSERT INTO reminders (deal_id, kind, recipient_role, due_at, dedupe_key)
     SELECT $1, t.kind, t.recipient_role, t.due_at, t.dedupe_key
     FROM unnest($2::text[], $3::text[], $4::timestamptz[], $5::text[])
       AS t(kind, recipient_role, due_at, dedupe_key)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET status = 'pending', due_at = EXCLUDED.due_at, attempts = 0, last_error = NULL
       WHERE reminders.status = 'cancelled' AND reminders.last_error = 'replanned'`,
    [
      dealId,
      items.map((i) => i.kind),
      items.map((i) => i.recipientRole),
      items.map((i) => i.dueAt),
      items.map((i) => i.dedupeKey),
    ],
  );
  return res.rowCount ?? 0;
}

/**
 * При переходе гасятся pending этой сделки, которых нет в новом наборе (SPEC §10.1). Ключи из нового набора
 * не трогаем: у перехода без смены статуса (T2) ключ тот же, и погасить-и-вставить заново его было бы нельзя.
 */
export async function cancelPendingExcept(q: Queryable, dealId: number, keepKeys: string[], reason: string): Promise<number> {
  const res = await q.query(
    `UPDATE reminders SET status = 'cancelled', last_error = $3
     WHERE deal_id = $1 AND status = 'pending' AND NOT (dedupe_key = ANY($2::text[]))`,
    [dealId, keepKeys, reason],
  );
  return res.rowCount ?? 0;
}

/** Порция готовых к отправке: status=pending, due_at <= now, FOR UPDATE SKIP LOCKED (SPEC §10.1). */
export async function claimDue(q: Queryable, now: Date, limit: number): Promise<Reminder[]> {
  const res = await q.query<ReminderRow>(
    `SELECT ${COLS} FROM reminders
     WHERE status = 'pending' AND due_at <= $1
     ORDER BY due_at
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [now, limit],
  );
  return res.rows.map(mapReminder);
}

export async function markSent(q: Queryable, id: number): Promise<void> {
  await q.query(
    `UPDATE reminders SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1`,
    [id],
  );
}

/**
 * Неудачная попытка, но не финальная: статус остаётся pending, attempts растёт.
 * SPEC §10.1 — «3 попытки, потом failed»; решение о финале принимает планировщик.
 */
export async function markRetry(q: Queryable, id: number, error: string): Promise<number> {
  const { rows } = await q.query<{ attempts: number }>(
    `UPDATE reminders SET attempts = attempts + 1, last_error = $2 WHERE id = $1 RETURNING attempts`,
    [id, error.slice(0, 500)],
  );
  return rows[0]?.attempts ?? 0;
}

export async function markFailed(q: Queryable, id: number, error: string): Promise<void> {
  await q.query(
    `UPDATE reminders SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1`,
    [id, error],
  );
}

/** Отмена конкретного напоминания: статус сделки уже не тот, для которого оно создано (SPEC §10.1). */
export async function markCancelled(q: Queryable, id: number, reason: string): Promise<void> {
  await q.query(`UPDATE reminders SET status = 'cancelled', last_error = $2 WHERE id = $1`, [id, reason]);
}

export async function listByDeal(q: Queryable, dealId: number): Promise<Reminder[]> {
  const res = await q.query<ReminderRow>(
    `SELECT ${COLS} FROM reminders WHERE deal_id = $1 ORDER BY due_at, id`,
    [dealId],
  );
  return res.rows.map(mapReminder);
}
