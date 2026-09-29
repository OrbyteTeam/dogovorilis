// Правка условий — T5 целиком (ЗАДАЧА_04 E, SPEC §5.2, §6.4–6.5, §7.8, §13): кнопки «✏️ Изменить условия»,
// GET/PUT /api/deals/:publicId, N4 с перечнем изменений, «Подтверждаю» с номером версии.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { formatMoney } from '../src/domain/money.js';
import { formatDateTime } from '../src/domain/time.js';
import { cardKeyboard, n3Keyboard } from '../src/transport/bot/keyboards.js';
import type { CardRole, DealBundle, DealStatus } from '../src/types.js';
import { cardMid, createHarness, dealStatus, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const SELLER = 4701;
const SELLER_CHAT = 7701;
const CLIENT = 4702;
const CLIENT_CHAT = 7702;
const STRANGER = 4703;

type Btn = { type: string; text: string; payload?: string };
const buttonsOf = (kb: unknown): Btn[][] => (kb as { payload?: { buttons?: Btn[][] } } | null)?.payload?.buttons ?? [];

describe('кнопки правки условий (SPEC §5.5, §6.4)', () => {
  const ID = 'Ab3kZ9x1Qs';
  function bundle(status: DealStatus, over: { client?: boolean; version?: number; demo?: boolean } = {}): DealBundle {
    const at = new Date('2026-09-20T09:00:00Z');
    const user = (id: number) => ({ maxUserId: id, firstName: `U${id}`, lastName: null, username: null, dialogChatId: id, locale: null, phone: null, phoneVerifiedAt: null });
    return {
      deal: {
        id: 1, publicId: ID, sellerUserId: 1, clientUserId: over.client ? 2 : null, demo: over.demo ?? false, template: 'beauty',
        currentVersion: over.version ?? 1, status, statusChangedAt: at, clientJoinedAt: null, confirmedAt: null, doneAt: null,
        acceptedAt: null, paidAt: null, closedAt: null, cancelledAt: null, cancelledByRole: null, cancelReason: null,
        cancelRefundExpected: null, refundSentAt: null, refundReceivedAt: null, expiresAt: null, createdAt: at, updatedAt: at, serviceId: null, durationMin: null,
      },
      version: {
        id: 1, dealId: 1, version: over.version ?? 1, title: 'Маникюр', description: null, scheduledAt: null, totalKopecks: 250_000,
        prepaymentKopecks: 50_000, cancelRule: 'free_24h', photoMaxToken: null, changeRequestText: null, createdByUserId: 1,
        createdAt: at, confirmedAt: null, confirmedByUserId: null,
      },
      payments: [],
      seller: user(1),
      sellerProfile: null,
      client: over.client ? user(2) : null,
      receipt: null,
    };
  }
  const opts = { botUsername: 'dogovorilis_bot', demoMode: true, dealLink: `https://max.ru/dogovorilis_bot?start=d_${ID}`, linkRailVisible: true, transferRailVisible: true, linkRailRetry: false };
  const rows = (b: DealBundle, role: CardRole = 'seller') => buttonsOf(cardKeyboard(b, role, opts));
  const edit = (r: Btn[][]) => r.flat().filter((b) => b.text === texts.BTN.editTerms);

  it('исполнитель: есть в awaiting_confirmation (до и после входа клиента) и changes_requested — open_app edit_<id>, своим рядом', () => {
    for (const b of [bundle('awaiting_confirmation'), bundle('awaiting_confirmation', { client: true }), bundle('changes_requested', { client: true })]) {
      const r = rows(b);
      expect(edit(r), b.deal.status).toEqual([expect.objectContaining({ type: 'open_app', payload: `edit_${ID}`, web_app: 'dogovorilis_bot' })]);
      expect(r.find((row) => row.some((x) => x.text === texts.BTN.editTerms))).toHaveLength(1);
      for (const row of r) expect(row.filter((x) => x.type === 'open_app' || x.type === 'link').length).toBeLessThanOrEqual(3);
      expect(r.at(-1)?.[0].text).toBe(texts.BTN.cancelDeal); // деструктивное — последним рядом (DESIGN §6)
    }
    expect(rows(bundle('changes_requested', { client: true })).flat().map((x) => x.text)).toEqual([
      texts.BTN.editTerms, texts.BTN.keepAsIs, texts.BTN.cancelDeal,
    ]);
  });

  it('в остальных статусах и у клиента кнопки нет', () => {
    const others: DealStatus[] = ['awaiting_prepayment', 'scheduled', 'awaiting_acceptance', 'remarks', 'awaiting_payment', 'paid', 'closed', 'cancelled', 'declined', 'expired'];
    for (const s of others) expect(edit(rows(bundle(s, { client: true }))), s).toEqual([]);
    expect(edit(rows(bundle('awaiting_confirmation', { client: true }), 'client'))).toEqual([]);
  });

  it('«Подтверждаю» несёт номер текущей версии: cf:<id>:<v>', () => {
    const r = rows(bundle('awaiting_confirmation', { client: true, version: 3 }), 'client');
    expect(r[0]).toEqual([expect.objectContaining({ text: texts.BTN.confirm, payload: `cf:${ID}:3` })]);
    expect(r.flat().map((b) => b.text)).toEqual([texts.BTN.confirm, texts.BTN.requestChanges, texts.BTN.decline]);
  });

  it('N3: изменить условия (open_app), оставить как есть, отменить', () => {
    const r = buttonsOf(n3Keyboard(ID));
    expect(r.flat().map((b) => b.text)).toEqual([texts.BTN.editTerms, texts.BTN.keepAsIs, texts.BTN.cancelDeal]);
    expect(r[0][0]).toMatchObject({ type: 'open_app', payload: `edit_${ID}` });
  });
});

describe.skipIf(!DB)('правка условий: API и сквозной сценарий', () => {
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

  const AT = () => new Date(Date.now() + 3 * 86_400_000);
  const BODY = (over: Record<string, unknown> = {}) => ({
    template: 'beauty',
    title: 'Маникюр с покрытием',
    description: 'Гель-лак',
    total_rub: 2500,
    prepayment_rub: 500,
    scheduled_at: null as string | null,
    cancel_rule: 'free_24h',
    ...over,
  });
  const PROFILE = { display_name: 'Анна Мастер', tax_mode: 'npd', payout_details: 'СБП +7 900 000-00-00', transfer_enabled: true, link_enabled: false, default_cancel_rule: 'free_24h' };

  async function createDeal(over: Record<string, unknown> = {}): Promise<string> {
    await h.start(SELLER, SELLER_CHAT);
    const res = await h.api('POST', '/api/deals', SELLER, { ...BODY(over), profile: PROFILE });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.deal.public_id as string;
  }

  async function withClient(over: Record<string, unknown> = {}): Promise<string> {
    const id = await createDeal(over);
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    return id;
  }

  describe('GET /api/deals/:publicId', () => {
    it('без initData — 401; посторонний — 403; нет сделки — 404 not_found', async () => {
      const id = await createDeal();
      expect((await h.apiRaw('GET', `/api/deals/${id}`, {})).status).toBe(401);
      const stranger = await h.api('GET', `/api/deals/${id}`, STRANGER);
      expect(stranger.status).toBe(403);
      expect(stranger.json).toEqual({ error: { code: 'forbidden', message: expect.any(String) } });
      for (const missing of ['Zz9Zz9Zz9Z', 'not-an-id']) {
        const res = await h.api('GET', `/api/deals/${missing}`, SELLER);
        expect(res.status).toBe(404);
        expect(res.json.error.code).toBe('not_found');
      }
    });

    it('исполнителю — поля для предзаполнения и can_edit; клиенту — role client без прав', async () => {
      const at = AT();
      const id = await withClient({ scheduled_at: at.toISOString(), total_rub: 3000, prepayment_rub: 900, cancel_rule: 'free_48h' });
      const seller = await h.api('GET', `/api/deals/${id}`, SELLER);
      expect(seller.status).toBe(200);
      expect(seller.json).toEqual({
        public_id: id,
        status: 'awaiting_confirmation',
        version: 1,
        role: 'seller',
        demo: false,
        template: 'beauty',
        title: 'Маникюр с покрытием',
        description: 'Гель-лак',
        scheduled_at: at.toISOString(),
        total_rub: 3000,
        prepayment_rub: 900,
        cancel_rule: 'free_48h',
        client: { name: `Пользователь${CLIENT}` },
        can_edit: true,
        can_repeat: false,
        same_client_available: false,
        service_id: null,
        duration_min: null,
      });
      const client = await h.api('GET', `/api/deals/${id}`, CLIENT);
      expect(client.json).toMatchObject({ role: 'client', can_edit: false, can_repeat: false, same_client_available: false });
    });
  });

  describe('PUT /api/deals/:publicId', () => {
    it('401 / 403 (клиент и посторонний) / 404 / 400', async () => {
      const id = await withClient();
      expect((await h.apiRaw('PUT', `/api/deals/${id}`, {}, BODY({ total_rub: 3000 }))).status).toBe(401);
      for (const who of [CLIENT, STRANGER]) {
        const res = await h.api('PUT', `/api/deals/${id}`, who, BODY({ total_rub: 3000 }));
        expect(res.status, String(who)).toBe(403);
        expect(res.json.error.code).toBe('forbidden');
      }
      expect((await h.api('PUT', '/api/deals/Zz9Zz9Zz9Z', SELLER, BODY({ total_rub: 3000 }))).json.error.code).toBe('not_found');
      const bad = await h.api('PUT', `/api/deals/${id}`, SELLER, BODY({ total_rub: 0 }));
      expect(bad.status).toBe(400);
      expect(bad.json.error.code).toBe('validation');
      expect((await h.api('GET', `/api/deals/${id}`, SELLER)).json.version).toBe(1);
    });

    it('ничего не изменилось — 409 no_changes; пустые «Уточнения» (null, "", пробелы) равны, template не обязателен', async () => {
      const id = await createDeal({ description: null });
      for (const description of [null, '', '   ']) {
        const { template: _t, ...body } = BODY({ description });
        const res = await h.api('PUT', `/api/deals/${id}`, SELLER, body);
        expect(res.status, JSON.stringify(description)).toBe(409);
        expect(res.json).toEqual({ error: { code: 'no_changes', message: expect.any(String) } });
      }
      const rows = await h.query<{ n: number }>('SELECT count(*)::int AS n FROM deal_versions');
      expect(rows[0].n).toBe(1);
    });

    it('после подтверждения — 409 deal_not_editable со статусом', async () => {
      const id = await withClient();
      await h.press(CLIENT, CLIENT_CHAT, `cf:${id}:1`, await cardMid(h, id, 'client'));
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');
      const res = await h.api('PUT', `/api/deals/${id}`, SELLER, BODY({ total_rub: 3000 }));
      expect(res.status).toBe(409);
      expect(res.json).toEqual({ error: { code: 'deal_not_editable', message: expect.any(String), status: 'awaiting_prepayment' } });
      const view = await h.api('GET', `/api/deals/${id}`, SELLER);
      expect(view.json).toMatchObject({ status: 'awaiting_prepayment', can_edit: false });
    });

    it('клиента ещё нет: версия 2, строки версий не редактируются, исполнителю — «увидит, когда откроет ссылку»', async () => {
      const id = await createDeal();
      h.max.reset();
      const res = await h.api('PUT', `/api/deals/${id}`, SELLER, BODY({ total_rub: 3000, prepayment_rub: 600 }));
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.version).toBe(2);
      expect(res.json.client_notified).toBe(false);
      expect(res.json.deal.version).toMatchObject({ version: 2, total_kopecks: 300_000, prepayment_kopecks: 60_000 });

      const versions = await h.query<{ version: number; total_kopecks: number }>(
        'SELECT version, total_kopecks FROM deal_versions ORDER BY version',
      );
      expect(versions).toEqual([{ version: 1, total_kopecks: 250_000 }, { version: 2, total_kopecks: 300_000 }]);
      expect(h.max.inChat(SELLER_CHAT).map((m) => m.text)).toContain(texts.TERMS_UPDATED({ id, version: 2, client: 'no_client' }));
      // Карточка исполнителя обновилась на месте — со строкой версии и ссылкой для клиента
      const card = h.max.byMid(await cardMid(h, id, 'seller'));
      expect(card?.text).toContain('Версия 2, условия изменены');
      expect(card?.text).toContain(formatMoney(300_000));

      // Третья версия — номер растёт дальше
      const third = await h.api('PUT', `/api/deals/${id}`, SELLER, BODY({ total_rub: 3000, prepayment_rub: 0 }));
      expect(third.json.version).toBe(3);
    });

    it('напоминания перепланированы от новой версии: срок подтверждения — снова 72 ч', async () => {
      const id = await createDeal();
      await h.query(`UPDATE deals SET expires_at = now() + interval '1 hour', status_changed_at = now() - interval '71 hours' WHERE public_id = $1`, [id]);
      const before = Date.now();
      await h.api('PUT', `/api/deals/${id}`, SELLER, BODY({ title: 'Маникюр и дизайн' }));
      const pending = await h.query<{ kind: string; due_at: Date }>(
        `SELECT kind, due_at FROM reminders WHERE status = 'pending' AND kind = 'confirmation_expired'`,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0].due_at.getTime()).toBeGreaterThan(before + 71 * 3_600_000);
      const deal = await h.query<{ expires_at: Date }>('SELECT expires_at FROM deals WHERE public_id = $1', [id]);
      expect(deal[0].expires_at.getTime()).toBeGreaterThan(before + 71 * 3_600_000);
    });
  });

  it('сквозной: cr → PUT → «версия 2» у обеих и N4 с перечнем → cf старой версии отклонён → cf новой → awaiting_prepayment', async () => {
    const at = AT();
    const id = await withClient({ scheduled_at: at.toISOString() });
    const clientCard = await cardMid(h, id, 'client');
    const sellerCard = await cardMid(h, id, 'seller');

    // Клиент: «Предложить изменения» + текст (T4) → исполнителю N3 с «Изменить условия»
    await h.press(CLIENT, CLIENT_CHAT, `cr:t:${id}`, clientCard);
    await h.say(CLIENT, CLIENT_CHAT, 'давайте на день позже и 3000 с предоплатой 600');
    expect(await dealStatus(h, id)).toBe('changes_requested');
    const n3 = h.max.inChat(SELLER_CHAT).find((m) => m.text.includes('предлагает изменения'));
    expect(n3?.text).toContain('Измените условия или оставьте как есть.');
    expect(n3?.buttons.map((b) => b.text)).toEqual([texts.BTN.editTerms, texts.BTN.keepAsIs, texts.BTN.cancelDeal]);
    expect(n3?.buttons[0]).toMatchObject({ type: 'open_app', payload: `edit_${id}` });
    expect(h.max.byMid(sellerCard)?.buttons.map((b) => b.text)).toContain(texts.BTN.editTerms);

    // Исполнитель: форма правки (GET → PUT)
    const view = await h.api('GET', `/api/deals/${id}`, SELLER);
    expect(view.json).toMatchObject({ status: 'changes_requested', can_edit: true, version: 1 });
    const later = new Date(at.getTime() + 86_400_000);
    h.max.reset();
    const res = await h.api('PUT', `/api/deals/${id}`, SELLER, BODY({ scheduled_at: later.toISOString(), total_rub: 3000, prepayment_rub: 600 }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ version: 2, client_notified: true });
    expect(res.json.deal.status).toBe('awaiting_confirmation');

    // N4 клиенту — только изменившиеся поля
    const n4 = h.max.inChat(CLIENT_CHAT).find((m) => m.text.startsWith('✏️ Исполнитель изменил условия'));
    expect(n4?.text).toBe(
      `✏️ Исполнитель изменил условия #${id}, версия 2: когда: ${formatDateTime(later)}; сумма: ${formatMoney(300_000)}, предоплата ${formatMoney(60_000)}.\nПроверьте и подтвердите.`,
    );
    expect(n4?.text).not.toContain('что делаем');
    expect(n4?.text).not.toContain('уточнения');
    expect(n4?.buttons.map((b) => b.text)).toEqual([texts.BTN.open]);
    expect(h.max.inChat(SELLER_CHAT).map((m) => m.text)).toContain(texts.TERMS_UPDATED({ id, version: 2, client: 'notified' }));

    // Обе карточки — «Версия 2», у клиента снова три кнопки и cf с новой версией
    for (const mid of [clientCard, sellerCard]) expect(h.max.byMid(mid)?.text).toContain('Версия 2, условия изменены');
    const clientButtons = h.max.byMid(clientCard)!.buttons;
    expect(clientButtons.map((b) => b.text)).toEqual([texts.BTN.confirm, texts.BTN.requestChanges, texts.BTN.decline]);
    expect(clientButtons[0].payload).toBe(`cf:${id}:2`);

    // «Подтверждаю» прежней версии (старая кнопка, и без номера — формат до выкладки) — отказ без перехода
    for (const stale of [`cf:${id}:1`, `cf:${id}`]) {
      h.max.reset();
      await h.press(CLIENT, CLIENT_CHAT, stale, clientCard);
      expect(await dealStatus(h, id), stale).toBe('awaiting_confirmation');
      const answer = h.max.sent.find((m) => m.kind === 'answer');
      expect(answer?.text.startsWith(texts.VERSION_CHANGED), stale).toBe(true);
      expect(answer?.text).toContain('Версия 2'); // ответ — свежей карточкой (SPEC §6.4)
      expect(answer?.buttons[0].payload).toBe(`cf:${id}:2`);
    }
    const confirmed = await h.query<{ n: number }>(`SELECT count(*)::int AS n FROM deal_events WHERE type = 'version.confirmed'`);
    expect(confirmed[0].n).toBe(0);

    // «Подтверждаю» новой версии — T3
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}:2`, clientCard);
    expect(await dealStatus(h, id)).toBe('awaiting_prepayment');
    const v = await h.query<{ version: number; confirmed_at: Date | null; change_request_text: string | null }>(
      'SELECT version, confirmed_at, change_request_text FROM deal_versions ORDER BY version',
    );
    expect(v[0].confirmed_at).toBeNull();
    expect(v[1].confirmed_at).not.toBeNull();
    expect(v[1].change_request_text).toBe('давайте на день позже и 3000 с предоплатой 600');
  }, 60_000);

  it('демо: исполнитель правит условия, N4 приходит в тот же чат с пометкой «клиенту»', async () => {
    await h.start(SELLER, SELLER_CHAT);
    await h.press(SELLER, SELLER_CHAT, 'dm:new');
    const [{ public_id: id }] = await h.query<{ public_id: string }>('SELECT public_id FROM deals');
    h.max.reset();
    const res = await h.api('PUT', `/api/deals/${id}`, SELLER, BODY({ total_rub: 3000, prepayment_rub: 500 }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.client_notified).toBe(true);
    const texts_ = h.max.inChat(SELLER_CHAT).map((m) => m.text);
    expect(texts_.some((t) => t.startsWith(`${texts.demoNotifyPrefix('client')}✏️ Исполнитель изменил условия #${id}, версия 2`))).toBe(true);
    expect(h.max.byMid(await cardMid(h, id, 'client_demo'))?.buttons[0].payload).toBe(`cf:${id}:2`);
  }, 60_000);
});
