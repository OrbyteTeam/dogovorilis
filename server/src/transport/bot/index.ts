// Сборка бота: регистрация обработчиков, режимы polling/webhook/off (SPEC §4.4), обязательный bot.catch.
// Без bot.catch процесс завершается при первой же ошибке в обработчике (CONTRACTS §1.3) — это условие нулевой оценки.
import { Bot, MaxError } from '@maxhub/max-bot-api';
import type { UpdateType } from '@maxhub/max-bot-api/types';
import type { Config } from '../../config.js';
import { createMaxGateway, resilientFetch, type MaxGateway } from '../../integrations/max/gateway.js';
import { log } from '../../logger.js';
import * as texts from '../../texts.js';
import { parseCallback } from './callbacks.js';
import { onDealCallback } from './handlers/deal.js';
import { registerInput, registerTextlessGuard } from './handlers/input.js';
import { onDemoNew, onExampleNew, onHelpCallback, onMenuCallback, onTryCallback, registerMenu } from './handlers/menu.js';
import { onPaymentCallback } from './handlers/payment.js';
import { registerStart } from './handlers/start.js';
import { answerCallbackProblem, answerError, chatIdOf, menu, type Deps } from './handlers/shared.js';

export const ALLOWED_UPDATES: UpdateType[] = [
  'bot_started',
  'message_created',
  'message_callback',
  'bot_stopped',
  'dialog_cleared',
];

/** Платёжные коды обрабатываются отдельным файлом (SPEC §13). */
const PAYMENT_CODES = new Set(['pl', 'pt', 'tr', 'pc', 'pe', 'nl']);

export type BotRuntime = { bot: Bot; max: MaxGateway; username: string; onError: BotErrorHandler };

export type BotErrorHandler = (err: unknown, ctx: { update: { update_type: string }; callback?: { callback_id: string } }) => Promise<void>;

/**
 * Обработчик ошибок. Вынесен отдельно, чтобы сквозной тест мог пройти по тому же пути,
 * что и SDK: middleware() → исключение → этот обработчик (CONTRACTS §1.3).
 */
export function createErrorHandler(max: MaxGateway): BotErrorHandler {
  return async (err, ctx) => {
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        update: ctx.update.update_type,
        code: err instanceof MaxError ? err.code : undefined,
      },
      'необработанная ошибка в обработчике',
    );
    try {
      if (ctx.update.update_type === 'message_callback' && ctx.callback) {
        // На карточке — E10 заметкой над карточкой, чтобы не стереть её кнопки (SPEC §6.4).
        await answerCallbackProblem(ctx as never, { max }, texts.E10, menu());
      } else {
        const chatId = chatIdOf(ctx as never);
        if (chatId) await max.send({ chatId }, texts.E10, [menu()]);
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'не удалось сообщить пользователю об ошибке');
    }
  };
}

/**
 * `fetch` подменяется только в тестах (CONTRACTS §1.12): загрузка файлов идёт мимо него, отдельным транспортом.
 * Любой `fetch` — и настоящий, и тестовый — оборачивается таймаутом и повтором (resilientFetch, ЗАДАЧА_03 G4).
 */
export async function createBot(config: Config, opts?: { fetch?: typeof globalThis.fetch }): Promise<BotRuntime> {
  const base = opts?.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const bot = new Bot(config.MAX_BOT_TOKEN, { clientOptions: { fetch: resilientFetch(base) } });
  const max = createMaxGateway(bot.api);
  const deps: Deps = { max };

  // Ошибка в обработчике не должна ронять процесс: логируем, отвечаем E10, продолжаем работать (SPEC §6.7).
  const onError = createErrorHandler(max);
  bot.catch(onError);

  // Порядок регистрации важен: сторож для сообщений без текста — строго перед командами (см. его docstring).
  registerTextlessGuard(bot, deps);
  registerStart(bot, deps);
  registerMenu(bot, deps);

  bot.on('message_callback', async (ctx, next) => {
    const parsed = parseCallback(ctx.callback?.payload);
    if (!parsed) {
      // Неизвестный payload (старая кнопка после обновления) — E1, а не тишина (SPEC §13).
      await max.answer(ctx.callback!.callback_id, texts.E1).catch(() => undefined);
      return;
    }
    try {
      if (parsed.kind === 'help') return void (await onHelpCallback(ctx, deps));
      if (parsed.kind === 'try') return void (await onTryCallback(ctx, deps));
      if (parsed.kind === 'menu') return void (await onMenuCallback(ctx, deps));
      if (parsed.kind === 'demo_new') return void (await onDemoNew(ctx, deps));
      if (parsed.kind === 'example_new') return void (await onExampleNew(ctx, deps));
      if (PAYMENT_CODES.has(parsed.code)) return void (await onPaymentCallback(ctx, deps, parsed));
      return void (await onDealCallback(ctx, deps, parsed));
    } catch (e) {
      await answerError(ctx, deps, e);
    }
    await next();
  });

  // Ввод текста и файлов — последним: сюда попадает всё, что не команда.
  registerInput(bot, deps);

  const info = await bot.api.getMyInfo();
  const username = config.MAX_BOT_USERNAME || info.username || 'bot';
  log.info({ username, userId: info.user_id }, 'бот: получен GET /me');

  await bot.api.setMyCommands([...texts.COMMANDS]).catch((e) => {
    log.warn({ err: (e as Error).message }, 'не удалось установить команды меню');
  });

  return { bot, max, username, onError };
}

/** Понятная подсказка, если TLS не доверяет сертификату Минцифры (CONTRACTS §1.13). */
export function explainStartupError(e: unknown): string | null {
  const cause = (e as { cause?: { code?: string } })?.cause?.code;
  if (cause === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || cause === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return [
      'Node не доверяет сертификату platform-api2.max.ru.',
      'Положите корневой и выпускающий сертификаты Минцифры в certs/russian_trusted_bundle.pem',
      'и запускайте с NODE_EXTRA_CA_CERTS=certs/russian_trusted_bundle.pem (см. certs/README.md).',
    ].join(' ');
  }
  if (e instanceof MaxError && e.status === 401) return 'MAX_BOT_TOKEN неверен или отозван (GET /me вернул 401).';
  return null;
}
