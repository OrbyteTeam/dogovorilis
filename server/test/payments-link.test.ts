// Рейл «ссылка» целиком: кнопка → ЮKassa → подтверждение (вебхук | опрос | кнопка) → переход сделки.
// БД настоящая, MAX подменён на уровне HTTP, ЮKassa подменена на уровне клиента (сети нет).
// Первоисточники: SPEC §9.1 п. 1–4, §9.2, §10.3, §14 п. 2, 3, 7, 8.
// Запуск: TEST_DATABASE_URL=postgres://…/dogovorilis_test npx vitest run --root server
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import * as rails from '../src/domain/payment/rails.js';
import { pollLinkPayments } from '../src/scheduler/jobs/payments-poll.js';
import { IntegrationError } from '../src/errors.js';
import type { CreatePaymentArgs, YooKassaClient, YooKassaPayment } from '../src/integrations/yookassa/client.js';
import { cardMid, createHarness, dealStatus, livePaymentId, onlyDealPublicId, truncateAll, type Harness } from './helpers/harness.js';
import { ipAllowed } from '../src/transport/http/routes/webhooks.js';

const DB = process.env.TEST_DATABASE_URL;

const SELLER = 3001;
const SELLER_CHAT = 7001;

const TIMEOUT = 120_000;

/**
 * Поддельная ЮKassa: хранит платежи в памяти, умеет «оплатить» и «отменить» их так же,
 * как это сделал бы настоящий магазин. Никакой сети — проверяется наша логика, не чужая.
 */
function createFakeYooKassa() {
  const payments = new Map<string, YooKassaPayment>();
  const created: CreatePaymentArgs[] = [];
  let seq = 0;
  let failNext: IntegrationError | null = null;
  const getCalls: string[] = [];

  const api: YooKassaClient = {
    async createPayment(args) {
      created.push(args);
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      const id = `pay-${++seq}`;
      const payment: YooKassaPayment = {
        id,
        status: 'pending',
        paid: false,
        amount: { value: (args.amountKopecks / 100).toFixed(2), currency: 'RUB' },
        description: args.description,
        confirmation: { type: 'redirect', return_url: args.returnUrl, confirmation_url: `https://yoomoney.ru/confirm/${id}` },
        metadata: args.metadata,
        created_at: new Date().toISOString(),
        test: true,
      };
      payments.set(id, payment);
      return payment;
    },
    async getPayment(id) {
      getCalls.push(id);
      const p = payments.get(id);
      if (!p) throw new IntegrationError('yookassa', 'getPayment', 404, 'not_found', 'нет такого платежа');
      return p;
    },
  };

  return {
    api,
    created,
    getCalls,
    /** Клиент оплатил картой: capture:true → сразу succeeded (CONTRACTS §2.3). */
    succeed(id: string) {
      const p = payments.get(id);
      if (!p) throw new Error(`нет платежа ${id}`);
      payments.set(id, { ...p, status: 'succeeded', paid: true });
    },
    cancel(id: string, reason: string) {
      const p = payments.get(id);
      if (!p) throw new Error(`нет платежа ${id}`);
      payments.set(id, { ...p, status: 'canceled', cancellation_details: { party: 'payment_network', reason } });
    },
    failNextCreate(e: IntegrationError) {
      failNext = e;
    },
    lastId: () => `pay-${seq}`,
  };
}

type Fake = ReturnType<typeof createFakeYooKassa>;

describe.skipIf(!DB)('рейл «ссылка» (ЮKassa)', () => {
  let h: Harness;
  let yk: Fake;

  beforeAll(async () => {
    h = await createHarness(DB!, { paymentProvider: 'yookassa' });
  });

  afterAll(async () => {
    rails.setYooKassaClient(null);
    await h.close();
  });

  beforeEach(async () => {
    await truncateAll();
    yk = createFakeYooKassa();
    rails.setYooKassaClient(yk.api);
    h.max.reset();
  });

  /** Демо-сделка до состояния «ждём предоплату»: тот же путь, которым идёт живой проверяющий. */
  async function demoDealAwaitingPrepayment(): Promise<string> {
    await h.start(SELLER, SELLER_CHAT);
    await h.press(SELLER, SELLER_CHAT, 'dm:new');
    const id = await onlyDealPublicId(h);
    await h.press(SELLER, SELLER_CHAT, `cf:${id}`, await cardMid(h, id, 'client_demo'));
    expect(await dealStatus(h, id)).toBe('awaiting_prepayment');
    return id;
  }

  /** Предоплата по ссылке: доводим до pending-платежа с confirmation_url. */
  async function issueLink(id: string): Promise<{ paymentId: number; providerId: string }> {
    await h.press(SELLER, SELLER_CHAT, `pl:${id}`, await cardMid(h, id, 'client_demo'));
    const paymentId = await livePaymentId(h, id, 'prepayment');
    const rows = await h.query<{ provider_payment_id: string }>('SELECT provider_payment_id FROM payments WHERE id = $1', [paymentId]);
    return { paymentId, providerId: rows[0].provider_payment_id };
  }

  const webhook = (event: string, id: string, status: string) =>
    h.webhook('/webhooks/yookassa', { type: 'notification', event, object: { id, status } }, '185.71.76.1');

  /** Обработка вебхука идёт в setImmediate после ответа 200 — даём ей завершиться. */
  const settle = () => new Promise<void>((r) => setTimeout(r, 300));

  /** Ответ на нажатие кнопки (POST /answers) — то, что пользователь увидит немедленно. */
  const lastAnswer = () => h.max.sent.filter((m) => m.kind === 'answer').at(-1)?.text ?? '';

  /**
   * Текст карточки. Проверяем на карточке ИСПОЛНИТЕЛЯ: нажатая карточка обновляется ответом
   * на callback (у него нет mid), а вторая — правкой на месте, и её текст виден по mid.
   */
  const sellerCardText = async (id: string) => h.max.byMid(await cardMid(h, id, 'seller'))?.text ?? '';

  it(
    'предоплата по ссылке → вебхук succeeded → T9 (сделка «Запланировано»)',
    async () => {
      const id = await demoDealAwaitingPrepayment();
      const { paymentId, providerId } = await issueLink(id);

      // Запрос к провайдеру собран по SPEC §9.2: capture, return_url, description, metadata.
      expect(yk.created).toHaveLength(1);
      expect(yk.created[0].metadata).toEqual({ deal: id, payment: String(paymentId), kind: 'prepayment' });
      expect(yk.created[0].returnUrl).toBe(`http://localhost:8080/pay/return?d=${id}`);
      expect(yk.created[0].description).toContain(`Сделка #${id}`);

      const stored = await h.query<{ status: string; confirmation_url: string; expires_at: Date }>(
        'SELECT status, confirmation_url, expires_at FROM payments WHERE id = $1',
        [paymentId],
      );
      expect(stored[0].status).toBe('pending');
      expect(stored[0].confirmation_url).toBe(`https://yoomoney.ru/confirm/${providerId}`);
      expect(stored[0].expires_at).not.toBeNull();

      // Карточка сообщает про выданную ссылку и её срок (§9.1 п. 2).
      expect(await sellerCardText(id)).toContain('Ссылка на оплату');
      // Клиент в ответе на нажатие видит пометку про тестовый магазин (§9.2 п. 4, §18).
      expect(lastAnswer()).toContain('Тестовый магазин ЮKassa');

      yk.succeed(providerId);
      const res = await webhook('payment.succeeded', providerId, 'succeeded');
      expect(res.status).toBe(200);
      await settle();

      // Статус берётся из GET, а не из тела уведомления (CONTRACTS §2.5).
      expect(yk.getCalls).toContain(providerId);
      expect(await dealStatus(h, id)).toBe('scheduled');

      const log = await h.query<{ result: string }>('SELECT result FROM webhook_log ORDER BY id');
      expect(log.map((r) => r.result)).toEqual(['ok']);
    },
    TIMEOUT,
  );

  it(
    'повторный вебхук с тем же статусом → ignored:duplicate, второго перехода нет (§14 п. 2)',
    async () => {
      const id = await demoDealAwaitingPrepayment();
      const { providerId } = await issueLink(id);
      yk.succeed(providerId);

      await webhook('payment.succeeded', providerId, 'succeeded');
      await settle();
      await webhook('payment.succeeded', providerId, 'succeeded');
      await settle();

      const log = await h.query<{ result: string }>('SELECT result FROM webhook_log ORDER BY id');
      expect(log.map((r) => r.result)).toEqual(['ok', 'ignored:duplicate']);

      const events = await h.query<{ n: string }>(
        `SELECT count(*) AS n FROM deal_events e JOIN deals d ON d.id = e.deal_id
         WHERE d.public_id = $1 AND e.type = 'payment.succeeded'`,
        [id],
      );
      expect(Number(events[0].n)).toBe(1);
      expect(await dealStatus(h, id)).toBe('scheduled');
    },
    TIMEOUT,
  );

  it(
    'вебхук про чужой платёж → ignored:foreign, наша сделка не тронута (§14 п. 3)',
    async () => {
      const id = await demoDealAwaitingPrepayment();
      await issueLink(id);

      const res = await webhook('payment.succeeded', 'чужой-платёж-00000', 'succeeded');
      expect(res.status).toBe(200);
      await settle();

      const log = await h.query<{ result: string }>('SELECT result FROM webhook_log ORDER BY id');
      expect(log[0].result).toBe('ignored:foreign');
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');
    },
    TIMEOUT,
  );

  it(
    'вебхук canceled → платёж canceled с причиной, сделка ждёт оплату дальше',
    async () => {
      const id = await demoDealAwaitingPrepayment();
      const { paymentId, providerId } = await issueLink(id);

      yk.cancel(providerId, 'insufficient_funds');
      await webhook('payment.canceled', providerId, 'canceled');
      await settle();

      const rows = await h.query<{ status: string; cancellation_reason: string }>(
        'SELECT status, cancellation_reason FROM payments WHERE id = $1',
        [paymentId],
      );
      expect(rows[0].status).toBe('canceled');
      expect(rows[0].cancellation_reason).toBe('insufficient_funds');
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');

      // Клиенту объясняют причину и дают создать новую ссылку (§9.2).
      expect(await sellerCardText(id)).toContain('недостаточно средств');
    },
    TIMEOUT,
  );

  it(
    'остаток по ссылке → подтверждение опросом планировщика → T14 («Оплачено»)',
    async () => {
      const id = await demoDealAwaitingPrepayment();

      // Предоплату проводим переводом, чтобы дойти до остатка коротким путём.
      const clientCard = await cardMid(h, id, 'client_demo');
      await h.press(SELLER, SELLER_CHAT, `pt:${id}`, clientCard);
      const prepayment = await livePaymentId(h, id, 'prepayment');
      await h.press(SELLER, SELLER_CHAT, `tr:c:${id}:${prepayment}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${prepayment}`, await cardMid(h, id, 'seller'));
      await h.press(SELLER, SELLER_CHAT, `dn:${id}`, await cardMid(h, id, 'seller'));
      await h.press(SELLER, SELLER_CHAT, `ac:${id}`, await cardMid(h, id, 'client_demo'));
      expect(await dealStatus(h, id)).toBe('awaiting_payment');

      await h.press(SELLER, SELLER_CHAT, `pl:${id}`, await cardMid(h, id, 'client_demo'));
      const paymentId = await livePaymentId(h, id, 'final');
      const providerId = yk.lastId();
      yk.succeed(providerId);

      // Вебхук не дошёл (локальный режим без HTTPS) — платёж подхватывает опрос.
      // Платёж опрашивается не раньше, чем через 30 с после создания (§10.3), поэтому «сейчас» сдвигаем.
      await pollLinkPayments(h.gateway, new Date(Date.now() + 2 * 60_000));

      const rows = await h.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [paymentId]);
      expect(rows[0].status).toBe('succeeded');
      expect(await dealStatus(h, id)).toBe('paid');
    },
    TIMEOUT,
  );

  it(
    'платёж опрашивается не чаще раза в 60 с (§10.3)',
    async () => {
      const id = await demoDealAwaitingPrepayment();
      await issueLink(id);

      // Только что создан — в выборку опроса не попадает.
      await pollLinkPayments(h.gateway, new Date());
      expect(yk.getCalls).toHaveLength(0);

      await pollLinkPayments(h.gateway, new Date(Date.now() + 2 * 60_000));
      expect(yk.getCalls).toHaveLength(1);

      // Сразу следом — снова рано: updated_at только что сдвинулся.
      await pollLinkPayments(h.gateway, new Date(Date.now() + 2 * 60_000));
      expect(yk.getCalls).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'истёкшая ссылка → статус expired и кнопка «Новая ссылка» создаёт платёж с новым ключом (§14 п. 7)',
    async () => {
      const id = await demoDealAwaitingPrepayment();
      const { paymentId } = await issueLink(id);
      const firstKey = (await h.query<{ idempotence_key: string }>('SELECT idempotence_key FROM payments WHERE id = $1', [paymentId]))[0]
        .idempotence_key;

      // Планировщик встречает платёж, у которого expires_at уже в прошлом.
      await pollLinkPayments(h.gateway, new Date(Date.now() + 2 * 3_600_000));

      const expired = await h.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [paymentId]);
      expect(expired[0].status).toBe('expired');

      expect(await sellerCardText(id)).toContain('истекла');

      await h.press(SELLER, SELLER_CHAT, `nl:${id}`, await cardMid(h, id, 'client_demo'));
      const secondId = await livePaymentId(h, id, 'prepayment');
      expect(secondId).not.toBe(paymentId);
      const secondKey = (await h.query<{ idempotence_key: string }>('SELECT idempotence_key FROM payments WHERE id = $1', [secondId]))[0]
        .idempotence_key;
      expect(secondKey).not.toBe(firstKey);
    },
    TIMEOUT,
  );

  it(
    'провайдер недоступен → E9, платёж отменён локально, кнопка снова работает (§14 п. 8)',
    async () => {
      const id = await demoDealAwaitingPrepayment();
      yk.failNextCreate(new IntegrationError('yookassa', 'createPayment', null, null, 'таймаут 10000 мс'));

      await h.press(SELLER, SELLER_CHAT, `pl:${id}`, await cardMid(h, id, 'client_demo'));
      expect(lastAnswer()).toBe(texts.E9);

      const rows = await h.query<{ status: string }>(`SELECT status FROM payments ORDER BY id`);
      expect(rows.map((r) => r.status)).toEqual(['canceled']);

      // Вторая попытка проходит: живого платежа нет, слот свободен.
      await h.press(SELLER, SELLER_CHAT, `pl:${id}`, await cardMid(h, id, 'client_demo'));
      const paymentId = await livePaymentId(h, id, 'prepayment');
      expect(paymentId).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    'двойное нажатие «Оплатить по ссылке» переиспользует ту же ссылку',
    async () => {
      const id = await demoDealAwaitingPrepayment();
      const { paymentId } = await issueLink(id);
      await h.press(SELLER, SELLER_CHAT, `pl:${id}`, await cardMid(h, id, 'client_demo'));

      expect(yk.created).toHaveLength(1);
      expect(await livePaymentId(h, id, 'prepayment')).toBe(paymentId);
    },
    TIMEOUT,
  );

  it(
    'смена рейла: живая ссылка отменяется, когда клиент выбирает перевод (§9.1)',
    async () => {
      const id = await demoDealAwaitingPrepayment();
      const { paymentId } = await issueLink(id);

      await h.press(SELLER, SELLER_CHAT, `pt:${id}`, await cardMid(h, id, 'client_demo'));

      const rows = await h.query<{ id: number; rail: string; status: string }>('SELECT id, rail, status FROM payments ORDER BY id');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: paymentId, rail: 'link', status: 'canceled' });
      expect(rows[1]).toMatchObject({ rail: 'transfer', status: 'pending' });
    },
    TIMEOUT,
  );

  it(
    'кнопка «Проверить оплату» подтверждает платёж без вебхука (§9.1 п. 3)',
    async () => {
      const id = await demoDealAwaitingPrepayment();
      const { paymentId, providerId } = await issueLink(id);

      // Ещё не оплачено — честный ответ, сценарий не в тупике.
      await h.press(SELLER, SELLER_CHAT, `pc:${id}:${paymentId}`, await cardMid(h, id, 'client_demo'));
      expect(lastAnswer()).toContain('пока не подтверждена');
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');

      yk.succeed(providerId);
      await h.press(SELLER, SELLER_CHAT, `pc:${id}:${paymentId}`, await cardMid(h, id, 'client_demo'));
      expect(await dealStatus(h, id)).toBe('scheduled');
    },
    TIMEOUT,
  );
});

describe('IP-фильтр ЮKassa (CONTRACTS §2.5)', () => {
  it('адреса из списка провайдера проходят', () => {
    expect(ipAllowed('185.71.76.1')).toBe(true);
    expect(ipAllowed('185.71.77.30')).toBe(true);
    expect(ipAllowed('77.75.153.100')).toBe(true);
    expect(ipAllowed('77.75.156.11')).toBe(true);
    expect(ipAllowed('77.75.154.200')).toBe(true);
    expect(ipAllowed('2a02:5180::1')).toBe(true);
    expect(ipAllowed('::ffff:185.71.76.1')).toBe(true);
  });

  it('посторонние адреса не проходят', () => {
    expect(ipAllowed('185.71.76.32')).toBe(false); // вне /27
    expect(ipAllowed('8.8.8.8')).toBe(false);
    expect(ipAllowed('77.75.156.12')).toBe(false); // одиночный адрес, не подсеть
    expect(ipAllowed('2a03:5180::1')).toBe(false);
    expect(ipAllowed('не адрес')).toBe(false);
  });
});
