// Режим MAX_MODE=webhook: то, что на сервере будет единственным способом получать события.
// Ошибиться в нём дорого: бот молчит, сценарий не проходится, решение получает 0.
//
// Проверяем против поддельного MAX (CONTRACTS §1.3; ЗАДАЧА_03 часть E — «подписка живёт всегда»):
//   1) обработчик встраивается в наш Fastify БЕЗ подписки; подписка — только когда HTTP уже слушает;
//   2) обработчик принимает POST только с верным X-Max-Bot-Api-Secret, иначе 404; с верным — update доходит;
//   3) остановка процесса подписку не снимает (и SDK-шный stopWebhook после createWebhook её не снимал);
//   4) сторож раз в 5 минут возвращает снятую подписку и не дублирует живую; его сбой не бросает;
//   5) /readyz показывает subscription, а ok от неё не зависит.
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, setConfig, type Config } from '../src/config.js';
import { closeDb, connectDb } from '../src/db/pool.js';
import { stopServices } from '../src/shutdown.js';
import { ALLOWED_UPDATES, createBot } from '../src/transport/bot/index.js';
import { SUBSCRIPTION_CHECK_MS, mountWebhook } from '../src/transport/bot/webhook.js';
import { createHttpServer } from '../src/transport/http/server.js';
import { createMaxFake, BOT_INFO, type MaxFake } from './helpers/max-fake.js';

const DB = process.env.TEST_DATABASE_URL;
const TOKEN = 'test-token-not-a-real-secret';
const SECRET = 'a7f3c1d9e5b2a8f4c6d0e1b3'; // как из `openssl rand -hex 24`
const HOST = 'dogovorilis.example';
const OUR_URL = `https://${HOST}/webhooks/max`;
const FOREIGN_URL = 'https://someone-else.example/hook';

function config(mode: 'webhook' | 'polling' = 'webhook'): Config {
  return setConfig(
    loadConfig({
      NODE_ENV: 'test',
      MAX_MODE: mode,
      MAX_BOT_TOKEN: TOKEN,
      MAX_BOT_USERNAME: BOT_INFO.username,
      MAX_WEBHOOK_SECRET: SECRET,
      PUBLIC_BASE_URL: `https://${HOST}`,
      DATABASE_URL: DB ?? 'postgres://unused@localhost:5432/unused', // БД нужна только тесту /readyz
      PAYMENT_PROVIDER: 'none',
      DEMO_MODE: 'true',
      APP_TIMEZONE: 'Europe/Moscow',
      PORT: '8080',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv),
  );
}

describe('конфигурация режима webhook', () => {
  it('без секрета конфигурация не проходит', () => {
    expect(() => loadConfig({ ...base(), MAX_WEBHOOK_SECRET: '' } as NodeJS.ProcessEnv)).toThrow(/MAX_WEBHOOK_SECRET/);
  });

  it('секрет обязан подходить под ^[a-zA-Z0-9_-]{5,256}$ (CONTRACTS §1.3)', () => {
    expect(() => loadConfig({ ...base(), MAX_WEBHOOK_SECRET: 'слишком русский' } as NodeJS.ProcessEnv)).toThrow(/a-zA-Z0-9_-/);
    expect(() => loadConfig({ ...base(), MAX_WEBHOOK_SECRET: 'abc' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('http:// в PUBLIC_BASE_URL отклоняется: MAX не принимает ни http, ни самоподписанные', () => {
    expect(() => loadConfig({ ...base(), PUBLIC_BASE_URL: 'http://dogovorilis.example' } as NodeJS.ProcessEnv)).toThrow(/https/);
  });

  function base(): Record<string, string> {
    return {
      NODE_ENV: 'test',
      MAX_MODE: 'webhook',
      MAX_BOT_TOKEN: TOKEN,
      MAX_WEBHOOK_SECRET: SECRET,
      PUBLIC_BASE_URL: `https://${HOST}`,
      DATABASE_URL: 'postgres://unused@localhost:5432/unused',
      PAYMENT_PROVIDER: 'none',
      APP_TIMEZONE: 'Europe/Moscow',
      PORT: '8080',
      LOG_LEVEL: 'silent',
    };
  }
});

describe('webhook: обработчик и подписка MAX', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
  });

  /**
   * Бот на поддельном MAX. `failSubscriptions` — отвечать 503 на /subscriptions (MAX недоступен).
   * `listening` — был ли HTTP-сервер уже поднят в момент каждого POST /subscriptions.
   */
  async function setup(): Promise<{
    cfg: Config;
    max: MaxFake;
    app: FastifyInstance;
    runtime: Awaited<ReturnType<typeof createBot>>;
    listeningAtSubscribe: boolean[];
    breakSubscriptions: (broken: boolean) => void;
  }> {
    const cfg = config();
    const max = await createMaxFake();
    const app = Fastify({ logger: false });
    const listeningAtSubscribe: boolean[] = [];
    let broken = false;
    const fetchSpy: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.pathname === '/subscriptions') {
        if (broken) {
          return new Response(JSON.stringify({ code: 'service.unavailable', message: 'MAX недоступен' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (method === 'POST') listeningAtSubscribe.push(app.server.listening);
      }
      return max.fetch(input, init);
    };
    const runtime = await createBot(cfg, { fetch: fetchSpy });
    max.subscriptionCalls.length = 0;
    cleanup.push(async () => {
      await app.close().catch(() => undefined); // тест остановки уже мог закрыть его сам
      await max.close();
    });
    return { cfg, max, app, runtime, listeningAtSubscribe, breakSubscriptions: (b) => void (broken = b) };
  }

  it('обработчик встраивается без подписки; подписка ставится, когда HTTP уже слушает', async () => {
    const { cfg, max, app, runtime, listeningAtSubscribe } = await setup();

    const keeper = await mountWebhook(app, runtime.bot, cfg);
    await app.ready();
    expect(max.subscriptionCalls).toEqual([]); // до старта HTTP MAX о нас не знает — 502 на первых доставках не будет
    expect(keeper.url).toBe(OUR_URL);
    expect(keeper.state()).toBeNull();

    await app.listen({ port: 0, host: '127.0.0.1' });
    await keeper.register();

    expect(listeningAtSubscribe).toEqual([true]);
    expect(max.subscriptions).toEqual([{ url: OUR_URL, secret: SECRET, update_types: [...ALLOWED_UPDATES] }]);
    expect(keeper.state()).toBe(true);
  });

  it('при старте чужие подписки токена снимаются, своя — нет', async () => {
    const { cfg, max, app, runtime } = await setup();
    max.subscriptions.push({ url: FOREIGN_URL }, { url: OUR_URL, secret: SECRET });

    const keeper = await mountWebhook(app, runtime.bot, cfg);
    await keeper.register();

    expect(max.subscriptions.map((s) => s.url)).toEqual([OUR_URL]);
    expect(max.subscriptionCalls.filter((c) => c.method === 'DELETE')).toEqual([{ method: 'DELETE', url: FOREIGN_URL }]);
  });

  it('MAX недоступен при старте — процесс не падает, state=false, сторож потом возвращает подписку', async () => {
    const { cfg, max, app, runtime, breakSubscriptions } = await setup();
    const keeper = await mountWebhook(app, runtime.bot, cfg);
    breakSubscriptions(true);
    const t0 = new Date('2026-09-23T10:00:00Z');

    await expect(keeper.register(t0)).resolves.toBeUndefined();
    expect(keeper.state()).toBe(false);

    breakSubscriptions(false);
    expect(await keeper.check(new Date(t0.getTime() + SUBSCRIPTION_CHECK_MS))).toBe('restored');
    expect(max.subscriptions.map((s) => s.url)).toEqual([OUR_URL]);
    expect(keeper.state()).toBe(true);
  });

  it('запрос без секрета → 404, с секретом → 200 и update доходит до обработчиков', async () => {
    const { cfg, max, app, runtime } = await setup();
    await mountWebhook(app, runtime.bot, cfg); // тот же путь, что в src/index.ts
    await app.ready();

    const update = {
      update_type: 'bot_started',
      timestamp: Date.now(),
      chat_id: 777,
      user: { user_id: 42, name: 'Проверяющий', first_name: 'Проверяющий', is_bot: false, last_activity_time: Date.now() },
      payload: null,
    };
    const post = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/webhooks/max', headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(update) });

    expect((await post({})).statusCode).toBe(404); // SDK молча прячет endpoint от посторонних
    expect((await post({ 'x-max-bot-api-secret': 'не тот секрет' })).statusCode).toBe(404);
    expect((await post({ 'x-max-bot-api-secret': SECRET })).statusCode).toBe(200);

    // Обработчик отвечает 200 ДО обработки update (CONTRACTS §1.3) — даём цепочке завершиться.
    await new Promise<void>((r) => setTimeout(r, 300));
    // Факт маршрутизации виден по исходящему трафику: обработчик bot_started ответил в чат 777
    // (без БД это E10 из bot.catch; сам сценарий покрыт сквозными тестами).
    expect(max.sent.some((m) => m.chatId === 777 || m.userId === 42)).toBe(true);
  });

  it('остановка процесса подписку не снимает', async () => {
    const { cfg, max, app, runtime } = await setup();
    const keeper = await mountWebhook(app, runtime.bot, cfg);
    await app.listen({ port: 0, host: '127.0.0.1' });
    await keeper.register();
    let stopped = false;

    await stopServices({ scheduler: { stop: () => void (stopped = true) }, app, closeDb: async () => undefined });

    expect(stopped).toBe(true);
    expect(app.server.listening).toBe(false);
    expect(max.subscriptions.map((s) => s.url)).toEqual([OUR_URL]);
    expect(max.subscriptionCalls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('факт SDK 0.3.1: stopWebhook() после createWebhook подписку не снимает (флаг webhookIsStarted — только у startWebhook)', async () => {
    // Поэтому прежний вызов stopWebhook() в shutdown и так ничего не делал. Убран, чтобы код не обещал того,
    // чего не делает, и не начал снимать подписку после обновления SDK (server/src/shutdown.ts).
    const { cfg, max, runtime } = await setup();
    await runtime.bot.createWebhook({ domain: HOST, path: '/webhooks/max', secret: cfg.MAX_WEBHOOK_SECRET, allowedUpdates: ALLOWED_UPDATES });
    expect(max.subscriptions.map((s) => s.url)).toEqual([OUR_URL]);

    await runtime.bot.stopWebhook();

    expect(max.subscriptions.map((s) => s.url)).toEqual([OUR_URL]);
    expect(max.subscriptionCalls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('сторож: раз в 5 минут; живую подписку не дублирует, снятую — возвращает', async () => {
    const { cfg, max, app, runtime } = await setup();
    const keeper = await mountWebhook(app, runtime.bot, cfg);
    const t0 = new Date('2026-09-23T10:00:00Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);
    await keeper.register(t0);
    max.subscriptionCalls.length = 0;

    // Раньше 5 минут — MAX не трогаем вовсе (тик планировщика — каждые 30 с)
    expect(await keeper.check(at(30_000))).toBe('skipped');
    expect(await keeper.check(at(SUBSCRIPTION_CHECK_MS - 1))).toBe('skipped');
    expect(max.subscriptionCalls).toEqual([]);

    // Подписка на месте — только GET, без второго POST
    expect(await keeper.check(at(SUBSCRIPTION_CHECK_MS))).toBe('present');
    expect(max.subscriptionCalls).toEqual([{ method: 'GET' }]);
    expect(max.subscriptions).toHaveLength(1);

    // Кто-то снял подписку (чужой polling с тем же токеном или MAX через 8 ч) — вернётся на следующей проверке
    max.subscriptions.length = 0;
    max.subscriptionCalls.length = 0;
    expect(await keeper.check(at(SUBSCRIPTION_CHECK_MS + 60_000))).toBe('skipped');
    expect(await keeper.check(at(2 * SUBSCRIPTION_CHECK_MS))).toBe('restored');
    expect(max.subscriptionCalls).toEqual([{ method: 'GET' }, { method: 'POST', url: OUR_URL }]);
    expect(max.subscriptions).toEqual([{ url: OUR_URL, secret: SECRET, update_types: [...ALLOWED_UPDATES] }]);
    expect(keeper.state()).toBe(true);
  });

  it('сторож: сбой MAX не бросает, повтор — через 5 минут', async () => {
    const { cfg, max, app, runtime, breakSubscriptions } = await setup();
    const keeper = await mountWebhook(app, runtime.bot, cfg);
    const t0 = new Date('2026-09-23T10:00:00Z');
    await keeper.register(t0);
    max.subscriptions.length = 0;
    breakSubscriptions(true);

    await expect(keeper.check(new Date(t0.getTime() + SUBSCRIPTION_CHECK_MS))).resolves.toBe('failed');
    expect(keeper.state()).toBe(true); // проверить не удалось — последнее известное состояние не выдумываем

    breakSubscriptions(false);
    expect(await keeper.check(new Date(t0.getTime() + SUBSCRIPTION_CHECK_MS + 30_000))).toBe('skipped');
    expect(await keeper.check(new Date(t0.getTime() + 2 * SUBSCRIPTION_CHECK_MS))).toBe('restored');
  });

  describe.skipIf(!DB)('/readyz', () => {
    it('в режиме webhook показывает subscription; ok от неё не зависит', async () => {
      const { cfg, max, app, runtime } = await setup();
      await connectDb(DB!, 3, 500);
      cleanup.push(() => closeDb());
      const keeper = await mountWebhook(app, runtime.bot, cfg);
      const http = await createHttpServer({ config: cfg, max: null, botReady: () => true, subscription: () => keeper.state() });
      cleanup.push(() => http.close());
      const readyz = async () => (await http.inject({ method: 'GET', url: '/readyz' })).json();

      expect(await readyz()).toEqual({ ok: true, db: true, bot: true, subscription: null }); // ещё не подписывались

      const t0 = new Date('2026-09-23T10:00:00Z');
      await keeper.register(t0);
      expect(await readyz()).toEqual({ ok: true, db: true, bot: true, subscription: true });

      max.subscriptions.length = 0;
      await keeper.check(new Date(t0.getTime() + SUBSCRIPTION_CHECK_MS)); // вернул — снова true
      expect((await readyz()).subscription).toBe(true);
    });

    it('подписки нет и вернуть не вышло — subscription:false, но ok:true', async () => {
      const { cfg, app, runtime, breakSubscriptions } = await setup();
      await connectDb(DB!, 3, 500);
      cleanup.push(() => closeDb());
      const keeper = await mountWebhook(app, runtime.bot, cfg);
      breakSubscriptions(true);
      await keeper.register();
      const http = await createHttpServer({ config: cfg, max: null, botReady: () => true, subscription: () => keeper.state() });
      cleanup.push(() => http.close());

      const res = await http.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, db: true, bot: true, subscription: false });
    });

    it('в режиме polling поля subscription нет', async () => {
      const cfg = config('polling');
      await connectDb(DB!, 3, 500);
      cleanup.push(() => closeDb());
      const http = await createHttpServer({ config: cfg, max: null, botReady: () => true });
      cleanup.push(() => http.close());

      expect((await http.inject({ method: 'GET', url: '/readyz' })).json()).toEqual({ ok: true, db: true, bot: true });
    });
  });
});
