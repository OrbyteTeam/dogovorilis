// Точка входа. Порядок старта — SPEC §4.4: конфиг → БД (с ретраем) → миграции → HTTP → бот → планировщик.
// При ошибке конфигурации или токена — понятное сообщение и exit(1), без стектрейса в лицо.
import 'dotenv/config';
import { ConfigError, loadConfig, setConfig, type Config } from './config.js';
import { closeDb, connectDb } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { initLogger, log } from './logger.js';
import { ALLOWED_UPDATES, createBot, explainStartupError } from './transport/bot/index.js';
import { mountWebhook, type SubscriptionKeeper } from './transport/bot/webhook.js';
import { createHttpServer } from './transport/http/server.js';
import { MAX_WEBHOOK_PATH } from './transport/http/routes/max-webhook.js';
import { startScheduler } from './scheduler/index.js';
import { stopServices } from './shutdown.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  let config: Config;
  try {
    config = setConfig(loadConfig());
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n\nСмотрите .env.example и docs/SPEC.md §4.3.\n`);
      process.exit(1);
    }
    throw e;
  }
  initLogger(config.LOG_LEVEL);
  log.info(
    { mode: config.MAX_MODE, provider: config.PAYMENT_PROVIDER, demo: config.DEMO_MODE, tz: config.APP_TIMEZONE, env: config.NODE_ENV },
    'запуск «Договорились»',
  );

  const pool = await connectDb(config.DATABASE_URL);
  const applied = await migrate(pool);
  log.info({ applied: applied.length ? applied : 'нет новых' }, 'миграции проверены');

  let botReady = false;
  let runtime: Awaited<ReturnType<typeof createBot>> | null = null;

  if (config.MAX_MODE !== 'off') {
    try {
      runtime = await createBot(config);
      // Ник бота нужен для диплинков; если в .env его нет — берём из GET /me (SPEC §19).
      if (!config.MAX_BOT_USERNAME) setConfig({ ...config, MAX_BOT_USERNAME: runtime.username });
    } catch (e) {
      const hint = explainStartupError(e);
      log.fatal({ err: (e as Error).message }, hint ?? 'не удалось инициализировать бота');
      if (hint) process.stderr.write(`\n${hint}\n`);
      await closeDb();
      process.exit(1);
    }
  } else {
    log.warn('MAX_MODE=off — бот не запускается, работают только API и мини-приложение');
  }

  let subscription: SubscriptionKeeper | null = null;
  const app = await createHttpServer({
    config,
    max: runtime?.max ?? null,
    botReady: () => botReady,
    subscription: config.MAX_MODE === 'webhook' ? () => subscription?.state() ?? null : undefined,
  });

  if (runtime && config.MAX_MODE === 'webhook') {
    // Шаг 1: обработчик встраиваем в наш Fastify (startWebhook поднял бы второй http-сервер, CONTRACTS §1.3),
    // но БЕЗ подписки — MAX начнёт слать, только когда мы подпишемся, а это после app.listen.
    subscription = await mountWebhook(app, runtime.bot, config);
    botReady = true;
    log.info({ path: MAX_WEBHOOK_PATH }, 'бот: обработчик webhook встроен, подписка — после старта HTTP');
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  log.info({ port: config.PORT, base: config.PUBLIC_BASE_URL }, 'http слушает');

  // Шаг 2: HTTP слушает — подписываемся. Сбой не фатален: сторож в планировщике повторит в течение 5 минут.
  if (subscription) await subscription.register();

  if (runtime && config.MAX_MODE === 'polling') {
    // ВНИМАНИЕ: polling удаляет все webhook-подписки этого токена (CONTRACTS §1.3) — один токен = один экземпляр.
    void runtime.bot.start({ mode: 'polling', options: { allowedUpdates: ALLOWED_UPDATES } }).catch((e) => {
      const hint = explainStartupError(e);
      log.fatal({ err: (e as Error).message }, hint ?? 'polling не запустился');
      process.exit(1);
    });
    botReady = true;
    log.info({ bot: `https://max.ru/${runtime.username}` }, 'бот: polling запущен');
  }

  const scheduler = startScheduler({ max: runtime?.max ?? null, sendReminders: true, subscription });
  const pollingBot = runtime && config.MAX_MODE === 'polling' ? runtime.bot : null;

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'остановка');
    const timer = setTimeout(() => {
      log.warn('остановка затянулась, выходим принудительно');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    try {
      // Подписку MAX не снимаем: рестарт не должен оставлять бота глухим (server/src/shutdown.ts).
      await stopServices({
        scheduler,
        stopPolling: pollingBot ? () => pollingBot.stopPolling() : undefined,
        app,
        closeDb,
      });
      clearTimeout(timer);
      log.info('остановлено');
      process.exit(0);
    } catch (e) {
      log.error({ err: (e as Error).message }, 'ошибка при остановке');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error({ reason: String(reason) }, 'необработанное отклонение промиса'));
}

main().catch((e) => {
  process.stderr.write(`Критическая ошибка при старте: ${(e as Error).message}\n`);
  process.exit(1);
});
