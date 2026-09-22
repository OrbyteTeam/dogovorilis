// Таймаут и повтор вызовов MAX Bot API (ЗАДАЧА_03 G4: внешние вызовы — с таймаутом и ретраем).
// У SDK своего таймаута нет (CONTRACTS §1.2): без обёртки зависший запрос держал бы обработчик кнопки вечно.
// Сеть не нужна: «сервер» здесь — функция fetch, которая молчит, падает или отвечает по сценарию теста.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resilientFetch } from '../src/integrations/max/gateway.js';
import { log } from '../src/logger.js';

const OPTS = { timeoutMs: 50, longPollTimeoutMs: 400, retryDelayMs: 10 };
const API = 'https://platform-api2.max.ru';

/** Сервер, который не отвечает: запрос живёт, пока его не оборвёт сигнал. */
const silent: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  });

/** Ответ через `ms` миллисекунд (если сигнал не оборвёт раньше). */
const slow =
  (ms: number): typeof fetch =>
  (_input, init) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response('{"ok":true}', { status: 200 })), ms);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(init.signal!.reason);
      });
    });

describe('resilientFetch: таймаут и один повтор', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('нет ответа → таймаут → повтор через паузу → понятная ошибка и лог без токена', async () => {
    const warn = vi.spyOn(log, 'warn');
    let calls = 0;
    const f = resilientFetch((input, init) => {
      calls += 1;
      return silent(input, init);
    }, OPTS);

    const err = await f(`${API}/messages?message_id=mid-1&chat_id=42`, { method: 'PUT', body: '{}', headers: { Authorization: 'секрет' } }).catch(
      (e: unknown) => e,
    );

    expect(calls).toBe(2);
    // TypeError — SDK считает такую ошибку сетевой (polling сам повторит), bot.catch ответит E10.
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/PUT \/messages: нет ответа/);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ op: 'PUT /messages', reason: 'timeout' }), expect.stringContaining('повтор'));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ op: 'PUT /messages', attempts: 2 }), expect.stringContaining('после повтора'));
    // В лог не попадают ни query (там chat_id), ни заголовки (там токен).
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/секрет|chat_id/);
  });

  it('отправка сообщения без ответа не повторяется — иначе у человека будет дубль', async () => {
    let calls = 0;
    const f = resilientFetch((input, init) => {
      calls += 1;
      return silent(input, init);
    }, OPTS);
    const err = await f(`${API}/messages?chat_id=42`, { method: 'POST', body: '{}' }).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect((err as Error).message).toMatch(/POST \/messages: нет ответа .*\(1 попытка\)/);
  });

  it('«fetch failed» один раз → повтор проходит, вызывающий получает ответ', async () => {
    let calls = 0;
    const f = resilientFetch(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
      return new Response('{"ok":true}', { status: 200 });
    }, OPTS);

    const res = await f(`${API}/answers?callback_id=x`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('сеть недоступна дважды → ошибка «сеть недоступна» после двух попыток', async () => {
    let calls = 0;
    const f = resilientFetch(async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    }, OPTS);
    await expect(f(`${API}/me`)).rejects.toThrow(/GET \/me: сеть недоступна \(2 попытки\)/);
    expect(calls).toBe(2);
  });

  it('HTTP-ошибку (429/5xx) не повторяет — это делает withRetry шлюза по MaxError', async () => {
    let calls = 0;
    const f = resilientFetch(async () => {
      calls += 1;
      return new Response('{"code":"too.many.requests","message":"x"}', { status: 429 });
    }, OPTS);
    const res = await f(`${API}/messages`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(429);
    expect(calls).toBe(1);
  });

  it('long-poll GET /updates ждёт дольше обычного вызова', async () => {
    const f = resilientFetch(slow(150), OPTS);
    // 150 мс — больше обычных 50 мс, но меньше 400 мс для /updates.
    const res = await f(`${API}/updates?timeout=30`);
    expect(res.status).toBe(200);
    await expect(f(`${API}/messages`, { method: 'POST', body: '{}' })).rejects.toThrow(/нет ответа/);
  });

  it('отмену вызывающим (stopPolling) не повторяет', async () => {
    let calls = 0;
    const f = resilientFetch((input, init) => {
      calls += 1;
      return silent(input, init);
    }, { ...OPTS, longPollTimeoutMs: 5_000 });
    const stop = new AbortController();
    const pending = f(`${API}/updates`, { signal: stop.signal });
    stop.abort();
    await expect(pending).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
});
