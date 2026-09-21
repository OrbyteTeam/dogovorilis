// Режим MAX_MODE=webhook: то, что на сервере будет единственным способом получать события.
// До деплоя он нигде не проверялся, а ошибиться в нём дорого: бот молчит, сценарий не проходится,
// решение получает 0.
//
// Проверяем против поддельного MAX ровно три вещи из CONTRACTS §1.3:
//   1) createWebhook РЕГИСТРИРУЕТ подписку (POST /subscriptions) с нашим url и secret и не поднимает
//      собственный http-сервер — обработчик встраивается в наш Fastify;
//   2) обработчик принимает POST только с верным заголовком X-Max-Bot-Api-Secret, иначе 404;
//   3) с верным заголовком — 200 и update реально доходит до наших обработчиков.
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { loadConfig, setConfig } from '../src/config.js';
import { ALLOWED_UPDATES, createBot } from '../src/transport/bot/index.js';
import { createMaxFake, BOT_INFO } from './helpers/max-fake.js';
import { registerMaxWebhookRoute } from '../src/transport/http/routes/max-webhook.js';

const TOKEN = 'test-token-not-a-real-secret';
const SECRET = 'a7f3c1d9e5b2a8f4c6d0e1b3'; // как из `openssl rand -hex 24`
const HOST = 'dogovorilis.example';

function config() {
  return setConfig(
    loadConfig({
      NODE_ENV: 'test',
      MAX_MODE: 'webhook',
      MAX_BOT_TOKEN: TOKEN,
      MAX_BOT_USERNAME: BOT_INFO.username,
      MAX_WEBHOOK_SECRET: SECRET,
      PUBLIC_BASE_URL: `https://${HOST}`,
      DATABASE_URL: 'postgres://unused@localhost:5432/unused', // БД в этом тесте не нужна
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

describe('регистрация и обработчик webhook', () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  it('createWebhook подписывает бота на наш URL и отдаёт обработчик для Fastify', async () => {
    const cfg = config();
    const max = await createMaxFake();
    const runtime = await createBot(cfg, { fetch: max.fetch });

    const handler = await runtime.bot.createWebhook({
      domain: new URL(cfg.PUBLIC_BASE_URL).host,
      path: '/webhooks/max',
      secret: cfg.MAX_WEBHOOK_SECRET,
      allowedUpdates: ALLOWED_UPDATES,
    });
    expect(typeof handler).toBe('function');

    const sub = max.subscriptions.at(-1);
    expect(sub).toBeDefined();
    expect(sub!.url).toBe(`https://${HOST}/webhooks/max`);
    expect(sub!.secret).toBe(SECRET);
    expect(sub!.update_types).toEqual([...ALLOWED_UPDATES]);

    close = async () => {
      await runtime.bot.stopWebhook().catch(() => undefined);
      await max.close();
    };
  });

  it('запрос без секрета → 404, с секретом → 200 и update доходит до обработчиков', async () => {
    const cfg = config();
    const max = await createMaxFake();
    const runtime = await createBot(cfg, { fetch: max.fetch });

    const handler = await runtime.bot.createWebhook({
      domain: new URL(cfg.PUBLIC_BASE_URL).host,
      path: '/webhooks/max',
      secret: cfg.MAX_WEBHOOK_SECRET,
      allowedUpdates: ALLOWED_UPDATES,
    });

    // Встраивание тем же плагином, что и в src/index.ts — иначе тест проверял бы не то, что поедет.
    const app = Fastify({ logger: false });
    await app.register(registerMaxWebhookRoute(handler));
    await app.ready();

    const update = {
      update_type: 'bot_started',
      timestamp: Date.now(),
      chat_id: 777,
      user: { user_id: 42, name: 'Проверяющий', first_name: 'Проверяющий', is_bot: false, last_activity_time: Date.now() },
      payload: null,
    };

    const without = await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(update),
    });
    expect(without.statusCode).toBe(404); // SDK молча прячет endpoint от посторонних

    const wrong = await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': 'не тот секрет' },
      payload: JSON.stringify(update),
    });
    expect(wrong.statusCode).toBe(404);

    const ok = await app.inject({
      method: 'POST',
      url: '/webhooks/max',
      headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': SECRET },
      payload: JSON.stringify(update),
    });
    expect(ok.statusCode).toBe(200);

    // Обработчик отвечает 200 ДО обработки update (CONTRACTS §1.3) — даём цепочке завершиться.
    await new Promise<void>((r) => setTimeout(r, 300));

    // Факт маршрутизации виден по исходящему трафику: обработчик bot_started ответил в чат 777.
    // Без БД это будет E10 из bot.catch, с БД — приветствие S1; здесь проверяется именно то,
    // что update дошёл до цепочки, а сам сценарий покрыт сквозными тестами.
    expect(max.sent.some((m) => m.chatId === 777 || m.userId === 42)).toBe(true);

    close = async () => {
      await app.close();
      await runtime.bot.stopWebhook().catch(() => undefined);
      await max.close();
    };
  });
});
