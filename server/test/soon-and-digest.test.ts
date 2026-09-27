// «⏰ Через 30 минут» (event_soon) и утренняя сводка (daily_digest) — ЗАДАЧА_04 B, SPEC §10.2–10.3.
// Время управляемое: планирование — чистая функция с «сейчас» в аргументе, тик планировщика принимает `now`,
// а сделки для сводки назначены на послезавтра, чтобы проверка не зависела от часа запуска.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { formatMoney } from '../src/domain/money.js';
import { tick } from '../src/scheduler/index.js';
import { planReminders } from '../src/domain/reminder/plan.js';
import { dayOf, digestDueAt, digestKey, rescheduleDigest } from '../src/domain/reminder/digest.js';
import type { DealStatus } from '../src/types.js';
import { cardMid, createHarness, dealStatus, livePaymentId, onlyDealPublicId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const SELLER = 4501;
const SELLER_CHAT = 7501;
const CLIENT = 4502;
const CLIENT_CHAT = 7502;
const MINUTE = 60_000;
const TZ = 'Europe/Moscow';

describe('event_soon в плане напоминаний (чистая функция)', () => {
  const scheduledAt = new Date('2026-10-06T11:00:00Z'); // вт 6 окт, 14:00 МСК
  const plan = (status: DealStatus, now: Date, over: { scheduledAt?: Date | null; prepaymentKopecks?: number } = {}) =>
    planReminders({
      deal: {
        id: 7,
        status,
        statusChangedAt: new Date('2026-10-01T09:00:00Z'),
        clientUserId: 2,
        expiresAt: null,
        paidAt: null,
        demo: false,
        cancelRefundExpected: null,
        refundSentAt: null,
        refundReceivedAt: null,
      },
      version: {
        scheduledAt: over.scheduledAt === undefined ? scheduledAt : over.scheduledAt,
        prepaymentKopecks: over.prepaymentKopecks ?? 50_000,
        totalKopecks: 250_000,
        cancelRule: 'free_24h',
      },
      taxMode: 'npd',
      now,
    }).filter((r) => r.kind === 'event_soon');

  it('scheduled и awaiting_prepayment — обеим сторонам за 30 минут до срока', () => {
    for (const status of ['scheduled', 'awaiting_prepayment'] as const) {
      const soon = plan(status, new Date('2026-10-01T09:00:00Z'));
      expect(soon.map((r) => r.recipientRole).sort(), status).toEqual(['client', 'seller']);
      for (const r of soon) {
        expect(r.dueAt.getTime(), status).toBe(scheduledAt.getTime() - 30 * MINUTE);
        expect(r.dedupeKey).toBe(`7:event_soon:${r.recipientRole}:2026-10-01T09:00:00.000Z`);
      }
    }
  });

  it('в прошлом не планируется; без даты — тоже', () => {
    expect(plan('scheduled', new Date(scheduledAt.getTime() - 10 * MINUTE))).toEqual([]);
    expect(plan('scheduled', new Date('2026-10-01T09:00:00Z'), { scheduledAt: null })).toEqual([]);
  });

  it('в остальных статусах не планируется', () => {
    const others: DealStatus[] = ['awaiting_confirmation', 'changes_requested', 'awaiting_acceptance', 'remarks', 'awaiting_payment', 'paid', 'closed', 'cancelled'];
    for (const status of others) expect(plan(status, new Date('2026-10-01T09:00:00Z')), status).toEqual([]);
  });
});

describe('сутки и срок сводки по МСК (чистые функции)', () => {
  it('сутки считаются по МСК, а не по UTC', () => {
    const late = dayOf(new Date('2026-09-28T22:30:00Z'), TZ); // 01:30 МСК 29 сен
    expect(late.dateKey).toBe('2026-09-29');
    expect(late.start.toISOString()).toBe('2026-09-28T21:00:00.000Z');
    expect(late.end.toISOString()).toBe('2026-09-29T21:00:00.000Z');
    expect(dayOf(new Date('2026-09-30T21:00:00Z'), TZ).dateKey).toBe('2026-10-01'); // переход месяца
  });

  it('срок — digest_time минут от полуночи по МСК', () => {
    const day = dayOf(new Date('2026-09-29T03:00:00Z'), TZ);
    expect(digestDueAt(day, 480, TZ).toISOString()).toBe('2026-09-29T05:00:00.000Z'); // 08:00 МСК
    expect(digestDueAt(day, 390, TZ).toISOString()).toBe('2026-09-29T03:30:00.000Z'); // 06:30 МСК
    expect(digestKey(42, day.dateKey)).toBe('digest:42:2026-09-29');
  });
});

describe.skipIf(!DB)('event_soon и утренняя сводка: планировщик и API', () => {
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

  const PROFILE = {
    display_name: 'Анна Мастер',
    tax_mode: 'npd',
    payout_details: 'СБП +7 900 000-00-00, Т-Банк',
    transfer_enabled: true,
    link_enabled: false,
    default_cancel_rule: 'free_24h',
  };

  async function createDeal(o: { at: Date; prepaymentRub?: number; title?: string; seller?: number }): Promise<string> {
    const res = await h.api('POST', '/api/deals', o.seller ?? SELLER, {
      template: 'beauty',
      title: o.title ?? 'Маникюр с покрытием',
      total_rub: 2500,
      prepayment_rub: o.prepaymentRub ?? 500,
      scheduled_at: o.at.toISOString(),
      cancel_rule: 'free_24h',
      profile: PROFILE,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.deal.public_id as string;
  }

  /** Настоящая сделка двух людей, подтверждённая клиентом. */
  async function confirmedDeal(o: { at: Date; prepaymentRub?: number }): Promise<string> {
    await h.start(SELLER, SELLER_CHAT);
    const id = await createDeal(o);
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, await cardMid(h, id, 'client'));
    return id;
  }

  type Row = { status: string; last_error: string | null; due_at: Date; recipient_role: string; deal_id: number | null; user_id: number | null; dedupe_key: string };

  async function reminders(kind: string, id?: string): Promise<Row[]> {
    return h.query<Row>(
      `SELECT r.status, r.last_error, r.due_at, r.recipient_role, r.deal_id, r.user_id, r.dedupe_key FROM reminders r
       LEFT JOIN deals d ON d.id = r.deal_id
       WHERE r.kind = $1 AND ($2::text IS NULL OR d.public_id = $2) ORDER BY r.recipient_role, r.id`,
      [kind, id ?? null],
    );
  }

  async function makeDue(id: string, kind: string): Promise<void> {
    await h.query(
      `UPDATE reminders SET due_at = now() - interval '1 minute'
       WHERE kind = $2 AND status = 'pending' AND deal_id = (SELECT id FROM deals WHERE public_id = $1)`,
      [id, kind],
    );
  }

  describe('event_soon', () => {
    it('awaiting_prepayment: обеим сторонам, после предоплаты — перепланируется на scheduled одной парой', async () => {
      const at = new Date(Date.now() + 3 * 86_400_000);
      const id = await confirmedDeal({ at });
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');
      let rows = (await reminders('event_soon', id)).filter((r) => r.status === 'pending');
      expect(rows.map((r) => r.recipient_role)).toEqual(['client', 'seller']);
      for (const r of rows) expect(r.due_at.getTime()).toBe(at.getTime() - 30 * MINUTE);

      // Предоплата переводом: T9 → scheduled, набор прежнего статуса погашен, новый — снова обеим
      const clientCard = await cardMid(h, id, 'client');
      await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
      const p = await livePaymentId(h, id, 'prepayment');
      await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${p}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${p}`, await cardMid(h, id, 'seller'));
      expect(await dealStatus(h, id)).toBe('scheduled');
      rows = await reminders('event_soon', id);
      expect(rows.filter((r) => r.status === 'pending').map((r) => r.recipient_role)).toEqual(['client', 'seller']);
      expect(rows.filter((r) => r.status === 'cancelled').every((r) => r.last_error === 'replanned')).toBe(true);
    });

    it('уходит обеим сторонам: исполнителю — кто и что с предоплатой, клиенту — что и у кого; второй тик не повторяет', async () => {
      const id = await confirmedDeal({ at: new Date(Date.now() + 3 * 86_400_000) });
      await makeDue(id, 'event_soon');
      h.max.reset();

      await tick({ max: h.gateway, sendReminders: true });

      const toSeller = h.max.inChat(SELLER_CHAT);
      const toClient = h.max.inChat(CLIENT_CHAT);
      expect(toSeller).toHaveLength(1);
      expect(toClient).toHaveLength(1);
      expect(toSeller[0].text).toBe(`⏰ Через 30 минут: Пользователь${CLIENT} — Маникюр с покрытием. Предоплата: ждём ${formatMoney(50_000)}.`);
      expect(toClient[0].text).toBe('⏰ Через 30 минут — Маникюр с покрытием у Анна Мастер.');
      for (const m of [toSeller[0], toClient[0]]) {
        expect(m.buttons.map((b) => b.text)).toEqual([texts.BTN.open]);
        expect(m.buttons[0].payload).toBe(`op:${id}`);
      }
      expect((await reminders('event_soon', id)).every((r) => r.status === 'sent')).toBe(true);

      h.max.reset();
      await tick({ max: h.gateway, sendReminders: true });
      expect(h.max.sent).toHaveLength(0);
    });

    it('без предоплаты — сразу scheduled, исполнителю «Без предоплаты»', async () => {
      const id = await confirmedDeal({ at: new Date(Date.now() + 3 * 86_400_000), prepaymentRub: 0 });
      expect(await dealStatus(h, id)).toBe('scheduled');
      await makeDue(id, 'event_soon');
      h.max.reset();
      await tick({ max: h.gateway, sendReminders: true });
      expect(h.max.inChat(SELLER_CHAT)[0].text).toContain('Маникюр с покрытием. Без предоплаты.');
    });

    it('срок уже наступил (сервер лежал) — гасится too_late и не отправляется', async () => {
      const id = await confirmedDeal({ at: new Date(Date.now() + 3 * 86_400_000) });
      await makeDue(id, 'event_soon');
      await h.query(
        `UPDATE deal_versions SET scheduled_at = now() - interval '5 minutes' WHERE deal_id = (SELECT id FROM deals WHERE public_id = $1)`,
        [id],
      );
      h.max.reset();

      await tick({ max: h.gateway, sendReminders: true });

      expect(h.max.sent.filter((m) => m.text.includes('Через 30 минут'))).toHaveLength(0);
      const rows = await reminders('event_soon', id);
      expect(rows.every((r) => r.status === 'cancelled' && r.last_error === 'too_late')).toBe(true);
    });

    it('клиент без диалога с ботом — его строка гасится no_chat, исполнителю уходит', async () => {
      const id = await confirmedDeal({ at: new Date(Date.now() + 3 * 86_400_000) });
      await h.query('UPDATE users SET dialog_chat_id = NULL WHERE max_user_id = $1', [CLIENT]);
      await makeDue(id, 'event_soon');
      h.max.reset();

      await tick({ max: h.gateway, sendReminders: true });

      const rows = await reminders('event_soon', id);
      expect(rows.find((r) => r.recipient_role === 'client')).toMatchObject({ status: 'cancelled', last_error: 'no_chat' });
      expect(rows.find((r) => r.recipient_role === 'seller')?.status).toBe('sent');
    });

    it('демо: обе стороны — в один чат, с префиксами получателя', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new');
      const id = await onlyDealPublicId(h);
      await h.press(SELLER, SELLER_CHAT, `cf:${id}`, await cardMid(h, id, 'client_demo'));
      await makeDue(id, 'event_soon');
      h.max.reset();

      await tick({ max: h.gateway, sendReminders: true });

      const got = h.max.inChat(SELLER_CHAT).map((m) => m.text).filter((t) => t.includes('Через 30 минут'));
      expect(got).toHaveLength(2);
      expect(got.some((t) => t.startsWith(texts.demoNotifyPrefix('seller')) && t.includes('демо-клиент'))).toBe(true);
      expect(got.some((t) => t.startsWith(texts.demoNotifyPrefix('client')))).toBe(true);
    });
  });

  describe('daily_digest', () => {
    // «Сегодня» сводки — послезавтра по МСК: сделки на этот день проходят проверку «не раньше чем через 30 минут»
    // в любое время запуска, а тик получает управляемое «сейчас» этого дня.
    const D = dayOf(new Date(Date.now() + 2 * 86_400_000), TZ);
    const at = (hour: number, minute = 0) => new Date(D.start.getTime() + (hour * 60 + minute) * MINUTE);

    /** Сделка на день D в нужном статусе: создаётся через API, статус и клиент ставятся напрямую — сводке важен только состав. */
    async function dayDeal(o: { hour: number; minute?: number; status: DealStatus; title: string; prepaymentRub?: number; client?: number | null; demo?: boolean; seller?: number }) {
      const id = await createDeal({ at: at(o.hour, o.minute), title: o.title, prepaymentRub: o.prepaymentRub, seller: o.seller });
      const seller = o.seller ?? SELLER;
      const client = o.demo ? seller : o.client === undefined ? CLIENT : o.client;
      if (client && client !== seller) {
        await h.query(`INSERT INTO users (max_user_id, first_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [client, `Пользователь${client}`]);
      }
      await h.query('UPDATE deals SET status = $2, client_user_id = $3, demo = $4 WHERE public_id = $1', [id, o.status, client, o.demo ?? false]);
      return id;
    }

    /** Все остальные напоминания гасим: тик с «сейчас» послезавтра иначе отправил бы и их. */
    async function onlyDigests(): Promise<void> {
      await h.query(`UPDATE reminders SET status = 'cancelled', last_error = 'test' WHERE kind <> 'daily_digest' AND status = 'pending'`);
    }

    async function digestRows(): Promise<Row[]> {
      return reminders('daily_digest');
    }

    const digests = () => h.max.sent.filter((m) => m.text.startsWith('📅 Сегодня'));

    it('тик планирует сводку исполнителю на 08:00 МСК, приходит один раз, второй тик не дублирует', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await dayDeal({ hour: 10, status: 'scheduled', title: 'Маникюр с покрытием' });
      await dayDeal({ hour: 18, minute: 30, status: 'awaiting_prepayment', title: 'Педикюр' });
      await dayDeal({ hour: 14, status: 'awaiting_acceptance', title: 'Брови', prepaymentRub: 0 });
      await dayDeal({ hour: 12, status: 'awaiting_confirmation', title: 'Не подтверждена' }); // не входит в сводку
      await onlyDigests();

      await tick({ max: h.gateway, sendReminders: true }, at(7));
      const rows = await digestRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'pending', recipient_role: 'seller', deal_id: null, user_id: SELLER, dedupe_key: `digest:${SELLER}:${D.dateKey}` });
      expect(rows[0].due_at.toISOString()).toBe(at(8).toISOString());
      expect(digests()).toHaveLength(0);

      await tick({ max: h.gateway, sendReminders: true }, at(8, 1));
      const sent = digests();
      expect(sent).toHaveLength(1);
      expect(sent[0].chatId).toBe(SELLER_CHAT);
      const lines = sent[0].text.split('\n');
      expect(lines[0]).toMatch(/^📅 Сегодня, [а-я]{2} \d{1,2} [а-я]{3} — 3 записи \(МСК\):$/);
      expect(lines.slice(1)).toEqual([
        `10:00 — Пользователь${CLIENT} · Маникюр с покрытием · предоплата получена`,
        `14:00 — Пользователь${CLIENT} · Брови · ждём приёмку`,
        `18:30 — Пользователь${CLIENT} · Педикюр · ждём предоплату`,
      ]);
      expect(sent[0].buttons).toEqual([expect.objectContaining({ type: 'open_app', text: texts.BTN.schedule, payload: 'deals' })]);
      expect((await digestRows())[0].status).toBe('sent');

      h.max.reset();
      await tick({ max: h.gateway, sendReminders: true }, at(8, 2));
      await tick({ max: h.gateway, sendReminders: true }, at(9));
      expect(digests()).toHaveLength(0);
      expect(await digestRows()).toHaveLength(1);
    });

    it('момент сводки прошёл — сегодня не планируется; записей на сегодня нет — тоже', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await dayDeal({ hour: 15, status: 'scheduled', title: 'Сегодня' });
      await onlyDigests();
      await tick({ max: h.gateway, sendReminders: true }, at(9));
      expect(await digestRows()).toHaveLength(0);

      await truncateAll();
      await h.start(SELLER, SELLER_CHAT);
      await createDeal({ at: new Date(D.end.getTime() + 10 * 60 * MINUTE), title: 'Завтра' });
      await h.query(`UPDATE deals SET status = 'scheduled', client_user_id = NULL`);
      await onlyDigests();
      await tick({ max: h.gateway, sendReminders: true }, at(7));
      expect(await digestRows()).toHaveLength(0);
    });

    it('к моменту отправки записей не осталось — гасится empty и не отправляется', async () => {
      await h.start(SELLER, SELLER_CHAT);
      const id = await dayDeal({ hour: 10, status: 'scheduled', title: 'Отменят' });
      await onlyDigests();
      await tick({ max: h.gateway, sendReminders: true }, at(7));
      await h.query(`UPDATE deals SET status = 'cancelled' WHERE public_id = $1`, [id]);

      await tick({ max: h.gateway, sendReminders: true }, at(8, 1));

      expect(digests()).toHaveLength(0);
      expect(await digestRows()).toEqual([expect.objectContaining({ status: 'cancelled', last_error: 'empty' })]);
    });

    it('демо-сделка входит в сводку с пометкой «демо», клиент без ссылки — «клиент не открыл ссылку»', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await dayDeal({ hour: 11, status: 'scheduled', title: 'Демо-маникюр', demo: true });
      await dayDeal({ hour: 16, status: 'scheduled', title: 'Без клиента', prepaymentRub: 0, client: null });
      await onlyDigests();
      await tick({ max: h.gateway, sendReminders: true }, at(7));
      await tick({ max: h.gateway, sendReminders: true }, at(8, 1));
      const lines = digests()[0].text.split('\n');
      expect(lines).toContain('11:00 — демо-клиент · Демо-маникюр · предоплата получена · демо');
      expect(lines).toContain('16:00 — клиент не открыл ссылку · Без клиента · без предоплаты');
    });

    it('смена времени переносит сегодняшнюю сводку; прошедшее время и выключение — гасят; снова включили — оживает', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await dayDeal({ hour: 15, status: 'scheduled', title: 'Сегодня' });
      await onlyDigests();
      await tick({ max: h.gateway, sendReminders: true }, at(7));

      expect(await rescheduleDigest(SELLER, 600, at(7, 10), TZ)).toBe('moved');
      expect((await digestRows())[0].due_at.toISOString()).toBe(at(10).toISOString());
      await tick({ max: h.gateway, sendReminders: true }, at(8, 1)); // старое время — не приходит
      expect(digests()).toHaveLength(0);

      expect(await rescheduleDigest(SELLER, null, at(8, 10), TZ)).toBe('cancelled');
      expect(await digestRows()).toEqual([expect.objectContaining({ status: 'cancelled', last_error: 'digest_off' })]);

      expect(await rescheduleDigest(SELLER, 630, at(8, 20), TZ)).toBe('moved'); // снова включили на 10:30
      expect((await digestRows())[0]).toMatchObject({ status: 'pending', last_error: null });

      expect(await rescheduleDigest(SELLER, 480, at(8, 30), TZ)).toBe('cancelled'); // 08:00 уже прошло
      expect(await digestRows()).toEqual([expect.objectContaining({ status: 'cancelled', last_error: 'digest_passed' })]);
      await tick({ max: h.gateway, sendReminders: true }, at(10, 31));
      expect(digests()).toHaveLength(0);
    });

    it('выключенную сводку тик не планирует; отправленную смена времени не воскрешает', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await dayDeal({ hour: 15, status: 'scheduled', title: 'Сегодня' });
      await onlyDigests();
      await h.query('UPDATE seller_profiles SET digest_time = NULL WHERE user_id = $1', [SELLER]);
      await tick({ max: h.gateway, sendReminders: true }, at(7));
      expect(await digestRows()).toHaveLength(0);

      await h.query('UPDATE seller_profiles SET digest_time = 480 WHERE user_id = $1', [SELLER]);
      await tick({ max: h.gateway, sendReminders: true }, at(7));
      await tick({ max: h.gateway, sendReminders: true }, at(8, 1));
      expect(digests()).toHaveLength(1);
      expect(await rescheduleDigest(SELLER, 600, at(8, 5), TZ)).toBe('none');
      expect((await digestRows())[0].status).toBe('sent');
    });

    it('сводка за прошедший день после простоя — too_late; у исполнителя нет диалога — no_chat', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await dayDeal({ hour: 15, status: 'scheduled', title: 'Сегодня' });
      await onlyDigests();
      await tick({ max: h.gateway, sendReminders: true }, at(7));
      await tick({ max: h.gateway, sendReminders: true }, new Date(D.end.getTime() + 60 * MINUTE));
      expect(await digestRows()).toEqual([expect.objectContaining({ status: 'cancelled', last_error: 'too_late' })]);

      await h.query('DELETE FROM reminders');
      await h.query('UPDATE users SET dialog_chat_id = NULL WHERE max_user_id = $1', [SELLER]);
      await tick({ max: h.gateway, sendReminders: true }, at(7));
      await tick({ max: h.gateway, sendReminders: true }, at(8, 1));
      expect(await digestRows()).toEqual([expect.objectContaining({ status: 'cancelled', last_error: 'no_chat' })]);
      expect(digests()).toHaveLength(0);
    });
  });

  describe('digest_time в API профиля', () => {
    it('профиль из POST /api/deals — сводка в 08:00; GET /api/me отдаёт digest_time', async () => {
      await createDeal({ at: new Date(Date.now() + 3 * 86_400_000) });
      const me = await h.api('GET', '/api/me', SELLER);
      expect(me.json.profile.digest_time).toBe(480);
    });

    it('PUT: допустимые значения — 06:00–12:00 с шагом 30 и null; остальное — 400', async () => {
      const put = (digest_time: unknown) => h.api('PUT', '/api/me/profile', SELLER, { ...PROFILE, digest_time });
      expect((await put(390)).json.profile.digest_time).toBe(390);
      expect((await put(720)).json.profile.digest_time).toBe(720);
      expect((await put(null)).json.profile.digest_time).toBeNull();
      for (const bad of [330, 370, 750, 480.5, '480']) {
        const res = await put(bad);
        expect(res.status, String(bad)).toBe(400);
        expect(res.json.error.code).toBe('validation');
      }
      // Поле не передано (старый клиент мини-приложения) — сводка не меняется
      const keep = await h.api('PUT', '/api/me/profile', SELLER, PROFILE);
      expect(keep.json.profile.digest_time).toBeNull();
    });

    it('PUT с null гасит сегодняшнюю ждущую сводку', async () => {
      await h.api('PUT', '/api/me/profile', SELLER, { ...PROFILE, digest_time: 480 });
      const today = dayOf(new Date(), TZ);
      await h.query(
        `INSERT INTO reminders (user_id, kind, recipient_role, due_at, dedupe_key) VALUES ($1, 'daily_digest', 'seller', $2, $3)`,
        [SELLER, new Date(Date.now() + 60 * MINUTE), digestKey(SELLER, today.dateKey)],
      );
      await h.api('PUT', '/api/me/profile', SELLER, { ...PROFILE, digest_time: null });
      const rows = await h.query<{ status: string; last_error: string }>(`SELECT status, last_error FROM reminders WHERE kind = 'daily_digest'`);
      expect(rows).toEqual([{ status: 'cancelled', last_error: 'digest_off' }]);
    });

    it('строка без сделки и без получателя не вставляется (CHECK)', async () => {
      await expect(
        h.query(`INSERT INTO reminders (kind, recipient_role, due_at, dedupe_key) VALUES ('event_soon', 'seller', now(), 'x')`),
      ).rejects.toThrow(/reminders_target_chk/);
    });
  });
});
