// ЮKassa API v3 — тестовый магазин. Дословный контракт: docs/CONTRACTS.md §2, применение: SPEC §9.2.
// Без SDK: официального Node-SDK у ЮKassa нет, единственный на npm неофициальный и не обновлялся 4 года
// (CONTRACTS §2.8). Поэтому голый fetch с ручными заголовками.
//
// Секреты: shopId и secretKey не попадают ни в один лог — ни в сообщение ошибки, ни в поля.
import { IntegrationError } from '../../errors.js';
import { log } from '../../logger.js';

export const YOOKASSA_API = 'https://api.yookassa.ru/v3';
/** CONTRACTS §2.1: «Если в течение 30 секунд невозможно дать точный ответ» — но нам столько ждать нельзя (SPEC §17). */
export const TIMEOUT_MS = 10_000;
/** SPEC §9.2: один повтор при сетевой ошибке/5xx — с тем же Idempotence-Key, иначе создадим второй платёж. */
export const RETRY_PAUSE_MS = 500;
/** CONTRACTS §2.2: «Описание транзакции (не более 128 символов)». */
export const DESCRIPTION_MAX = 128;
/** CONTRACTS §2.7: минимум для банковской карты — 1 рубль. */
export const MIN_AMOUNT_KOPECKS = 100;

export type YooKassaStatus = 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';

/** Объект Payment (CONTRACTS §2.2). Берём только поля, которые действительно используем. */
export type YooKassaPayment = {
  id: string;
  status: YooKassaStatus;
  paid: boolean;
  amount: { value: string; currency: string };
  description?: string;
  confirmation?: { type: string; return_url?: string; confirmation_url?: string };
  cancellation_details?: { party?: string; reason?: string };
  metadata?: Record<string, string>;
  expires_at?: string;
  created_at: string;
  test?: boolean;
};

export type CreatePaymentArgs = {
  amountKopecks: number;
  description: string;
  returnUrl: string;
  /** CONTRACTS §2.2: максимум 16 ключей, значение — строка UTF-8 ≤ 512. */
  metadata: Record<string, string>;
  /** payments.idempotence_key — он же Idempotence-Key (CONTRACTS §2.1, ≤ 64 символов). */
  idempotenceKey: string;
};

export type YooKassaCredentials = { shopId: string; secretKey: string };

export interface YooKassaClient {
  createPayment(args: CreatePaymentArgs): Promise<YooKassaPayment>;
  getPayment(paymentId: string): Promise<YooKassaPayment>;
}

/** Подменяется в тестах; в проде — глобальный fetch Node 22. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ClientOptions = {
  credentials: YooKassaCredentials;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  retryPauseMs?: number;
};

/** «1500.00» — CONTRACTS §2.2: «в виде строки с точкой-разделителем». */
export function kopecksToAmountValue(kopecks: number): string {
  const abs = Math.round(Math.abs(kopecks));
  return `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Обрезка описания по границе слова: провайдер иначе ответит 400 invalid_request. */
export function clampDescription(text: string, max = DESCRIPTION_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createYooKassaClient(o: ClientOptions): YooKassaClient {
  const fetchImpl = o.fetchImpl ?? ((url, init) => fetch(url, init));
  const baseUrl = (o.baseUrl ?? YOOKASSA_API).replace(/\/+$/, '');
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const retryPauseMs = o.retryPauseMs ?? RETRY_PAUSE_MS;
  const auth = 'Basic ' + Buffer.from(`${o.credentials.shopId}:${o.credentials.secretKey}`).toString('base64');

  async function call(op: string, path: string, init: RequestInit, idempotenceKey?: string): Promise<YooKassaPayment> {
    // Ровно две попытки: SPEC §9.2 «1 повтор при сетевой ошибке/5xx». Ключ идемпотентности тот же,
    // поэтому повтор POST не создаёт второй платёж (CONTRACTS §2.1).
    let lastError: IntegrationError | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await once(op, path, init, idempotenceKey);
      } catch (e) {
        const err = e as IntegrationError;
        lastError = err;
        const retriable = err.status === null || err.status >= 500 || err.status === 429;
        if (!retriable || attempt === 2) throw err;
        log.warn({ provider: 'yookassa', op, status: err.status, attempt }, 'ЮKassa: повтор запроса');
        await sleep(retryPauseMs);
      }
    }
    throw lastError ?? new IntegrationError('yookassa', op, null, null, 'неизвестная ошибка');
  }

  async function once(op: string, path: string, init: RequestInit, idempotenceKey?: string): Promise<YooKassaPayment> {
    const headers: Record<string, string> = { Authorization: auth, Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // Таймаут и обрыв связи неотличимы для вызывающего: и то и другое — «провайдер недоступен» (E9).
      const reason = (e as Error)?.name === 'TimeoutError' ? `таймаут ${timeoutMs} мс` : ((e as Error)?.message ?? 'сетевая ошибка');
      throw new IntegrationError('yookassa', op, null, null, reason);
    }

    const text = await res.text();
    const body = parseJson(text);

    if (!res.ok) {
      const e = body as { code?: string; description?: string; parameter?: string } | null;
      throw new IntegrationError(
        'yookassa',
        op,
        res.status,
        e?.code ?? null,
        // description приходит от провайдера на английском и секретов не содержит (CONTRACTS §2.6).
        [e?.description, e?.parameter && `параметр ${e.parameter}`].filter(Boolean).join('; ') || `HTTP ${res.status}`,
      );
    }
    if (!isPayment(body)) {
      throw new IntegrationError('yookassa', op, res.status, null, 'ответ без обязательных полей id/status');
    }
    return body;
  }

  return {
    async createPayment(args) {
      if (args.amountKopecks < MIN_AMOUNT_KOPECKS) {
        throw new IntegrationError('yookassa', 'createPayment', null, 'amount_too_small', 'минимальная сумма платежа — 1 ₽');
      }
      const payment = await call(
        'createPayment',
        '/payments',
        {
          method: 'POST',
          body: JSON.stringify({
            amount: { value: kopecksToAmountValue(args.amountKopecks), currency: 'RUB' },
            capture: true, // одностадийный платёж: succeeded сразу после оплаты (CONTRACTS §2.3)
            confirmation: { type: 'redirect', return_url: args.returnUrl, locale: 'ru_RU' },
            description: clampDescription(args.description),
            metadata: args.metadata,
          }),
        },
        args.idempotenceKey,
      );
      log.info(
        { provider: 'yookassa', op: 'createPayment', payment: payment.id, status: payment.status, test: payment.test },
        'ЮKassa: платёж создан',
      );
      return payment;
    },

    async getPayment(paymentId) {
      // GET идемпотентен сам по себе — Idempotence-Key не нужен (CONTRACTS §2.4).
      return call('getPayment', `/payments/${encodeURIComponent(paymentId)}`, { method: 'GET' });
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function isPayment(v: unknown): v is YooKassaPayment {
  const p = v as YooKassaPayment | null;
  return Boolean(p && typeof p.id === 'string' && typeof p.status === 'string');
}
