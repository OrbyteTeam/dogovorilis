// Таблица card_messages — mid карточки каждой стороны, чтобы обновлять сообщение на месте (SPEC §8).
import type { Queryable } from '../pool.js';
import type { CardMessage, CardRole } from '../../types.js';

const COLS = 'id, deal_id, user_id, role, chat_id, mid';

type CardRow = {
  id: number;
  deal_id: number;
  user_id: number;
  role: CardRole;
  chat_id: number;
  mid: string;
};

function mapCard(r: CardRow): CardMessage {
  return { id: r.id, dealId: r.deal_id, userId: r.user_id, role: r.role, chatId: r.chat_id, mid: r.mid };
}

/** Одна карточка на (сделка, пользователь, роль) — уникальный индекс; повторная отправка обновляет mid. */
export async function upsert(
  q: Queryable,
  a: { dealId: number; userId: number; role: CardRole; chatId: number; mid: string },
): Promise<CardMessage> {
  const res = await q.query<CardRow>(
    `INSERT INTO card_messages (deal_id, user_id, role, chat_id, mid)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (deal_id, user_id, role) DO UPDATE SET
       chat_id    = EXCLUDED.chat_id,
       mid        = EXCLUDED.mid,
       updated_at = now()
     RETURNING ${COLS}`,
    [a.dealId, a.userId, a.role, a.chatId, a.mid],
  );
  return mapCard(res.rows[0]!);
}

export async function byDeal(q: Queryable, dealId: number): Promise<CardMessage[]> {
  const res = await q.query<CardRow>(`SELECT ${COLS} FROM card_messages WHERE deal_id = $1 ORDER BY id`, [dealId]);
  return res.rows.map(mapCard);
}

export async function byDealAndRole(q: Queryable, dealId: number, role: CardRole): Promise<CardMessage | null> {
  const res = await q.query<CardRow>(
    `SELECT ${COLS} FROM card_messages WHERE deal_id = $1 AND role = $2 ORDER BY id LIMIT 1`,
    [dealId, role],
  );
  return res.rows[0] ? mapCard(res.rows[0]) : null;
}

/** Старая карточка не обновилась (сообщение удалено) — отправили новую, запомнили её mid (SPEC §8). */
export async function updateMid(q: Queryable, id: number, mid: string): Promise<void> {
  await q.query(`UPDATE card_messages SET mid = $2, updated_at = now() WHERE id = $1`, [id, mid]);
}

export async function remove(q: Queryable, id: number): Promise<void> {
  await q.query(`DELETE FROM card_messages WHERE id = $1`, [id]);
}
