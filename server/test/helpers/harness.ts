// Стенд для сквозного теста: настоящая БД, настоящая сборка бота, поддельный MAX.
// Обновления подаются в bot.middleware() — та же цепочка, что вызывает SDK в handleUpdate (CONTRACTS §1.3).
import { createHmac } from 'node:crypto';
import { Context, type Bot } from '@maxhub/max-bot-api';
import type { FastifyInstance } from 'fastify';
import type { Update } from '@maxhub/max-bot-api/types';
import pg from 'pg';
import { loadConfig, setConfig, type Config } from '../../src/config.js';
import { closeDb, connectDb, inTx } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { createBot, type BotErrorHandler } from '../../src/transport/bot/index.js';
import { createHttpServer } from '../../src/transport/http/server.js';
import { createMaxGateway } from '../../src/integrations/max/gateway.js';
import { createMaxFake, BOT_INFO, type MaxFake } from './max-fake.js';

export type Harness = {
  bot: Bot;
  max: MaxFake;
  /** тот же шлюз, что у обработчиков — нужен для прогона тика планировщика */
  gateway: ReturnType<typeof createMaxGateway>;
  config: Config;
  /** подать событие, как это делает SDK: middleware() + обработчик ошибок */
  feed(update: Update): Promise<void>;
  start(userId: number, chatId: number, payload?: string): Promise<void>;
  press(userId: number, chatId: number, payload: string, mid?: string | null): Promise<void>;
  say(userId: number, chatId: number, text: string): Promise<void>;
  sendAttachment(userId: number, chatId: number, attachment: Record<string, unknown>): Promise<void>;
  /** Запрос к /api/* с настоящей подписью initData — тем же путём, каким ходит мини-приложение. */
  api(method: 'GET' | 'POST' | 'PUT', path: string, userId: number, body?: unknown): Promise<{ status: number; json: any }>;
  /** Загрузка файла телом запроса (чек из мини-приложения, ЗАДАЧА_08 B) — с настоящей подписью initData. */
  apiUpload(path: string, userId: number, file: Buffer, contentType: string, fileName?: string): Promise<{ status: number; json: any }>;
  /** Запрос без подписи или с испорченной — для проверки 401. */
  apiRaw(method: 'GET' | 'POST' | 'PUT', path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: any }>;
  /** Доставка вебхука провайдера ровно тем же путём, каким её принимает Fastify. */
  webhook(path: string, body: unknown, ip?: string): Promise<{ status: number; json: any }>;
  query<T extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
};

const TOKEN = 'test-token-not-a-real-secret';

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * Подпись initData по алгоритму MAX (CONTRACTS §4.1) — зеркало проверки в transport/http/auth.ts.
 * Здесь она нужна, чтобы дойти до API тем же путём, что мини-приложение, а не в обход авторизации.
 */
export function signInitData(userId: number, extra: Record<string, string> = {}, botToken = TOKEN): string {
  const params: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${userId}`,
    user: JSON.stringify({ id: userId, first_name: `Пользователь${userId}`, last_name: null, username: null, language_code: 'ru', photo_url: null }),
    ...extra,
  };
  const launchParams = Object.keys(params)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${params[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(launchParams).digest('hex');
  return [...Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`), `hash=${hash}`].join('&');
}

export type HarnessOptions = {
  keepData?: boolean;
  /** 'yookassa' включает рейл «ссылка»; клиент провайдера при этом обязательно подменяется (без сети). */
  paymentProvider?: 'none' | 'yookassa' | 'tbank';
};

export async function createHarness(databaseUrl: string, opts?: HarnessOptions): Promise<Harness> {
  const provider = opts?.paymentProvider ?? 'none';
  const config = setConfig(
    loadConfig({
      NODE_ENV: 'test',
      MAX_MODE: 'polling',
      MAX_BOT_TOKEN: TOKEN,
      MAX_BOT_USERNAME: BOT_INFO.username,
      PUBLIC_BASE_URL: 'http://localhost:8080',
      DATABASE_URL: databaseUrl,
      PAYMENT_PROVIDER: provider,
      YOOKASSA_SHOP_ID: provider === 'yookassa' ? 'test-shop-id' : '',
      YOOKASSA_SECRET_KEY: provider === 'yookassa' ? 'test_secret_key_not_real' : '',
      DEMO_MODE: 'true',
      APP_TIMEZONE: 'Europe/Moscow',
      PORT: '8080',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv),
  );

  const pool = await connectDb(databaseUrl, 3, 500);
  await migrate(pool);
  if (!opts?.keepData) await truncateAll();

  const max = await createMaxFake();
  const runtime = await createBot(config, { fetch: max.fetch });
  max.reset(); // не считаем setMyCommands

  const gateway = createMaxGateway(runtime.bot.api);
  const http = await createHttpServer({ config, max: gateway, botReady: () => true });
  await http.ready();

  const onError: BotErrorHandler = runtime.onError;
  let callbackSeq = 0;
  const middleware = runtime.bot.middleware();

  const feed = async (update: Update): Promise<void> => {
    const ctx = new Context(update, runtime.bot.api, BOT_INFO as never);
    try {
      await middleware(ctx, () => Promise.resolve());
    } catch (e) {
      await onError(e, ctx as never);
    }
  };

  const user = (userId: number) => ({
    user_id: userId,
    name: `Пользователь ${userId}`,
    first_name: `Пользователь${userId}`,
    last_name: undefined,
    username: null,
    is_bot: false,
    last_activity_time: Date.now(),
  });

  return {
    bot: runtime.bot,
    max,
    gateway,
    config,
    feed,

    async start(userId, chatId, payload) {
      // bot_started приходит при первом открытии бота и после его перезапуска (CONTRACTS §5.1)
      await feed({ update_type: 'bot_started', timestamp: Date.now(), chat_id: chatId, user: user(userId), payload: payload ?? null } as never);
    },

    async press(userId, chatId, payload, mid) {
      // У настоящего message_callback сообщение-источник есть всегда: без него SDK не сможет отдать chat_id
      // (CONTRACTS §1.5). Для кнопок меню подставляем синтетический mid, которого нет в card_messages.
      const sourceMid = mid ?? `not-a-card-${Date.now()}`;
      const callbackId = `cbid-${payload}-${Date.now()}-${++callbackSeq}`;
      max.bindCallback(callbackId, sourceMid);
      await feed({
        update_type: 'message_callback',
        timestamp: Date.now(),
        callback: { timestamp: Date.now(), callback_id: callbackId, payload, user: user(userId) },
        message: {
          sender: user(userId),
          recipient: { chat_id: chatId, chat_type: 'DIALOG', user_id: userId, post_id: null },
          timestamp: Date.now(),
          body: { mid: sourceMid, seq: 1, text: '', attachments: null },
        },
      } as never);
    },

    async say(userId, chatId, text) {
      await feed({
        update_type: 'message_created',
        timestamp: Date.now(),
        message: { sender: user(userId), recipient: { chat_id: chatId, chat_type: 'DIALOG', user_id: userId, post_id: null }, timestamp: Date.now(), body: { mid: `in-${Date.now()}`, seq: 1, text, attachments: null } },
      } as never);
    },

    async sendAttachment(userId, chatId, attachment) {
      await feed({
        update_type: 'message_created',
        timestamp: Date.now(),
        message: { sender: user(userId), recipient: { chat_id: chatId, chat_type: 'DIALOG', user_id: userId, post_id: null }, timestamp: Date.now(), body: { mid: `in-${Date.now()}`, seq: 1, text: null, attachments: [attachment] } },
      } as never);
    },

    async api(method, path, userId, body) {
      const res = await http.inject({
        method,
        url: path,
        headers: { 'x-max-init-data': signInitData(userId), 'content-type': 'application/json' },
        payload: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.statusCode, json: safeJson(res.body) };
    },

    async apiUpload(path, userId, file, contentType, fileName) {
      const res = await http.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-max-init-data': signInitData(userId),
          'content-type': contentType,
          ...(fileName ? { 'x-file-name': encodeURIComponent(fileName) } : {}),
        },
        payload: file,
      });
      return { status: res.statusCode, json: safeJson(res.body) };
    },

    async apiRaw(method, path, headers, body) {
      const res = await http.inject({
        method,
        url: path,
        headers: { 'content-type': 'application/json', ...headers },
        payload: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.statusCode, json: safeJson(res.body) };
    },

    async webhook(path, body, ip) {
      const res = await http.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
        remoteAddress: ip ?? '127.0.0.1',
        payload: JSON.stringify(body),
      });
      return { status: res.statusCode, json: safeJson(res.body) };
    },

    async query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      const { rows } = await pool.query<T>(sql, params);
      return rows;
    },

    async close() {
      await http.close();
      await max.close();
      await closeDb();
    },
  };
}

/** Между сценариями база очищается: «состояние не протекает между сессиями» надо проверять честно. */
export async function truncateAll(): Promise<void> {
  await inTx(async (c) => {
    await c.query(
      'TRUNCATE users, seller_profiles, deals, deal_versions, payments, deal_events, card_messages, reminders, receipts, user_inputs, webhook_log RESTART IDENTITY CASCADE',
    );
  });
}

/** mid карточки заданной роли — чтобы «нажать кнопку» именно в ней. */
export async function cardMid(h: Harness, publicId: string, role: string): Promise<string> {
  const rows = await h.query<{ mid: string }>(
    `SELECT cm.mid FROM card_messages cm JOIN deals d ON d.id = cm.deal_id WHERE d.public_id = $1 AND cm.role = $2`,
    [publicId, role],
  );
  if (!rows[0]) throw new Error(`нет карточки роли ${role} у сделки ${publicId}`);
  return rows[0].mid;
}

export async function dealStatus(h: Harness, publicId: string): Promise<string> {
  const rows = await h.query<{ status: string }>('SELECT status FROM deals WHERE public_id = $1', [publicId]);
  return rows[0]?.status ?? 'нет такой сделки';
}

export async function onlyDealPublicId(h: Harness): Promise<string> {
  const rows = await h.query<{ public_id: string }>('SELECT public_id FROM deals ORDER BY id DESC LIMIT 1');
  if (!rows[0]) throw new Error('сделок нет');
  return rows[0].public_id;
}

export async function livePaymentId(h: Harness, publicId: string, kind: string): Promise<number> {
  const rows = await h.query<{ id: number }>(
    `SELECT p.id FROM payments p JOIN deals d ON d.id = p.deal_id
     WHERE d.public_id = $1 AND p.kind = $2 AND p.status IN ('pending','claimed','succeeded') ORDER BY p.id DESC LIMIT 1`,
    [publicId, kind],
  );
  if (!rows[0]) throw new Error(`нет живого платежа ${kind} у ${publicId}`);
  return rows[0].id;
}
