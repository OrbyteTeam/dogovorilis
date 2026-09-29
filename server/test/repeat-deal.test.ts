// «🔁 Повторить сделку» (ЗАДАЧА_04 F, SPEC §5.5, §7.8, §13): кнопка у завершённой сделки исполнителя,
// предзаполнение через GET /api/deals/:id, POST /api/deals с repeat_of / same_client.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { cardKeyboard } from '../src/transport/bot/keyboards.js';
import type { CardRole, DealBundle, DealStatus } from '../src/types.js';
import { cardMid, createHarness, dealStatus, livePaymentId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const SELLER = 4801;
const SELLER_CHAT = 7801;
const CLIENT = 4802;
const CLIENT_CHAT = 7802;
const OTHER_SELLER = 4803;

type Btn = { type: string; text: string; payload?: string };
const buttonsOf = (kb: unknown): Btn[][] => (kb as { payload?: { buttons?: Btn[][] } } | null)?.payload?.buttons ?? [];

describe('кнопка «🔁 Повторить» (SPEC §5.5)', () => {
  const ID = 'Rp3kZ9x1Qs';
  function bundle(status: DealStatus, over: { demo?: boolean; refund?: boolean } = {}): DealBundle {
    const at = new Date('2026-09-20T09:00:00Z');
    const user = (id: number) => ({ maxUserId: id, firstName: `U${id}`, lastName: null, username: null, dialogChatId: id, locale: null, phone: null, phoneVerifiedAt: null });
    return {
      deal: {
        id: 1, publicId: ID, sellerUserId: 1, clientUserId: 2, demo: over.demo ?? false, template: 'beauty', currentVersion: 1, status,
        statusChangedAt: at, clientJoinedAt: at, confirmedAt: null, doneAt: null, acceptedAt: null, paidAt: null, closedAt: null,
        cancelledAt: null, cancelledByRole: null, cancelReason: null, cancelRefundExpected: over.refund ? true : null,
        refundSentAt: null, refundReceivedAt: null, expiresAt: null, createdAt: at, updatedAt: at, serviceId: null, durationMin: null,
      },
      version: {
        id: 1, dealId: 1, version: 1, title: 'Маникюр', description: null, scheduledAt: null, totalKopecks: 250_000, prepaymentKopecks: 50_000,
        cancelRule: 'free_24h', photoMaxToken: null, changeRequestText: null, createdByUserId: 1, createdAt: at, confirmedAt: null, confirmedByUserId: null,
      },
      payments: [],
      seller: user(1),
      sellerProfile: null,
      client: user(2),
      receipt: null,
    };
  }
  const opts = { botUsername: 'dogovorilis_bot', demoMode: true, dealLink: `https://max.ru/dogovorilis_bot?start=d_${ID}`, linkRailVisible: true, transferRailVisible: true, linkRailRetry: false };
  const labels = (b: DealBundle, role: CardRole) => buttonsOf(cardKeyboard(b, role, opts)).flat();

  it('у исполнителя завершённой сделки — open_app repeat_<id>, квитанция остаётся', () => {
    for (const status of ['closed', 'cancelled', 'declined', 'expired'] as const) {
      const b = labels(bundle(status), 'seller');
      expect(b.map((x) => x.text), status).toEqual([texts.BTN.receiptPdf, texts.BTN.repeat]);
      expect(b[1]).toMatchObject({ type: 'open_app', payload: `repeat_${ID}`, web_app: 'dogovorilis_bot' });
    }
  });

  it('возврат не закрыт — «Вернул(а)» остаётся первым', () => {
    expect(labels(bundle('cancelled', { refund: true }), 'seller').map((x) => x.text)).toEqual([texts.BTN.refundSent, texts.BTN.receiptPdf, texts.BTN.repeat]);
  });

  it('у клиента, у демо-сделки и у незавершённой сделки кнопки нет', () => {
    expect(labels(bundle('closed'), 'client').map((x) => x.text)).not.toContain(texts.BTN.repeat);
    expect(labels(bundle('closed', { demo: true }), 'seller').map((x) => x.text)).not.toContain(texts.BTN.repeat);
    expect(labels(bundle('closed', { demo: true }), 'client_demo').map((x) => x.text)).not.toContain(texts.BTN.repeat);
    expect(labels(bundle('scheduled'), 'seller').map((x) => x.text)).not.toContain(texts.BTN.repeat);
  });
});

describe.skipIf(!DB)('«Повторить сделку»: API и сквозной сценарий', () => {
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

  const PROFILE = { display_name: 'Анна Мастер', tax_mode: 'npd', payout_details: 'СБП +7 900 000-00-00', transfer_enabled: true, link_enabled: false, default_cancel_rule: 'free_24h' };
  const BODY = (over: Record<string, unknown> = {}) => ({
    template: 'beauty',
    title: 'Маникюр с покрытием',
    description: 'Гель-лак',
    total_rub: 2500,
    prepayment_rub: 500,
    scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    cancel_rule: 'free_48h',
    profile: PROFILE,
    ...over,
  });

  async function create(over: Record<string, unknown> = {}, seller = SELLER): Promise<string> {
    const res = await h.api('POST', '/api/deals', seller, BODY(over));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.deal.public_id as string;
  }

  /** Завершённая сделка с настоящим клиентом: вход по ссылке, статус — прямо в БД (важен только итог). */
  async function closedWithClient(status: DealStatus = 'closed'): Promise<string> {
    await h.start(SELLER, SELLER_CHAT);
    const id = await create();
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    await h.query('UPDATE deals SET status = $2 WHERE public_id = $1', [id, status]);
    h.max.reset();
    return id;
  }

  it('GET /api/deals/:id закрытой сделки — предзаполнение и право повторить с тем же клиентом', async () => {
    const id = await closedWithClient();
    const res = await h.api('GET', `/api/deals/${id}`, SELLER);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      public_id: id,
      status: 'closed',
      role: 'seller',
      template: 'beauty',
      title: 'Маникюр с покрытием',
      description: 'Гель-лак',
      total_rub: 2500,
      prepayment_rub: 500,
      cancel_rule: 'free_48h',
      client: { name: `Пользователь${CLIENT}` },
      can_edit: false,
      can_repeat: true,
      same_client_available: true,
    });
    // клиенту повторять нечего
    expect((await h.api('GET', `/api/deals/${id}`, CLIENT)).json).toMatchObject({ role: 'client', can_repeat: false, same_client_available: false });
  });

  it('GET: без клиента — повторить можно, но не «тому же клиенту»; демо — нельзя вовсе', async () => {
    await h.start(SELLER, SELLER_CHAT);
    const lonely = await create();
    await h.query(`UPDATE deals SET status = 'expired' WHERE public_id = $1`, [lonely]);
    expect((await h.api('GET', `/api/deals/${lonely}`, SELLER)).json).toMatchObject({ can_repeat: true, same_client_available: false, client: null });

    const demo = await create();
    await h.query(`UPDATE deals SET status = 'closed', demo = true, client_user_id = seller_user_id WHERE public_id = $1`, [demo]);
    expect((await h.api('GET', `/api/deals/${demo}`, SELLER)).json).toMatchObject({ demo: true, can_repeat: false, same_client_available: false, client: null });
  });

  it('same_client и у клиента есть диалог — сделка сразу с ним, карточка ему без ссылки, исполнителю «отправлена»', async () => {
    const prev = await closedWithClient();
    const res = await h.api('POST', '/api/deals', SELLER, BODY({ repeat_of: prev, same_client: true }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ card_sent: true, client_card_sent: true, client: { name: `Пользователь${CLIENT}` }, client_no_dialog: false });
    const id = res.json.deal.public_id as string;
    expect(id).not.toBe(prev);

    const [deal] = await h.query<{ client_user_id: number; status: string; client_joined_at: Date | null }>(
      'SELECT client_user_id, status, client_joined_at FROM deals WHERE public_id = $1',
      [id],
    );
    expect(deal).toMatchObject({ client_user_id: CLIENT, status: 'awaiting_confirmation' });
    expect(deal.client_joined_at).not.toBeNull();
    const events = await h.query<{ type: string; actor_role: string; payload: Record<string, unknown> }>(
      `SELECT e.type, e.actor_role, e.payload FROM deal_events e JOIN deals d ON d.id = e.deal_id WHERE d.public_id = $1 ORDER BY e.seq`,
      [id],
    );
    expect(events.map((e) => e.type)).toEqual(['deal.created', 'client.joined']);
    expect(events[0].payload).toMatchObject({ source: 'repeat', repeat_of: prev });
    expect(events[1]).toMatchObject({ actor_role: 'seller', payload: { source: 'repeat', repeat_of: prev } });
    const notOpened = await h.query(`SELECT 1 FROM reminders r JOIN deals d ON d.id = r.deal_id WHERE d.public_id = $1 AND r.kind = 'client_not_opened'`, [id]);
    expect(notOpened).toHaveLength(0);

    // Клиенту: приветствие и карточка с «Подтверждаю» этой версии
    const toClient = h.max.inChat(CLIENT_CHAT);
    expect(toClient.map((m) => m.text)[0]).toBe(texts.S2_REPEAT('Анна Мастер'));
    const clientCard = h.max.byMid(await cardMid(h, id, 'client'));
    expect(clientCard?.buttons[0]).toMatchObject({ text: texts.BTN.confirm, payload: `cf:${id}:1` });

    // Исполнителю: карточка без ссылки и кнопок шеринга, затем «Карточка отправлена …»
    const sellerCard = h.max.byMid(await cardMid(h, id, 'seller'));
    expect(sellerCard?.text).not.toContain('Ссылка для клиента:');
    expect(sellerCard?.text).toContain(`Клиент: Пользователь${CLIENT}`);
    expect(sellerCard?.buttons.map((b) => b.text)).not.toContain(texts.BTN.sendToMax);
    expect(sellerCard?.buttons.map((b) => b.text)).not.toContain(texts.BTN.copyLink);
    expect(h.max.inChat(SELLER_CHAT).map((m) => m.text)).toContain(texts.REPEAT_CARD_SENT(`Пользователь${CLIENT}`));
  });

  it('same_client, но у клиента нет диалога — обычная сделка со ссылкой и client_no_dialog', async () => {
    const prev = await closedWithClient('cancelled');
    await h.query('UPDATE users SET dialog_chat_id = NULL WHERE max_user_id = $1', [CLIENT]);
    const res = await h.api('POST', '/api/deals', SELLER, BODY({ repeat_of: prev, same_client: true }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ client_card_sent: false, client: { name: `Пользователь${CLIENT}` }, client_no_dialog: true });
    expect(res.json.link).toContain(`start=d_${res.json.deal.public_id}`);
    const [deal] = await h.query<{ client_user_id: number | null }>('SELECT client_user_id FROM deals WHERE public_id = $1', [res.json.deal.public_id]);
    expect(deal.client_user_id).toBeNull();
    expect(h.max.inChat(CLIENT_CHAT)).toHaveLength(0);
    expect(h.max.byMid(await cardMid(h, res.json.deal.public_id, 'seller'))?.text).toContain('Ссылка для клиента:');
  });

  it('repeat_of без same_client — обычная сделка, клиента в ответе нет', async () => {
    const prev = await closedWithClient();
    const res = await h.api('POST', '/api/deals', SELLER, BODY({ repeat_of: prev }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ client_card_sent: false, client: null, client_no_dialog: false });
    const [deal] = await h.query<{ client_user_id: number | null }>('SELECT client_user_id FROM deals WHERE public_id = $1', [res.json.deal.public_id]);
    expect(deal.client_user_id).toBeNull();
  });

  it('чужая или несуществующая сделка в repeat_of — 403; same_client без настоящего клиента — 403; демо — 400; кривой id — 400', async () => {
    const prev = await closedWithClient();
    const foreign = await h.api('POST', '/api/deals', OTHER_SELLER, BODY({ repeat_of: prev, same_client: true }));
    expect(foreign.status).toBe(403);
    expect(foreign.json.error.code).toBe('forbidden');
    expect((await h.api('POST', '/api/deals', SELLER, BODY({ repeat_of: 'Zz9Zz9Zz9Z' }))).status).toBe(403);

    const lonely = await create();
    const noClient = await h.api('POST', '/api/deals', SELLER, BODY({ repeat_of: lonely, same_client: true }));
    expect(noClient.status).toBe(403);

    await h.query(`UPDATE deals SET demo = true, client_user_id = seller_user_id WHERE public_id = $1`, [lonely]);
    const demo = await h.api('POST', '/api/deals', SELLER, BODY({ repeat_of: lonely }));
    expect(demo.status).toBe(400);
    expect(demo.json.error).toEqual({ code: 'validation', message: expect.stringContaining('Демо-сделку повторить нельзя') });

    const bad = await h.api('POST', '/api/deals', SELLER, BODY({ repeat_of: 'x' }));
    expect(bad.status).toBe(400);
    // Ни одна отказанная попытка сделку не создала: у исполнителя по-прежнему две
    expect((await h.query<{ n: number }>('SELECT count(*)::int AS n FROM deals WHERE seller_user_id = $1', [SELLER]))[0].n).toBe(2);
  });

  it('сквозной: закрыть сделку → «Повторить» с тем же клиентом → карточка у клиента → клиент подтверждает (cf с версией)', async () => {
    await h.start(SELLER, SELLER_CHAT);
    // Без чека (tax_mode none) и со 100 % предоплаты: после приёмки сделка закрывается сама
    const first = await h.api('POST', '/api/deals', SELLER, BODY({ total_rub: 2000, prepayment_rub: 2000, profile: { ...PROFILE, tax_mode: 'none' } }));
    const id = first.json.deal.public_id as string;
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const clientCard = await cardMid(h, id, 'client');
    const sellerCard = await cardMid(h, id, 'seller');
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}:1`, clientCard);
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const p = await livePaymentId(h, id, 'prepayment');
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${p}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${p}`, sellerCard);
    await h.press(SELLER, SELLER_CHAT, `dn:${id}`, sellerCard);
    await h.press(CLIENT, CLIENT_CHAT, `ac:${id}`, clientCard);
    expect(await dealStatus(h, id)).toBe('closed');

    // В карточке исполнителя — «🔁 Повторить», у клиента — нет
    const repeatBtn = h.max.byMid(sellerCard)?.buttons.find((b) => b.text === texts.BTN.repeat);
    expect(repeatBtn).toMatchObject({ type: 'open_app', payload: `repeat_${id}` });
    expect(h.max.byMid(clientCard)?.buttons.map((b) => b.text)).not.toContain(texts.BTN.repeat);

    // Мини-приложение: предзаполнение → POST с тем же клиентом
    const view = await h.api('GET', `/api/deals/${id}`, SELLER);
    expect(view.json).toMatchObject({ can_repeat: true, same_client_available: true });
    h.max.reset();
    const again = await h.api('POST', '/api/deals', SELLER, {
      template: view.json.template,
      title: view.json.title,
      description: view.json.description,
      total_rub: view.json.total_rub,
      prepayment_rub: view.json.prepayment_rub,
      cancel_rule: view.json.cancel_rule,
      scheduled_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      repeat_of: id,
      same_client: true,
    });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.client_card_sent).toBe(true);
    const next = again.json.deal.public_id as string;

    // Клиент подтверждает прямо в пришедшей карточке — без перехода по ссылке
    const nextClientCard = await cardMid(h, next, 'client');
    expect(h.max.byMid(nextClientCard)?.buttons[0].payload).toBe(`cf:${next}:1`);
    await h.press(CLIENT, CLIENT_CHAT, `cf:${next}:1`, nextClientCard);
    expect(await dealStatus(h, next)).toBe('awaiting_prepayment');
    expect(h.max.inChat(SELLER_CHAT).some((m) => m.text.startsWith(`✅ Пользователь${CLIENT} подтвердил(а) условия #${next}`))).toBe(true);
  }, 90_000);
});
