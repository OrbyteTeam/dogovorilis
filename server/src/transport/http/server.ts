// Fastify: /healthz, /readyz, /api/*, /pay/return, статика мини-приложения /app/ (SPEC §4.4 п. 4).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Config } from '../../config.js';
import { getPool } from '../../db/pool.js';
import type { MaxGateway } from '../../integrations/max/gateway.js';
import { log } from '../../logger.js';
import { registerApi } from './routes/api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEBAPP_DIST = path.resolve(here, '..', '..', '..', '..', 'webapp', 'dist');

export type HttpDeps = {
  config: Config;
  max: MaxGateway | null;
  botReady: () => boolean;
};

export async function createHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // логируем сами через pino, чтобы не дублировать и не потерять redact-правила
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/healthz') return; // healthcheck Docker опрашивает каждые 15 с — не засоряем лог
    log.debug({ method: req.method, url: req.url, status: reply.statusCode }, 'http');
  });

  app.get('/healthz', async () => ({ ok: true, service: 'dogovorilis', mode: deps.config.MAX_MODE }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await getPool().query('SELECT 1');
    } catch (e) {
      reply.code(503);
      return { ok: false, db: false, error: (e as Error).message };
    }
    const botOk = deps.config.MAX_MODE === 'off' || deps.botReady();
    if (!botOk) {
      reply.code(503);
      return { ok: false, db: true, bot: false };
    }
    return { ok: true, db: true, bot: botOk };
  });

  registerApi(app, { max: deps.max });

  // Страница возврата с оплаты (SPEC §9.2). Провайдеры подключаются в ЗАДАЧА_02, страница нужна уже сейчас:
  // её адрес уходит в return_url и должен быть стабильным.
  app.get('/pay/return', async (req, reply) => {
    const q = req.query as { d?: string; fail?: string };
    const link = `https://max.ru/${deps.config.MAX_BOT_USERNAME || 'bot'}${q.d ? `?start=d_${q.d}` : ''}`;
    const title = q.fail ? 'Оплата не прошла' : 'Спасибо! Оплата обрабатывается';
    reply.type('text/html; charset=utf-8');
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
