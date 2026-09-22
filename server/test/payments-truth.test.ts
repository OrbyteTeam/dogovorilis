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
import { LinkInProgressError } from '../src/errors.js';
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
});
