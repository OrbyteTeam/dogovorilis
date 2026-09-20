// Планировщик и ожидание ввода: то, что в ЗАДАЧА_01 обязано быть НАСТОЯЩИМ (планирование, истечение срока)
// и то, что намеренно отложено (отправка напоминаний — ЗАДАЧА_03).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { tick } from '../src/scheduler/index.js';
import { cardMid, createHarness, dealStatus, onlyDealPublicId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const SELLER = 4001;
const SELLER_CHAT = 7001;

describe.skipIf(!DB)('планировщик и ожидание ввода', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(DB!);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await truncateAll();
    h.max.reset();
  });

  async function demoDeal(): Promise<string> {
    await h.start(SELLER, SELLER_CHAT);
    await h.press(SELLER, SELLER_CHAT, 'dm:new');
    return onlyDealPublicId(h);
  }

  it('напоминания материализуются в таблицу при создании сделки (§10.1)', async () => {
    const id = await demoDeal();
    const rows = await h.query<{ kind: string; recipient_role: string; status: string }>(
      `SELECT r.kind, r.recipient_role, r.status FROM reminders r JOIN deals d ON d.id = r.deal_id
       WHERE d.public_id = $1 ORDER BY r.kind`,
      [id],
    );
    // Клиент в демо уже привязан, поэтому client_not_opened не планируется — остаётся срок подтверждения
    expect(rows.map((r) => r.kind)).toContain('confirmation_expired');
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('при смене статуса старый набор отменяется и создаётся новый (§10.1)', async () => {
    const id = await demoDeal();
    const clientCard = await cardMid(h, id, 'client_demo');
    await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);

    const rows = await h.query<{ kind: string; status: string }>(
      `SELECT r.kind, r.status FROM reminders r JOIN deals d ON d.id = r.deal_id WHERE d.public_id = $1`,
      [id],
    );
    const pending = rows.filter((r) => r.status === 'pending').map((r) => r.kind);
    const cancelled = rows.filter((r) => r.status === 'cancelled').map((r) => r.kind);
    expect(cancelled).toContain('confirmation_expired'); // набор прежнего статуса отменён
    expect(pending).toEqual(expect.arrayContaining(['prepayment_due', 'prepayment_overdue']));
  });

  it('планировщик НЕ отправляет напоминания в этой задаче, но помечает их обработанными', async () => {
    const id = await demoDeal();
    const clientCard = await cardMid(h, id, 'client_demo');
    await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);

    // Сдвигаем срок в прошлое — так тик увидит напоминание готовым
    await h.query(
      `UPDATE reminders SET due_at = now() - interval '1 minute'
       WHERE kind = 'prepayment_due' AND deal_id = (SELECT id FROM deals WHERE public_id = $1)`,
      [id],
    );
    h.max.reset();

    await tick({ max: null, sendReminders: false });

    expect(h.max.sent).toHaveLength(0); // отправки нет — она включается в ЗАДАЧА_03
    const row = await h.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM reminders WHERE kind = 'prepayment_due'
       AND deal_id = (SELECT id FROM deals WHERE public_id = $1)`,
      [id],
    );
    expect(row[0].status).toBe('cancelled');
    expect(row[0].last_error).toBe('sending_disabled');
  });

  it('истечение срока подтверждения выполняет T8 по-настоящему и уведомляет обе стороны', async () => {
    const id = await demoDeal();
    await h.query(
      `UPDATE reminders SET due_at = now() - interval '1 minute'
       WHERE kind = 'confirmation_expired' AND deal_id = (SELECT id FROM deals WHERE public_id = $1)`,
      [id],
    );
    h.max.reset();

    await tick({ max: h.gateway, sendReminders: false });

    expect(await dealStatus(h, id)).toBe('expired');
    expect(h.max.texts().join('\n')).toContain('Срок подтверждения');
    const events = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM deal_events e JOIN deals d ON d.id = e.deal_id
       WHERE d.public_id = $1 AND e.type = 'deal.expired'`,
      [id],
    );
    expect(events[0].n).toBe(1);
  });

  it('напоминание отменяется, если статус сделки уже изменился (§10.1)', async () => {
    const id = await demoDeal();
    const clientCard = await cardMid(h, id, 'client_demo');
    await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);

    // Делаем напоминание готовым, но подменяем dedupe_key на «из прошлого статуса»
    await h.query(
      `UPDATE reminders SET due_at = now() - interval '1 minute',
         dedupe_key = dedupe_key || ':stale'
       WHERE kind = 'prepayment_due' AND deal_id = (SELECT id FROM deals WHERE public_id = $1)`,
      [id],
    );
    await tick({ max: h.gateway, sendReminders: true });

    const row = await h.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM reminders WHERE kind = 'prepayment_due'
       AND deal_id = (SELECT id FROM deals WHERE public_id = $1)`,
      [id],
    );
    expect(row[0].status).toBe('cancelled');
    expect(row[0].last_error).toBe('state_changed');
  });

  it('просроченное ожидание ввода → E8, ввод сбрасывается', async () => {
    const id = await demoDeal();
    const clientCard = await cardMid(h, id, 'client_demo');
    await h.press(SELLER, SELLER_CHAT, `cr:${id}`, clientCard); // ждём текст изменений

    // 30 минут прошли
    await h.query(`UPDATE user_inputs SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [SELLER]);
    h.max.reset();

    await h.say(SELLER, SELLER_CHAT, 'давайте 15:00');

    expect(h.max.texts().join('\n')).toContain(texts.E8);
    expect(await dealStatus(h, id)).toBe('awaiting_confirmation'); // состояние не изменилось
    const left = await h.query<{ n: number }>('SELECT count(*)::int AS n FROM user_inputs WHERE user_id = $1', [SELLER]);
    expect(left[0].n).toBe(0);
  });

  it('тик чистит просроченные ожидания ввода', async () => {
    const id = await demoDeal();
    const clientCard = await cardMid(h, id, 'client_demo');
    await h.press(SELLER, SELLER_CHAT, `cr:${id}`, clientCard);
    await h.query(`UPDATE user_inputs SET expires_at = now() - interval '1 hour' WHERE user_id = $1`, [SELLER]);

    await tick({ max: null, sendReminders: false });

    const left = await h.query<{ n: number }>('SELECT count(*)::int AS n FROM user_inputs');
    expect(left[0].n).toBe(0);
  });

  it('/cancel сбрасывает ожидание ввода', async () => {
    const id = await demoDeal();
    const clientCard = await cardMid(h, id, 'client_demo');
    await h.press(SELLER, SELLER_CHAT, `cr:${id}`, clientCard);
    h.max.reset();

    await h.say(SELLER, SELLER_CHAT, '/cancel');

    expect(h.max.texts().join('\n')).toContain(texts.INPUT_CANCELLED);
    const left = await h.query<{ n: number }>('SELECT count(*)::int AS n FROM user_inputs');
    expect(left[0].n).toBe(0);
  });
});
