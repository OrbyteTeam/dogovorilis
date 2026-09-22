// Планировщик и ожидание ввода (SPEC §10, §6.6): планирование, отправка напоминаний нужной стороне,
// ускоренные напоминания демо-сделки, истечение срока подтверждения (T8).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { tick } from '../src/scheduler/index.js';
import type { MaxGateway } from '../src/integrations/max/gateway.js';
import { cardMid, createHarness, dealStatus, livePaymentId, onlyDealPublicId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const SELLER = 4001;
const SELLER_CHAT = 7001;
const CLIENT = 4002;
const CLIENT_CHAT = 7002;
const MINUTE = 60_000;

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

  /** Настоящая сделка двух людей: исполнитель создаёт через API мини-приложения, клиент входит по ссылке (T2). */
  async function realDeal(): Promise<string> {
    await h.start(SELLER, SELLER_CHAT);
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'beauty',
      title: 'Маникюр с покрытием',
      total_rub: 2500,
      prepayment_rub: 500,
      scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      cancel_rule: 'free_24h',
      profile: {
        display_name: 'Анна Мастер',
        tax_mode: 'npd',
        payout_details: 'СБП +7 900 000-00-00, Т-Банк',
        transfer_enabled: true,
        link_enabled: false,
        default_cancel_rule: 'free_24h',
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const id = res.json.deal.public_id as string;
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    return id;
  }

  type ReminderRow = { status: string; last_error: string | null; attempts: number; due_at: Date; recipient_role: string };

  async function reminder(id: string, kind: string): Promise<ReminderRow> {
    const rows = await h.query<ReminderRow>(
      `SELECT r.status, r.last_error, r.attempts, r.due_at, r.recipient_role FROM reminders r JOIN deals d ON d.id = r.deal_id
       WHERE d.public_id = $1 AND r.kind = $2 ORDER BY r.id DESC LIMIT 1`,
      [id, kind],
    );
    if (!rows[0]) throw new Error(`нет напоминания ${kind} у ${id}`);
    return rows[0];
  }

  async function makeDue(id: string, kind: string): Promise<void> {
    await h.query(
      `UPDATE reminders SET due_at = now() - interval '1 minute'
       WHERE kind = $2 AND status = 'pending' AND deal_id = (SELECT id FROM deals WHERE public_id = $1)`,
      [id, kind],
    );
  }

  async function statusChangedAt(id: string): Promise<Date> {
    const rows = await h.query<{ status_changed_at: Date }>('SELECT status_changed_at FROM deals WHERE public_id = $1', [id]);
    return rows[0].status_changed_at;
  }

  /** Демо-сделка одним аккаунтом до «Выполнено»: предоплата переводом, как в README §11 вариант А. */
  async function demoToAcceptance(): Promise<{ id: string; clientCard: string; sellerCard: string }> {
    const id = await demoDeal();
    const clientCard = await cardMid(h, id, 'client_demo');
    const sellerCard = await cardMid(h, id, 'seller');
    await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `pt:${id}`, clientCard);
    const p1 = await livePaymentId(h, id, 'prepayment');
    await h.press(SELLER, SELLER_CHAT, `tr:c:${id}:${p1}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${p1}`, sellerCard);
    await h.press(SELLER, SELLER_CHAT, `dn:${id}`, sellerCard);
    expect(await dealStatus(h, id)).toBe('awaiting_acceptance');
    return { id, clientCard, sellerCard };
  }

  /** …и дальше до «Оплачено»: приёмка и остаток переводом. */
  async function demoToPaid(): Promise<string> {
    const { id, clientCard, sellerCard } = await demoToAcceptance();
    await h.press(SELLER, SELLER_CHAT, `ac:${id}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `pt:${id}`, clientCard);
    const p2 = await livePaymentId(h, id, 'final');
    await h.press(SELLER, SELLER_CHAT, `tr:c:${id}:${p2}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${p2}`, sellerCard);
    expect(await dealStatus(h, id)).toBe('paid');
    return id;
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

  it('режим sendReminders=false (тесты, отладка): напоминание не уходит, но помечается обработанным', async () => {
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

    expect(h.max.sent).toHaveLength(0);
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

  describe('отправка напоминаний (SPEC §10.2)', () => {
    it('уходит нужной стороне с кнопкой «Открыть», помечается sent, повторный тик не шлёт второй раз', async () => {
      const id = await realDeal();
      await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, await cardMid(h, id, 'client'));
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');
      await makeDue(id, 'prepayment_due'); // клиенту: «предоплата ещё не внесена»
      h.max.reset();

      await tick({ max: h.gateway, sendReminders: true });

      const toClient = h.max.inChat(CLIENT_CHAT);
      expect(toClient).toHaveLength(1);
      expect(toClient[0].text).toBe(
        texts.reminderText('prepayment_due', { id, title: '', sumKopecks: 50_000, scheduledAt: null, deadline: null }),
      );
      expect(toClient[0].buttons.map((b) => b.text)).toEqual([texts.BTN.open]);
      expect(toClient[0].buttons[0].payload).toBe(`op:${id}`);
      expect(h.max.inChat(SELLER_CHAT)).toHaveLength(0); // исполнителю это напоминание не адресовано
      expect((await reminder(id, 'prepayment_due')).status).toBe('sent');

      h.max.reset();
      await tick({ max: h.gateway, sendReminders: true });
      expect(h.max.sent).toHaveLength(0);
    });

    it('исполнителю — в его чат (prepayment_overdue)', async () => {
      const id = await realDeal();
      await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, await cardMid(h, id, 'client'));
      await makeDue(id, 'prepayment_overdue');
      h.max.reset();

      await tick({ max: h.gateway, sendReminders: true });

      expect(h.max.inChat(CLIENT_CHAT)).toHaveLength(0);
      const toSeller = h.max.inChat(SELLER_CHAT);
      expect(toSeller).toHaveLength(1);
      expect(toSeller[0].text).toContain(`Предоплата по #${id} не получена 2 дня`);
      expect(toSeller[0].buttons.map((b) => b.text)).toEqual([texts.BTN.open]);
    });

    it('отправка упала — напоминание остаётся pending и уходит на следующем тике', async () => {
      const id = await realDeal();
      await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, await cardMid(h, id, 'client'));
      await makeDue(id, 'prepayment_due');
      const broken: MaxGateway = {
        ...h.gateway,
        send: async () => {
          throw new Error('fetch failed');
        },
      };

      await tick({ max: broken, sendReminders: true });
      let row = await reminder(id, 'prepayment_due');
      expect(row.status).toBe('pending'); // не «no_chat»: писать есть куда, подвела сеть — повтор поможет
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe('fetch failed');

      h.max.reset();
      await tick({ max: h.gateway, sendReminders: true });
      row = await reminder(id, 'prepayment_due');
      expect(row.status).toBe('sent');
      expect(h.max.inChat(CLIENT_CHAT)).toHaveLength(1);
    });

    it('у клиента нет диалога с ботом — напоминание гасится no_chat, тик не падает', async () => {
      const id = await realDeal();
      await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, await cardMid(h, id, 'client'));
      await h.query('UPDATE users SET dialog_chat_id = NULL WHERE max_user_id = $1', [CLIENT]);
      await makeDue(id, 'prepayment_due');
      h.max.reset();

      await tick({ max: h.gateway, sendReminders: true });

      expect(h.max.sent).toHaveLength(0);
      const row = await reminder(id, 'prepayment_due');
      expect(row.status).toBe('cancelled');
      expect(row.last_error).toBe('no_chat');
    });

    it('у настоящей сделки приёмка напоминается клиенту через 24 ч и без пометки демо', async () => {
      const id = await realDeal();
      const clientCard = await cardMid(h, id, 'client');
      const sellerCard = await cardMid(h, id, 'seller');
      await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
      await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
      const p1 = await livePaymentId(h, id, 'prepayment');
      await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${p1}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${p1}`, sellerCard);
      await h.press(SELLER, SELLER_CHAT, `dn:${id}`, sellerCard);
      expect(await dealStatus(h, id)).toBe('awaiting_acceptance');

      const row = await reminder(id, 'acceptance_due');
      expect(row.recipient_role).toBe('client');
      expect(row.due_at.getTime() - (await statusChangedAt(id)).getTime()).toBe(24 * 60 * MINUTE);

      await makeDue(id, 'acceptance_due');
      h.max.reset();
      await tick({ max: h.gateway, sendReminders: true });
      const toClient = h.max.inChat(CLIENT_CHAT);
      expect(toClient).toHaveLength(1);
      expect(toClient[0].text).toContain(`Исполнитель ждёт приёмку по #${id}`);
      expect(toClient[0].text).not.toContain(texts.DEMO_ACCELERATED_NOTE);
    });
  });

  describe('демо-сделка: напоминания ускорены, чтобы проверяющий их увидел', () => {
    it('receipt_due приходит исполнителю через 2 минуты после «Оплачено», с пометкой «в демо — ускорено»', async () => {
      const id = await demoToPaid();
      const paidAt = await statusChangedAt(id);
      const row = await reminder(id, 'receipt_due');
      expect(row.recipient_role).toBe('seller');
      expect(row.due_at.getTime() - paidAt.getTime()).toBe(2 * MINUTE);

      // Через минуту ещё рано
      h.max.reset();
      await tick({ max: h.gateway, sendReminders: true }, new Date(paidAt.getTime() + MINUTE));
      expect(h.max.sent).toHaveLength(0);

      // Через 2,5 минуты — пришло, с пометкой и кнопкой «Открыть»
      await tick({ max: h.gateway, sendReminders: true }, new Date(paidAt.getTime() + 2.5 * MINUTE));
      const got = h.max.inChat(SELLER_CHAT);
      expect(got).toHaveLength(1);
      expect(got[0].text.startsWith(texts.demoNotifyPrefix('seller'))).toBe(true);
      expect(got[0].text).toContain(`Не забудьте чек по #${id}`);
      expect(got[0].text).toContain('🧪 в демо — ускорено');
      expect(got[0].buttons.map((b) => b.text)).toEqual([texts.BTN.open]);
      expect((await reminder(id, 'receipt_due')).status).toBe('sent');
    });

    it('acceptance_due приходит «клиенту» через 2 минуты после «Выполнено»', async () => {
      const { id } = await demoToAcceptance();
      const doneAt = await statusChangedAt(id);
      expect((await reminder(id, 'acceptance_due')).due_at.getTime() - doneAt.getTime()).toBe(2 * MINUTE);
      h.max.reset();

      await tick({ max: h.gateway, sendReminders: true }, new Date(doneAt.getTime() + 2.5 * MINUTE));

      const got = h.max.inChat(SELLER_CHAT); // в демо обе стороны — один чат
      expect(got).toHaveLength(1);
      expect(got[0].text.startsWith(texts.demoNotifyPrefix('client'))).toBe(true);
      expect(got[0].text).toContain(`Исполнитель ждёт приёмку по #${id}`);
      expect(got[0].text).toContain(texts.DEMO_ACCELERATED_NOTE);
    });

    it('прочие сроки демо не ускорены: подтверждение — 72 ч, предоплата — сутки', async () => {
      const id = await demoDeal();
      const created = await statusChangedAt(id);
      expect((await reminder(id, 'confirmation_expired')).due_at.getTime() - created.getTime()).toBeGreaterThan(71 * 60 * MINUTE);

      await h.press(SELLER, SELLER_CHAT, `cf:${id}`, await cardMid(h, id, 'client_demo'));
      const confirmed = await statusChangedAt(id);
      expect((await reminder(id, 'prepayment_due')).due_at.getTime() - confirmed.getTime()).toBe(24 * 60 * MINUTE);
    });
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
