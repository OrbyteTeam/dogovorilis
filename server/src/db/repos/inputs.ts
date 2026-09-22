// Таблица user_inputs — ожидаемый ввод пользователя вместо in-memory session SDK (SPEC §8, §6).
import type { Queryable } from '../pool.js';
import type { InputKind, UserInput } from '../../types.js';

const COLS = 'user_id, kind, deal_id, created_at, expires_at';

type InputRow = {
  user_id: number;
  kind: InputKind;
  deal_id: number | null;
  created_at: Date;
  expires_at: Date;
};

function mapInput(r: InputRow): UserInput {
  return { userId: r.user_id, kind: r.kind, dealId: r.deal_id, createdAt: r.created_at, expiresAt: r.expires_at };
}

/** Ожидание ввода: одна запись на пользователя (PK user_id) — новая перекрывает старую. */
export async function set(
  q: Queryable,
  a: { userId: number; kind: InputKind; dealId: number | null; expiresAt: Date },
): Promise<UserInput> {
  const res = await q.query<InputRow>(
    `INSERT INTO user_inputs (user_id, kind, deal_id, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       kind       = EXCLUDED.kind,
       deal_id    = EXCLUDED.deal_id,
       created_at = now(),
       expires_at = EXCLUDED.expires_at
     RETURNING ${COLS}`,
    [a.userId, a.kind, a.dealId, a.expiresAt],
  );
  return mapInput(res.rows[0]!);
}

/** Просрочку проверяет домен (текст E8), репозиторий отдаёт запись как есть. */
export async function get(q: Queryable, userId: number): Promise<UserInput | null> {
  const res = await q.query<InputRow>(`SELECT ${COLS} FROM user_inputs WHERE user_id = $1`, [userId]);
  return res.rows[0] ? mapInput(res.rows[0]) : null;
}

export async function clear(q: Queryable, userId: number): Promise<void> {
  await q.query(`DELETE FROM user_inputs WHERE user_id = $1`, [userId]);
}

/** Снять конкретное ожидание по сделке (например, причину отмены после «Не отменять»), не трогая чужие. */
export async function clearIf(q: Queryable, a: { userId: number; kind: InputKind; dealId: number }): Promise<void> {
  await q.query(`DELETE FROM user_inputs WHERE user_id = $1 AND kind = $2 AND deal_id = $3`, [a.userId, a.kind, a.dealId]);
}

export async function deleteExpired(q: Queryable, now: Date): Promise<number> {
  const res = await q.query(`DELETE FROM user_inputs WHERE expires_at <= $1`, [now]);
  return res.rowCount ?? 0;
}
