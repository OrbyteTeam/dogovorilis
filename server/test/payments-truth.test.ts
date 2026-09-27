// Платежи: провайдер — источник истины (ЗАДАЧА_03 F, аудит 22.09 §3.5).
//
// Настоящая сделка двух людей (исполнитель через API мини-приложения, клиент по ссылке), настоящая БД,
// MAX подменён на уровне HTTP, ЮKassa — на уровне клиента. Проверяем то, что видят стороны и что лежит в БД:
//   F1 — оплата после локального expired/canceled учитывается (или честно требует возврата);
//   F2 — опрос не объявляет ссылку истёкшей, если провайдер уже сказал succeeded;
//   F3 — двойной тап «Оплатить по ссылке» создаёт у провайдера ровно один платёж;
//   F4 — succeeded без перехода сделки чинится следующим же применением статуса;
//   F5 — tax_mode='none' закрывается сам на любом пути подтверждения, квитанция уходит обеим;
//   F6 — «Перевёл / Получил / Не вижу» только для живого перевода того вида, который сделка ждёт;
//   F7 — отмена при заявленном переводе предупреждает обе стороны и ждёт возврата.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import * as rails from '../src/domain/payment/rails.js';
import { IntegrationError, LinkInProgressError } from '../src/errors.js';
import { formatMoney } from '../src/domain/money.js';
import { pollLinkPayments } from '../src/scheduler/jobs/payments-poll.js';
import { cardMid, createHarness, dealStatus, livePaymentId, truncateAll, type Harness } from './helpers/harness.js';
import { createFakeYooKassa, type FakeYooKassa } from './helpers/yookassa-fake.js';

const DB = process.env.TEST_DATABASE_URL;

const SELLER = 4001;
const SELLER_CHAT = 8001;
const CLIENT = 4002;
const CLIENT_CHAT = 8002;
const PAYOUT = 'СБП +7 900 000-00-00, Т-Банк';

const TIMEOUT = 120_000;

describe.skipIf(!DB)('платежи: провайдер — источник истины', () => {
  let h: Harness;
  let yk: FakeYooKassa;

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

  type DealOpts = { taxMode?: 'npd' | 'none'; totalRub?: number; prepaymentRub?: number };

  /** Сделка двух людей: исполнитель создаёт через API мини-приложения, клиент входит по ссылке и подтверждает. */
  async function confirmedDeal(o: DealOpts = {}): Promise<{ id: string; sellerCard: string; clientCard: string }> {
    await h.start(SELLER, SELLER_CHAT);
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'beauty',
      title: 'Маникюр с покрытием',
      total_rub: o.totalRub ?? 2500,
      prepayment_rub: o.prepaymentRub ?? 500,
      scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      cancel_rule: 'free_24h',
      profile: {
        display_name: 'Анна Мастер',
        tax_mode: o.taxMode ?? 'npd',
        payout_details: PAYOUT,
        transfer_enabled: true,
        link_enabled: true,
        default_cancel_rule: 'free_24h',
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const id = res.json.deal.public_id as string;
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const clientCard = await cardMid(h, id, 'client');
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    return { id, sellerCard: await cardMid(h, id, 'seller'), clientCard };
  }

  /** Клиент нажал «Оплатить по ссылке»: id платежа у нас и у провайдера. */
  async function issueLink(id: string): Promise<{ paymentId: number; providerId: string }> {
    await h.press(CLIENT, CLIENT_CHAT, `pl:${id}`, await cardMid(h, id, 'client'));
    const paymentId = await livePaymentId(h, id, 'prepayment');
    const rows = await h.query<{ provider_payment_id: string }>('SELECT provider_payment_id FROM payments WHERE id = $1', [paymentId]);
    return { paymentId, providerId: rows[0].provider_payment_id };
  }

  const payments = (id: string) =>
    h.query<{ id: number; kind: string; rail: string; status: string; provider_status: string | null; cancellation_reason: string | null }>(
      `SELECT p.id, p.kind, p.rail, p.status, p.provider_status, p.cancellation_reason
       FROM payments p JOIN deals d ON d.id = p.deal_id WHERE d.public_id = $1 ORDER BY p.id`,
      [id],
    );

  const labels = (mid: string) => (h.max.byMid(mid)?.buttons ?? []).map((b) => b.text);

  /** Ответ на последнее нажатие (POST /answers). */
  const lastAnswer = () => h.max.sent.filter((m) => m.kind === 'answer').at(-1)?.text ?? '';

  /** Клиент выбрал перевод и нажал «Я перевёл(а)»: платёж claimed, у исполнителя P2 и кнопки в карточке. */
  async function claimedTransfer(o: DealOpts = {}) {
    const d = await confirmedDeal(o);
    await h.press(CLIENT, CLIENT_CHAT, `pt:${d.id}`, d.clientCard);
    const pid = await livePaymentId(h, d.id, 'prepayment');
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${d.id}:${pid}`, d.clientCard);
    return { ...d, pid };
  }

  describe('F3: двойной тап «Оплатить по ссылке»', () => {
    it('параллельные вызовы — ровно один createPayment у провайдера, второй получает «ссылка формируется»', async () => {
      const { id } = await confirmedDeal();
      yk.delayCreate(300);
      const actor = { userId: CLIENT, role: 'client' as const };

      const results = await Promise.allSettled([rails.createLinkPayment(id, actor), rails.createLinkPayment(id, actor)]);

      expect(yk.created).toHaveLength(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(LinkInProgressError);

      const rows = await payments(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rail: 'link', status: 'pending' });
    }, TIMEOUT);

    it('два быстрых нажатия кнопкой: один платёж, второй ответ — «Ссылка формируется» над карточкой', async () => {
      const { id, clientCard } = await confirmedDeal();
      yk.delayCreate(300);
      const mark = h.max.sent.length;

      await Promise.all([h.press(CLIENT, CLIENT_CHAT, `pl:${id}`, clientCard), h.press(CLIENT, CLIENT_CHAT, `pl:${id}`, clientCard)]);

      expect(yk.created).toHaveLength(1);
      const answers = h.max.sent.slice(mark).filter((m) => m.kind === 'answer');
      const busy = answers.find((a) => a.text.startsWith(texts.LINK_IN_PROGRESS));
      expect(busy, answers.map((a) => a.text.slice(0, 60)).join(' | ')).toBeDefined();
      expect(busy!.text).toContain('Маникюр с покрытием'); // это карточка с заметкой, а не голый текст
      expect(await payments(id)).toHaveLength(1);
    }, TIMEOUT);

    it('ссылка без confirmation_url старше 30 с — сбойная: отменяется, создаётся новая', async () => {
      const { id, clientCard } = await confirmedDeal();
      // Процесс упал между «занять слот» и ответом провайдера: платёж есть, ссылки нет, прошла минута.
      await h.query(
        `INSERT INTO payments (deal_id, kind, rail, provider, amount_kopecks, created_at)
         SELECT id, 'prepayment', 'link', 'yookassa', 50000, now() - interval '60 seconds' FROM deals WHERE public_id = $1`,
        [id],
      );

      await h.press(CLIENT, CLIENT_CHAT, `pl:${id}`, clientCard);

      expect(yk.created).toHaveLength(1);
      const rows = await payments(id);
      expect(rows.map((r) => r.status)).toEqual(['canceled', 'pending']);
      expect(labels(clientCard)).toContain(texts.BTN.goToPayment);
    }, TIMEOUT);
  });

  describe('F6: шаги перевода — только для живого перевода, который сделка ждёт', () => {
    it('«Получил(а)» из уведомления P2 по отменённой сделке → E1, платёж не становится succeeded', async () => {
      const { id, sellerCard, pid } = await claimedTransfer();
      await h.press(SELLER, SELLER_CHAT, `cn:y:${id}:none`, sellerCard);
      expect(await dealStatus(h, id)).toBe('cancelled');

      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, null); // кнопка в сообщении P2, а не в карточке
      expect(lastAnswer()).toBe(texts.E1);
      expect((await payments(id)).map((p) => p.status)).toEqual(['canceled']);
      expect(await dealStatus(h, id)).toBe('cancelled');

      await h.press(SELLER, SELLER_CHAT, `tr:n:${id}:${pid}`, null);
      expect(lastAnswer()).toBe(texts.E1);
    }, TIMEOUT);

    it('«Я перевёл(а)» по уже подтверждённому переводу → E1 над карточкой, P2 повторно не уходит', async () => {
      const { id, sellerCard, clientCard, pid } = await claimedTransfer();
      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, sellerCard);
      expect(await dealStatus(h, id)).toBe('scheduled');

      const mark = h.max.sent.length;
      await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
      expect(h.max.byMid(clientCard)!.text.startsWith(texts.E1)).toBe(true);
      expect(h.max.sent.slice(mark).some((m) => m.kind === 'send' && m.text.includes('сообщает о переводе'))).toBe(false);
    }, TIMEOUT);

    it('кнопки перевода с id ссылочного платежа → E1, ссылка жива', async () => {
      const { id, clientCard } = await confirmedDeal();
      const { paymentId } = await issueLink(id);

      await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${paymentId}`, clientCard);
      expect(h.max.byMid(clientCard)!.text.startsWith(texts.E1)).toBe(true);
      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${paymentId}`, null);
      expect(lastAnswer()).toBe(texts.E1);

      expect((await payments(id)).map((p) => [p.rail, p.status])).toEqual([['link', 'pending']]);
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');
    }, TIMEOUT);
  });

  describe('F7: отмена, когда клиент уже сообщил о переводе', () => {
    it('обе стороны получают «Клиент сообщал о переводе …», возврат ожидается, строка — в карточках', async () => {
      const { id, sellerCard, clientCard } = await claimedTransfer();
      const mark = h.max.sent.length;

      await h.press(SELLER, SELLER_CHAT, `cn:y:${id}:none`, sellerCard);

      const deal = await h.query<{ cancel_refund_expected: boolean }>('SELECT cancel_refund_expected FROM deals WHERE public_id = $1', [id]);
      expect(deal[0].cancel_refund_expected).toBe(true);
      const rows = await payments(id);
      expect(rows[0]).toMatchObject({ status: 'canceled', cancellation_reason: 'deal_cancelled_after_claim' });

      const claim = `Клиент сообщал о переводе ${formatMoney(50_000)}`;
      const sent = h.max.sent.slice(mark).filter((m) => m.kind === 'send');
      // N15 клиенту — с предупреждением; отменившему исполнителю — отдельным сообщением
      expect(sent.some((m) => m.chatId === CLIENT_CHAT && m.text.startsWith('🚫') && m.text.includes(claim))).toBe(true);
      expect(sent.some((m) => m.chatId === SELLER_CHAT && m.text.includes(claim))).toBe(true);
      // строка возврата в карточках обеих сторон
      expect(h.max.byMid(sellerCard)!.text).toContain(claim);
      expect(h.max.byMid(clientCard)!.text).toContain(claim);
      expect(h.max.byMid(clientCard)!.text).toContain('проверьте поступление и верните при необходимости');
      // «Предоплата …: ожидается возврат» не пишем — получение предоплаты никто не подтверждал
      expect(h.max.byMid(clientCard)!.text).not.toContain('ожидается возврат');
    }, TIMEOUT);

    it('клиент отменяет сам — предупреждение тоже уходит обеим', async () => {
      const { id, clientCard } = await claimedTransfer();
      const mark = h.max.sent.length;

      await h.press(CLIENT, CLIENT_CHAT, `cn:y:${id}`, clientCard);

      expect(await dealStatus(h, id)).toBe('cancelled');
      const claim = `Клиент сообщал о переводе ${formatMoney(50_000)}`;
      const sent = h.max.sent.slice(mark).filter((m) => m.kind === 'send');
      expect(sent.some((m) => m.chatId === SELLER_CHAT && m.text.startsWith('🚫') && m.text.includes(claim))).toBe(true);
      expect(sent.some((m) => m.chatId === CLIENT_CHAT && m.text.includes(claim))).toBe(true);
    }, TIMEOUT);
  });

  // ─────────────── F1, F2, F4, F5: применение статуса провайдера ───────────────

  const webhook = (event: string, providerId: string) =>
    h.webhook('/webhooks/yookassa', { type: 'notification', event, object: { id: providerId, status: 'succeeded' } }, '185.71.76.1');

  /** Обработка вебхука и отправка квитанции идут после ответа 200 — ждём условие, а не угадываем паузу. */
  async function waitFor(what: string, cond: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`не дождались: ${what}`);
  }

  const webhookDone = async () => (await h.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_log WHERE result IS NULL'))[0].n === 0;

  const events = (id: string, type: string) =>
    h.query<{ payload: Record<string, unknown> }>(
      `SELECT e.payload FROM deal_events e JOIN deals d ON d.id = e.deal_id WHERE d.public_id = $1 AND e.type = $2 ORDER BY e.seq`,
      [id, type],
    );

  const sentTo = (chatId: number, from = 0) => h.max.sent.slice(from).filter((m) => m.kind === 'send' && m.chatId === chatId);

  /** Квитанция PDF (вложение file) ушла обеим сторонам. */
  const receiptSentToBoth = (from: number) =>
    [SELLER_CHAT, CLIENT_CHAT].every((chat) => sentTo(chat, from).some((m) => m.attachmentTypes.includes('file')));

  /** Два часа спустя — ссылка (1 ч) по нашим часам истекла. */
  const later = () => new Date(Date.now() + 2 * 3_600_000);

  /** Предоплата переводом, «Выполнено», «Принимаю» — сделка ждёт остаток. */
  async function awaitingFinal(o: DealOpts = {}) {
    const d = await claimedTransfer(o);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${d.id}:${d.pid}`, d.sellerCard);
    await h.press(SELLER, SELLER_CHAT, `dn:${d.id}`, d.sellerCard);
    await h.press(CLIENT, CLIENT_CHAT, `ac:${d.id}`, d.clientCard);
    expect(await dealStatus(h, d.id)).toBe('awaiting_payment');
    return d;
  }

  describe('F1: оплата после локального expired / canceled', () => {
    it('ссылка истекла по нашим часам, клиент заплатил позже → оплата учтена, T9, N8 обеим', async () => {
      const { id } = await confirmedDeal();
      const { paymentId, providerId } = await issueLink(id);
      await pollLinkPayments(h.gateway, later());
      expect((await payments(id))[0].status).toBe('expired');

      const mark = h.max.sent.length;
      yk.succeed(providerId);
      await webhook('payment.succeeded', providerId);
      await waitFor('вебхук обработан', webhookDone);

      expect((await payments(id))[0]).toMatchObject({ id: paymentId, status: 'succeeded' });
      expect(await dealStatus(h, id)).toBe('scheduled');
      expect((await events(id, 'payment.succeeded_late'))[0].payload).toMatchObject({ payment_id: paymentId, was: 'expired' });
      await waitFor('N8 обеим', () => [SELLER_CHAT, CLIENT_CHAT].every((c) => sentTo(c, mark).some((m) => m.text.includes('получена'))));
    }, TIMEOUT);

    it('после истёкшей уже выдана новая ссылка: старая оплачена → новая вытесняется, сделка сдвигается', async () => {
      const { id, clientCard } = await confirmedDeal();
      const first = await issueLink(id);
      await pollLinkPayments(h.gateway, later());
      await h.press(CLIENT, CLIENT_CHAT, `nl:${id}`, clientCard);
      const secondId = await livePaymentId(h, id, 'prepayment');
      expect(secondId).not.toBe(first.paymentId);

      yk.succeed(first.providerId);
      await webhook('payment.succeeded', first.providerId);
      await waitFor('вебхук обработан', webhookDone);

      const rows = await payments(id);
      expect(rows.find((p) => p.id === first.paymentId)?.status).toBe('succeeded');
      expect(rows.find((p) => p.id === secondId)).toMatchObject({ status: 'canceled', cancellation_reason: 'superseded_by_late_success' });
      expect((await events(id, 'payment.canceled')).some((e) => e.payload.reason === 'superseded_by_late_success')).toBe(true);
      expect(await dealStatus(h, id)).toBe('scheduled');
    }, TIMEOUT);

    it('сделка отменена, а оплата по живой ссылке пришла → сделка не двигается, возврат ожидается, «верните» обеим', async () => {
      const { id, sellerCard } = await confirmedDeal();
      const { paymentId, providerId } = await issueLink(id);
      await h.press(SELLER, SELLER_CHAT, `cn:y:${id}:none`, sellerCard);
      expect((await payments(id))[0].status).toBe('canceled');

      const mark = h.max.sent.length;
      yk.succeed(providerId);
      await webhook('payment.succeeded', providerId);
      await waitFor('вебхук обработан', webhookDone);

      expect(await dealStatus(h, id)).toBe('cancelled');
      const deal = await h.query<{ cancel_refund_expected: boolean }>('SELECT cancel_refund_expected FROM deals WHERE public_id = $1', [id]);
      expect(deal[0].cancel_refund_expected).toBe(true);
      expect((await payments(id))[0]).toMatchObject({ id: paymentId, status: 'succeeded' });
      expect((await events(id, 'payment.succeeded_late'))[0].payload).toMatchObject({ refund_required: true, reason: 'deal_cancelled' });

      const refund = texts.LATE_PAYMENT_REFUND({ id, sumKopecks: 50_000, dealCancelled: true });
      expect(refund).toContain('по отменённой сделке');
      await waitFor('«верните» обеим', () => [SELLER_CHAT, CLIENT_CHAT].every((c) => sentTo(c, mark).some((m) => m.text === refund)));
      expect(h.max.byMid(sellerCard)!.text).toContain('ожидается возврат');

      // Повторное применение (опрос, «Проверить оплату») второго «верните деньги» не шлёт.
      const again = h.max.sent.length;
      await rails.refreshFromProvider(paymentId);
      expect(await events(id, 'payment.succeeded_late')).toHaveLength(1);
      expect(h.max.sent.slice(again).some((m) => m.text === refund)).toBe(false);
    }, TIMEOUT);

    it('этап уже оплачен переводом, а старая ссылка тоже оплачена → двойная оплата: сделка стоит, «верните» обеим', async () => {
      const { id, sellerCard, clientCard } = await confirmedDeal();
      const link = await issueLink(id);
      await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard); // передумал: ссылка canceled (rail_switch)
      const transfer = await livePaymentId(h, id, 'prepayment');
      await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${transfer}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${transfer}`, sellerCard);
      expect(await dealStatus(h, id)).toBe('scheduled');

      const mark = h.max.sent.length;
      yk.succeed(link.providerId);
      await webhook('payment.succeeded', link.providerId);
      await waitFor('вебхук обработан', webhookDone);

      expect(await dealStatus(h, id)).toBe('scheduled');
      // «Один живой платёж на (сделку, вид)»: второй succeeded того же вида невозможен — факт в provider_status и событии.
      expect((await payments(id)).find((p) => p.id === link.paymentId)).toMatchObject({ status: 'canceled', provider_status: 'succeeded' });
      expect((await events(id, 'payment.succeeded_late'))[0].payload).toMatchObject({ refund_required: true, reason: 'already_paid' });
      const refund = texts.LATE_PAYMENT_REFUND({ id, sumKopecks: 50_000, dealCancelled: false });
      expect(refund).toContain('по уже оплаченному этапу');
      await waitFor('«верните» обеим', () => [SELLER_CHAT, CLIENT_CHAT].every((c) => sentTo(c, mark).some((m) => m.text === refund)));
    }, TIMEOUT);
  });

  describe('F2: опрос перед истечением спрашивает провайдера', () => {
    it('клиент заплатил, вебхук не дошёл, срок ссылки вышел → не expired, а succeeded и T9', async () => {
      const { id } = await confirmedDeal();
      const { paymentId, providerId } = await issueLink(id);
      yk.succeed(providerId);

      await pollLinkPayments(h.gateway, later());

      expect(yk.getCalls).toContain(providerId);
      expect((await payments(id))[0]).toMatchObject({ id: paymentId, status: 'succeeded' });
      expect(await dealStatus(h, id)).toBe('scheduled');
      expect((await events(id, 'payment.canceled')).some((e) => e.payload.reason === 'link_expired')).toBe(false);
    }, TIMEOUT);

    it('провайдер недоступен в момент истечения → ссылка не объявляется истёкшей вслепую', async () => {
      const { id } = await confirmedDeal();
      const { providerId } = await issueLink(id);
      const realGet = yk.api.getPayment;
      yk.api.getPayment = async () => {
        throw new IntegrationError('yookassa', 'getPayment', null, null, 'таймаут');
      };
      try {
        await pollLinkPayments(h.gateway, later());
      } finally {
        yk.api.getPayment = realGet;
      }
      expect((await payments(id))[0].status).toBe('pending');

      // Провайдер ожил и говорит pending — теперь истечение честное.
      await pollLinkPayments(h.gateway, later());
      expect((await payments(id))[0].status).toBe('expired');
      expect(yk.getCalls).toContain(providerId);
    }, TIMEOUT);
  });

  describe('F4: succeeded без перехода сделки чинится следующим применением', () => {
    /** Процесс «упал» между транзакциями: платёж succeeded, сделка всё ещё ждёт предоплату. */
    async function crashAfterPaymentTx(paymentId: number, minutesAgo = 0): Promise<void> {
      await h.query(`UPDATE payments SET status = 'succeeded', succeeded_at = now() - make_interval(mins => $2) WHERE id = $1`, [
        paymentId,
        minutesAgo,
      ]);
    }

    it('«Проверить оплату» по уже succeeded платежу доводит сделку', async () => {
      const { id, clientCard } = await confirmedDeal();
      const { paymentId, providerId } = await issueLink(id);
      yk.succeed(providerId);
      await crashAfterPaymentTx(paymentId);
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');

      await h.press(CLIENT, CLIENT_CHAT, `pc:${id}:${paymentId}`, clientCard);
      expect(await dealStatus(h, id)).toBe('scheduled');
      expect(await events(id, 'payment.succeeded')).toHaveLength(1);

      // Ещё раз — «уже сделано», второго перехода и события нет.
      await h.press(CLIENT, CLIENT_CHAT, `pc:${id}:${paymentId}`, clientCard);
      expect(h.max.byMid(clientCard)!.text.startsWith(texts.ALREADY_DONE)).toBe(true);
      expect(await events(id, 'payment.succeeded')).toHaveLength(1);
    }, TIMEOUT);

    it('повтор вебхука после падения доводит сделку', async () => {
      const { id } = await confirmedDeal();
      const { paymentId, providerId } = await issueLink(id);
      yk.succeed(providerId);
      await crashAfterPaymentTx(paymentId);

      await webhook('payment.succeeded', providerId);
      await waitFor('вебхук обработан', webhookDone);
      expect(await dealStatus(h, id)).toBe('scheduled');
      expect((await h.query<{ result: string }>('SELECT result FROM webhook_log'))[0].result).toBe('ok');
    }, TIMEOUT);

    it('опрос планировщика доводит сделку по зависшему succeeded — и по переводу тоже, N8 обеим', async () => {
      const { id, clientCard } = await confirmedDeal();
      await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
      const pid = await livePaymentId(h, id, 'prepayment');
      await crashAfterPaymentTx(pid, 5);

      const mark = h.max.sent.length;
      await pollLinkPayments(h.gateway, new Date());
      expect(await dealStatus(h, id)).toBe('scheduled');
      expect([SELLER_CHAT, CLIENT_CHAT].every((c) => sentTo(c, mark).some((m) => m.text.includes('получена')))).toBe(true);

      // Только что подтверждённые не трогаем: их переход доводит тот, кто подтвердил.
      const fresh = await confirmedDeal();
      await h.press(CLIENT, CLIENT_CHAT, `pt:${fresh.id}`, fresh.clientCard);
      const freshPid = await livePaymentId(h, fresh.id, 'prepayment');
      await crashAfterPaymentTx(freshPid, 0);
      await pollLinkPayments(h.gateway, new Date());
      expect(await dealStatus(h, fresh.id)).toBe('awaiting_prepayment');
    }, TIMEOUT);

    it('«Получил(а)» по уже succeeded переводу доводит сделку, а не отвечает «уже сделано»', async () => {
      const { id, sellerCard, pid } = await claimedTransfer();
      await crashAfterPaymentTx(pid);
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');

      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, sellerCard);
      expect(await dealStatus(h, id)).toBe('scheduled');
      expect(labels(sellerCard)).toContain(texts.BTN.done);
    }, TIMEOUT);
  });

  describe('F5: tax_mode=none закрывается сам на любом пути подтверждения', () => {
    it('вебхук ЮKassa на остаток → closed, квитанция PDF обеим', async () => {
      const { id, clientCard } = await awaitingFinal({ taxMode: 'none' });
      await h.press(CLIENT, CLIENT_CHAT, `pl:${id}`, clientCard);
      const finalId = await livePaymentId(h, id, 'final');
      const providerId = (await h.query<{ provider_payment_id: string }>('SELECT provider_payment_id FROM payments WHERE id = $1', [finalId]))[0]
        .provider_payment_id;

      const mark = h.max.sent.length;
      yk.succeed(providerId);
      await webhook('payment.succeeded', providerId);
      await waitFor('вебхук обработан', webhookDone);

      expect(await dealStatus(h, id)).toBe('closed');
      await waitFor('квитанция обеим', () => receiptSentToBoth(mark));
      expect(await events(id, 'deal.closed')).toHaveLength(1);
    }, TIMEOUT);

    it('опрос планировщика на остаток → closed, квитанция обеим', async () => {
      const { id, clientCard } = await awaitingFinal({ taxMode: 'none' });
      await h.press(CLIENT, CLIENT_CHAT, `pl:${id}`, clientCard);
      yk.succeed(yk.lastId());

      const mark = h.max.sent.length;
      await pollLinkPayments(h.gateway, new Date(Date.now() + 2 * 60_000));

      expect(await dealStatus(h, id)).toBe('closed');
      expect(receiptSentToBoth(mark)).toBe(true);
    }, TIMEOUT);

    it('«Получил(а)» по переводу остатка → closed, квитанция обеим', async () => {
      const { id, sellerCard, clientCard } = await awaitingFinal({ taxMode: 'none' });
      await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
      const finalId = await livePaymentId(h, id, 'final');
      await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${finalId}`, clientCard);

      const mark = h.max.sent.length;
      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${finalId}`, sellerCard);

      expect(await dealStatus(h, id)).toBe('closed');
      expect(receiptSentToBoth(mark)).toBe(true);
      expect(labels(sellerCard)).toEqual([texts.BTN.receiptPdf, texts.BTN.repeat]); // «🔁 Повторить» — ЗАДАЧА_04 F
    }, TIMEOUT);

    it('«Принимаю» при нулевом остатке → closed, квитанция обеим', async () => {
      const d = await claimedTransfer({ taxMode: 'none', totalRub: 1000, prepaymentRub: 1000 });
      await h.press(SELLER, SELLER_CHAT, `tr:g:${d.id}:${d.pid}`, d.sellerCard);
      await h.press(SELLER, SELLER_CHAT, `dn:${d.id}`, d.sellerCard);

      const mark = h.max.sent.length;
      await h.press(CLIENT, CLIENT_CHAT, `ac:${d.id}`, d.clientCard);

      expect(await dealStatus(h, d.id)).toBe('closed');
      expect(receiptSentToBoth(mark)).toBe(true);
    }, TIMEOUT);
  });
});
