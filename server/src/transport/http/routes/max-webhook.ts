// Встраивание webhook-обработчика SDK в наш Fastify (SPEC §4.4 п. 5, CONTRACTS §1.3).
//
// Тонкость, которая стоила бы всего решения на защите: обработчик SDK — это обычный
// `(req: IncomingMessage, res: ServerResponse) => void`, он САМ читает тело из потока запроса и
// САМ пишет ответ. А Fastify по умолчанию:
//   1) разбирает JSON-тело ДО обработчика — поток `req.raw` оказывается вычитан, и обработчик SDK
//      бесконечно ждёт события 'data'/'end', которых уже не будет. Бот молча перестаёт отвечать;
//   2) после обработчика ждёт `reply.send()` — а его не будет, ответ уже ушёл в сырой сокет.
// Поэтому: свой парсер содержимого, который НЕ трогает поток, и `reply.hijack()`.
//
// Всё это живёт в отдельном плагине: парсер содержимого в Fastify инкапсулируется по области,
// и разбор JSON для /api и /webhooks/yookassa остаётся обычным.
import type { FastifyPluginAsync } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type SdkWebhookHandler = (req: IncomingMessage, res: ServerResponse) => void;

export const MAX_WEBHOOK_PATH = '/webhooks/max';

export function registerMaxWebhookRoute(handler: SdkWebhookHandler): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async (scope) => {
    // Поток намеренно не читается: тело разберёт обработчик SDK.
    scope.addContentTypeParser('application/json', (_req, _payload, done) => done(null, undefined));
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined));

    scope.post(MAX_WEBHOOK_PATH, (req, reply) => {
      reply.hijack();
      handler(req.raw, reply.raw);
    });
  };
  return plugin;
}
