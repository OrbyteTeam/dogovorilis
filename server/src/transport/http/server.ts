// Fastify: /healthz, /readyz, /api/*, /pay/return, статика мини-приложения /app/ (SPEC §4.4 п. 4).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Config } from '../../config.js';
import { getPool } from '../../db/pool.js';
import { PUBLIC_ID_RE } from '../../domain/ids.js';
import { AppError, UnauthorizedError, ValidationError } from '../../errors.js';
import type { MaxGateway } from '../../integrations/max/gateway.js';
import { log } from '../../logger.js';
import { registerApi } from './routes/api.js';
import { registerDealScreenApi } from './routes/deal-screen.js';
import { registerWebhooks } from './routes/webhooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEBAPP_DIST = path.resolve(here, '..', '..', '..', '..', 'webapp', 'dist');

export type HttpDeps = {
  config: Config;
  max: MaxGateway | null;
  botReady: () => boolean;
  /** Режим webhook: есть ли подписка MAX (null — ещё не проверяли). В polling/off не передаётся. */
  subscription?: () => boolean | null;
  /** Лимит на /webhooks/* с одного IP; по умолчанию WEBHOOK_RATE_LIMIT. Тесты ставят маленький. */
  webhookRateLimit?: { max: number; timeWindowMs: number };
};

/**
 * Кому верим в X-Forwarded-For: только прокси на этой же машине и в частной сети Docker, то есть Caddy
 * (он ходит к app:8080 по внутренней сети compose). Любой другой отправитель — сам себе клиент, и его
 * X-Forwarded-For игнорируется: иначе IP-фильтр ЮKassa и лимит запросов обходились бы одним заголовком.
 * Имена — из @fastify/proxy-addr: loopback = 127.0.0.0/8, ::1; uniquelocal = 10/8, 172.16/12, 192.168/16, fc00::/7.
 */
export const TRUSTED_PROXIES = ['loopback', 'uniquelocal'];

/**
 * 600 запросов в минуту с одного IP на /webhooks/*: провайдер шлёт единицы уведомлений в минуту даже под
 * нагрузкой, а каждая доставка — это запись в webhook_log и поход к провайдеру (ЗАДАЧА_03 G5).
 */
export const WEBHOOK_RATE_LIMIT = { max: 600, timeWindowMs: 60_000 };

export const isWebhookUrl = (url: string): boolean => url.startsWith('/webhooks/');

export async function createHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // логируем сами через pino, чтобы не дублировать и не потерять redact-правила
    bodyLimit: 1_048_576,
    trustProxy: TRUSTED_PROXIES,
  });

  // Лимит — до объявления маршрутов: плагин вешает свой хук на каждый маршрут при регистрации, в том числе на
  // /webhooks/max, который index.ts добавляет позже. Считаются только /webhooks/*, остальное пропускается.
  // Старые ключи вытесняет LRU плагина (по умолчанию 5000 IP), память не растёт.
  const limit = deps.webhookRateLimit ?? WEBHOOK_RATE_LIMIT;
  await app.register(fastifyRateLimit, {
    global: true,
    max: limit.max,
    timeWindow: limit.timeWindowMs,
    allowList: (req: FastifyRequest) => !isWebhookUrl(req.url),
    onExceeded: (req: FastifyRequest) => log.warn({ ip: req.ip, url: req.url.split('?')[0] }, 'http: лимит запросов к вебхукам превышен'),
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/healthz') return; // healthcheck Docker опрашивает каждые 15 с — не засоряем лог
    log.debug({ method: req.method, url: req.url, status: reply.statusCode }, 'http');
  });

  // Формат ошибок — один на весь API (SPEC §7.8): { error: { code, message } }.
  // Без этого Fastify отдавал бы своё тело { statusCode, code, error, message }, которое мини-приложение не разбирает.
  app.setErrorHandler((err: unknown, req, reply) => {
    const { status, code, message } = describeError(err);
    if (status >= 500) log.error({ err: (err as Error)?.message, url: req.url }, 'http: внутренняя ошибка');
    else log.warn({ code, url: req.url }, 'http: отказ');
    reply.code(status).send({ error: { code, message } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: 'not_found', message: 'Такого метода нет' } });
      return;
    }
    reply.code(404).type('text/plain; charset=utf-8').send('Не найдено');
  });

  app.get('/healthz', async () => ({ ok: true, service: 'dogovorilis', mode: deps.config.MAX_MODE }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await getPool().query('SELECT 1');
    } catch (e) {
      // Текст ошибки БД наружу не отдаём: в нём бывают адрес и имя базы (ЗАДАЧА_03 G6) — только в лог.
      log.warn({ err: (e as Error).message }, 'readyz: БД не отвечает');
      reply.code(503);
      return { ok: false, db: false };
    }
    const botOk = deps.config.MAX_MODE === 'off' || deps.botReady();
    // Подписка MAX — для диагностики «бот молчит» (deploy/README.md §5); на ok не влияет: её вернёт сторож.
    const subscription = deps.subscription ? { subscription: deps.subscription() } : {};
    if (!botOk) {
      reply.code(503);
      return { ok: false, db: true, bot: false, ...subscription };
    }
    return { ok: true, db: true, bot: botOk, ...subscription };
  });

  registerApi(app, { max: deps.max });
  // Экран сделки (ЗАДАЧА_08 B) — после registerApi: хук авторизации /api уже висит на корне и покрывает эти маршруты.
  registerDealScreenApi(app, { max: deps.max });
  registerWebhooks(app, { max: deps.max });

  // Страница возврата с оплаты (SPEC §9.2). Провайдеры подключаются в ЗАДАЧА_02, страница нужна уже сейчас:
  // её адрес уходит в return_url и должен быть стабильным.
  app.get('/pay/return', async (req, reply) => {
    const q = req.query as { d?: unknown; fail?: unknown };
    // d — это public_id сделки из return_url; всё, что на него не похоже, — ссылка на бота без payload (G2).
    const publicId = typeof q.d === 'string' && PUBLIC_ID_RE.test(q.d) ? q.d : null;
    const bot = encodeURIComponent(deps.config.MAX_BOT_USERNAME || 'bot');
    const link = escapeHtml(`https://max.ru/${bot}${publicId ? `?start=d_${publicId}` : ''}`);
    const title = escapeHtml(q.fail ? 'Оплата не прошла' : 'Спасибо! Оплата обрабатывается');
    reply.type('text/html; charset=utf-8');
    // Страница статическая: скриптов в ней нет и быть не должно — даже если что-то проскочит мимо экранирования.
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    reply.header('x-content-type-options', 'nosniff');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 -apple-system,system-ui,Roboto,sans-serif;margin:0;padding:24px;background:#edeef2;color:#060708}
main{max-width:420px;margin:10vh auto;background:#fff;border-radius:16px;padding:24px}
a{display:inline-block;margin-top:16px;padding:12px 16px;background:#007aff;color:#fff;border-radius:12px;text-decoration:none}
@media(prefers-color-scheme:dark){body{background:#0f0f12;color:#fff}main{background:#17181c}}</style></head>
<body><main><h1>${title}</h1>
<p>Вернитесь в MAX — карточка сделки обновится сама.</p>
<a href="${link}">Открыть бота в MAX</a></main></body></html>`;
  });

  await app.register(fastifyStatic, { root: WEBAPP_DIST, prefix: '/app/', decorateReply: false });
  app.get('/app', (_req, reply) => reply.redirect('/app/'));
  // Мини-приложение использует hash-роутинг, поэтому отдельного SPA-fallback не нужно:
  // любой путь внутри /app/ — это /app/index.html + #/…

  return app;
}

/** Всё, что подставляется в HTML страницы, экранируется (G2): & < > " ' . */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** Ошибка домена → код и статус HTTP по таблице SPEC §7.8. */
function describeError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof UnauthorizedError) return { status: 401, code: err.code, message: 'Откройте мини-приложение внутри MAX' };
  if (err instanceof ValidationError) return { status: 400, code: 'validation', message: err.message };
  if (err instanceof AppError) {
    switch (err.code) {
      case 'forbidden':
        return { status: 403, code: 'forbidden', message: 'Нет доступа к этой сделке' };
      case 'deal_not_found':
        return { status: 404, code: 'not_found', message: 'Сделка не найдена' };
      case 'invalid_transition':
      case 'client_cancel_locked':
        return { status: 409, code: 'invalid_transition', message: 'Это действие уже недоступно' };
      case 'rate_limited':
        return { status: 429, code: 'rate_limited', message: err.message };
      default:
        return { status: 500, code: 'internal', message: 'Внутренняя ошибка, попробуйте позже' };
    }
  }
  // Ошибки самого Fastify (например, битый JSON в теле) — это тоже валидация входа.
  const fastifyStatus = (err as { statusCode?: number })?.statusCode;
  if (fastifyStatus === 429) return { status: 429, code: 'rate_limited', message: 'Слишком много запросов, повторите позже' };
  if (fastifyStatus && fastifyStatus < 500) {
    return {
      status: fastifyStatus,
      code: fastifyStatus === 400 ? 'validation' : 'bad_request',
      message: (err as Error)?.message ?? 'Некорректный запрос',
    };
  }
  return { status: 500, code: 'internal', message: 'Внутренняя ошибка, попробуйте позже' };
}
