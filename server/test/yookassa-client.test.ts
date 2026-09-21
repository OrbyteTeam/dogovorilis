// Клиент ЮKassa против подменённого fetch: проверяется то, что реально уходит в сеть,
// но без сети. Эталон запроса и ответов — docs/CONTRACTS.md §2.2, §2.4, §2.6.
import { describe, expect, it } from 'vitest';
import {
  clampDescription,
  createYooKassaClient,
  kopecksToAmountValue,
  type FetchLike,
  type YooKassaPayment,
} from '../src/integrations/yookassa/client.js';
import { IntegrationError } from '../src/errors.js';

const CREDENTIALS = { shopId: '123456', secretKey: 'test_secret_not_real' };

type Call = { url: string; init: RequestInit };

/**
 * Подменённый fetch: отдаёт заготовленные ответы по очереди и запоминает запросы.
 * Ответы задаются функциями, а не готовыми Response: тело Response читается один раз,
 * а повтор запроса (5xx, 429) обращается к тому же элементу очереди второй раз.
 */
type Reply = () => Response;

function fakeFetch(responses: Reply[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return next();
  };
  return { fetch, calls };
}

const json =
  (status: number, body: unknown): Reply =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PAYMENT: YooKassaPayment = {
  id: '22e12f66-000f-5000-8000-18db351245c7',
  status: 'pending',
  paid: false,
  amount: { value: '1500.00', currency: 'RUB' },
  confirmation: {
    type: 'redirect',
    return_url: 'http://localhost:8080/pay/return?d=AbC123xyZ0',
    confirmation_url: 'https://yoomoney.ru/payments/external/confirmation?orderId=22e12f66',
  },
  created_at: '2026-09-21T10:51:18.139Z',
  test: true,
};

const client = (responses: Reply[]) => {
  const { fetch, calls } = fakeFetch(responses);
  return {
    calls,
    api: createYooKassaClient({ credentials: CREDENTIALS, fetchImpl: fetch, retryPauseMs: 0 }),
  };
};

const create = () => ({
  amountKopecks: 150_000,
  description: 'Сделка #AbC123xyZ0: Маникюр',
  returnUrl: 'http://localhost:8080/pay/return?d=AbC123xyZ0',
  metadata: { deal: 'AbC123xyZ0', payment: '7', kind: 'prepayment' },
  idempotenceKey: '2b5e0f1c-0000-4000-8000-0123456789ab',
});

describe('сумма и описание', () => {
  it('копейки превращаются в строку с точкой (CONTRACTS §2.2)', () => {
    expect(kopecksToAmountValue(150_000)).toBe('1500.00');
    expect(kopecksToAmountValue(100)).toBe('1.00');
    expect(kopecksToAmountValue(150_050)).toBe('1500.50');
    expect(kopecksToAmountValue(7)).toBe('0.07');
  });

  it('описание обрезается по границе слова до 128 символов', () => {
    const long = 'Сделка #AbC123xyZ0: ' + 'очень длинное название услуги '.repeat(10);
    const out = clampDescription(long);
    expect(out.length).toBeLessThanOrEqual(128);
    expect(out.endsWith(' ')).toBe(false);
  });

  it('переносы строк в описании схлопываются в пробел', () => {
    expect(clampDescription('Сделка\n\n#1:   стрижка')).toBe('Сделка #1: стрижка');
  });
});

describe('createPayment', () => {
  it('шлёт ровно то, что описано в CONTRACTS §2.2', async () => {
    const { api, calls } = client([json(200, PAYMENT)]);
    const out = await api.createPayment(create());

    expect(out.id).toBe(PAYMENT.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.yookassa.ru/v3/payments');
    expect(calls[0].init.method).toBe('POST');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Basic ' + Buffer.from('123456:test_secret_not_real').toString('base64'));
    expect(headers['Idempotence-Key']).toBe('2b5e0f1c-0000-4000-8000-0123456789ab');
    expect(headers['Content-Type']).toBe('application/json');

    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      amount: { value: '1500.00', currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: 'http://localhost:8080/pay/return?d=AbC123xyZ0', locale: 'ru_RU' },
      description: 'Сделка #AbC123xyZ0: Маникюр',
      metadata: { deal: 'AbC123xyZ0', payment: '7', kind: 'prepayment' },
    });
  });

  it('сумма меньше 1 ₽ не доходит до провайдера (CONTRACTS §2.7)', async () => {
    const { api, calls } = client([json(200, PAYMENT)]);
    await expect(api.createPayment({ ...create(), amountKopecks: 50 })).rejects.toBeInstanceOf(IntegrationError);
    expect(calls).toHaveLength(0);
  });

  it('400 invalid_request отдаётся как IntegrationError и НЕ повторяется', async () => {
    const { api, calls } = client([
      json(400, { type: 'error', code: 'invalid_request', description: 'Idempotence key is too long', parameter: 'Idempotence-Key' }),
    ]);
    const err = await api.createPayment(create()).catch((e: IntegrationError) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).status).toBe(400);
    expect((err as IntegrationError).providerCode).toBe('invalid_request');
    expect((err as IntegrationError).message).toContain('Idempotence-Key');
    expect(calls).toHaveLength(1);
  });

  it('401 invalid_credentials не повторяется — ключи от этого не станут верными', async () => {
    const { api, calls } = client([json(401, { type: 'error', code: 'invalid_credentials' })]);
    const err = await api.createPayment(create()).catch((e: IntegrationError) => e);
    expect((err as IntegrationError).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('в тексте ошибки нет секретного ключа', async () => {
    const { api } = client([json(401, { type: 'error', code: 'invalid_credentials', description: 'Invalid credentials' })]);
    const err = await api.createPayment(create()).catch((e: IntegrationError) => e);
    expect(JSON.stringify(err)).not.toContain('test_secret_not_real');
    expect((err as IntegrationError).message).not.toContain('test_secret_not_real');
  });

  it('429 повторяется один раз с ТЕМ ЖЕ Idempotence-Key', async () => {
    const { api, calls } = client([json(429, { type: 'error', code: 'too_many_requests' }), json(200, PAYMENT)]);
    const out = await api.createPayment(create());
    expect(out.id).toBe(PAYMENT.id);
    expect(calls).toHaveLength(2);
    const [a, b] = calls.map((c) => (c.init.headers as Record<string, string>)['Idempotence-Key']);
    expect(a).toBe(b); // иначе повтор создал бы второй платёж
  });

  it('5xx повторяется один раз, второй отказ — ошибка', async () => {
    const { api, calls } = client([json(500, { type: 'error', code: 'internal_server_error' })]);
    const err = await api.createPayment(create()).catch((e: IntegrationError) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect((err as IntegrationError).status).toBe(500);
    expect(calls).toHaveLength(2);
  });

  it('сетевая ошибка повторяется один раз и даёт status = null', async () => {
    const boom: Reply = () => {
      throw new TypeError('fetch failed');
    };
    const { api, calls } = client([boom]);
    const err = await api.createPayment(create()).catch((e: IntegrationError) => e);
    expect((err as IntegrationError).status).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('ответ без id/status — ошибка, а не «успех» с пустым платежом', async () => {
    const { api } = client([json(200, { hello: 'world' })]);
    await expect(api.createPayment(create())).rejects.toBeInstanceOf(IntegrationError);
  });
});

describe('getPayment', () => {
  it('GET без Idempotence-Key (CONTRACTS §2.4)', async () => {
    const { api, calls } = client([json(200, { ...PAYMENT, status: 'succeeded', paid: true })]);
    const out = await api.getPayment(PAYMENT.id);

    expect(out.status).toBe('succeeded');
    expect(calls[0].url).toBe(`https://api.yookassa.ru/v3/payments/${PAYMENT.id}`);
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>)['Idempotence-Key']).toBeUndefined();
  });

  it('404 not_found не повторяется', async () => {
    const { api, calls } = client([json(404, { type: 'error', code: 'not_found' })]);
    await expect(api.getPayment('нет-такого')).rejects.toBeInstanceOf(IntegrationError);
    expect(calls).toHaveLength(1);
  });
});
