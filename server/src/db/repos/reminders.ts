// Таблица reminders — материализованные напоминания планировщика (SPEC §10).
import type { Queryable } from '../pool.js';
import type { Reminder, ReminderKind, ReminderStatus } from '../../types.js';

const COLS = 'id, deal_id, user_id, kind, recipient_role, due_at, dedupe_key, status, attempts, last_error, sent_at';

type ReminderRow = {
  id: number;
  deal_id: number | null;
  user_id: number | null;
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
    userId: r.user_id,
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

// ─────────────────────── утренняя сводка (daily_digest, ЗАДАЧА_04 B2) ───────────────────────

/**
 * Запланировать сегодняшнюю сводку всем исполнителям, у кого она включена, момент сводки ещё впереди и на сегодня
 * есть записи в нужных статусах. Выборка начинается со сделок по статусу (deals_status_idx), поэтому каждый тик дешёвый.
 * Срок считается в поясе приложения: `(дата + digest_time минут) AT TIME ZONE tz` — так 08:00 остаётся 08:00 по МСК.
 * NOT EXISTS — чтобы повторные тики не тратили значения последовательности id; ON CONFLICT — страховка от гонки.
 * Строку, которую уже отправили или погасили, тик не трогает: «один раз в день» держит dedupe_key.
 */
export async function planDigests(
  q: Queryable,
  a: { dayStart: Date; dayEnd: Date; dateKey: string; now: Date; timezone: string; statuses: readonly string[] },
): Promise<number> {
  const res = await q.query(
    `WITH sellers AS (
       SELECT DISTINCT d.seller_user_id AS user_id
       FROM deals d
       JOIN deal_versions v ON v.deal_id = d.id AND v.version = d.current_version
       WHERE d.status = ANY($5::text[]) AND v.scheduled_at >= $1 AND v.scheduled_at < $2
     ), due AS (
       SELECT sp.user_id,
              (($3::date + make_interval(mins => sp.digest_time::int)) AT TIME ZONE $6::text) AS due_at,
              'digest:' || sp.user_id || ':' || $3::text AS dedupe_key
       FROM sellers s
       JOIN seller_profiles sp ON sp.user_id = s.user_id
       WHERE sp.digest_time IS NOT NULL
     )
     INSERT INTO reminders (deal_id, user_id, kind, recipient_role, due_at, dedupe_key)
     SELECT NULL, due.user_id, 'daily_digest', 'seller', due.due_at, due.dedupe_key
     FROM due
     WHERE due.due_at > $4
       AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.dedupe_key = due.dedupe_key)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [a.dayStart, a.dayEnd, a.dateKey, a.now, [...a.statuses], a.timezone],
  );
  return res.rowCount ?? 0;
}

/** Причины, по которым сводку гасит смена настроек — только такую строку можно снова включить в тот же день. */
export const DIGEST_SETTING_REASONS = ['digest_off', 'digest_passed'] as const;

/**
 * Время сводки изменили: сегодняшняя строка (ждущая или погашенная настройками) переносится на новый срок.
 * Отправленную или погашенную по делу («пусто», «нет диалога») не трогаем — второй сводки за день не будет.
 */
export async function moveDigest(q: Queryable, dedupeKey: string, dueAt: Date): Promise<number> {
  const res = await q.query(
    `UPDATE reminders SET due_at = $2, status = 'pending', attempts = 0, last_error = NULL
     WHERE dedupe_key = $1
       AND (status = 'pending' OR (status = 'cancelled' AND last_error = ANY($3::text[])))`,
    [dedupeKey, dueAt, [...DIGEST_SETTING_REASONS]],
  );
  return res.rowCount ?? 0;
}

/** Сводку выключили или новое время уже прошло — сегодняшняя ждущая строка гасится. */
export async function cancelDigest(q: Queryable, dedupeKey: string, reason: (typeof DIGEST_SETTING_REASONS)[number]): Promise<number> {
  const res = await q.query(
    `UPDATE reminders SET status = 'cancelled', last_error = $2 WHERE dedupe_key = $1 AND status = 'pending'`,
    [dedupeKey, reason],
  );
  return res.rowCount ?? 0;
}

export async function byDedupeKey(q: Queryable, dedupeKey: string): Promise<Reminder | null> {
  const res = await q.query<ReminderRow>(`SELECT ${COLS} FROM reminders WHERE dedupe_key = $1`, [dedupeKey]);
  return res.rows[0] ? mapReminder(res.rows[0]) : null;
}
