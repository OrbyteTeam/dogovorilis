// Поддельная ЮKassa для тестов рейла «ссылка»: хранит платежи в памяти, умеет «оплатить» и «отменить» их
// так же, как это сделал бы настоящий магазин. Никакой сети — проверяется наша логика, не чужая.
// Подставляется через rails.setYooKassaClient() (CONTRACTS §2).
import { IntegrationError } from '../../src/errors.js';
import type { CreatePaymentArgs, YooKassaClient, YooKassaPayment } from '../../src/integrations/yookassa/client.js';

export function createFakeYooKassa() {
  const payments = new Map<string, YooKassaPayment>();
  const created: CreatePaymentArgs[] = [];
  let seq = 0;
  let failNext: IntegrationError | null = null;
  let createDelayMs = 0;
  const getCalls: string[] = [];

  const api: YooKassaClient = {
    async createPayment(args) {
      created.push(args);
      // Настоящий провайдер отвечает не мгновенно: на этой паузе и ловится двойной тап (ЗАДАЧА_03 F3).
      if (createDelayMs > 0) await new Promise((r) => setTimeout(r, createDelayMs));
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
    /** Сколько «думает» провайдер при создании платежа. */
    delayCreate(ms: number) {
      createDelayMs = ms;
    },
    lastId: () => `pay-${seq}`,
  };
}

export type FakeYooKassa = ReturnType<typeof createFakeYooKassa>;
