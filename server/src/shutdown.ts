// Штатная остановка процесса (SPEC §4.4 п. 7): SIGTERM при `docker compose restart app` или деплое.
//
// Подписку MAX здесь НЕ снимаем. Рестарт длится секунды, а доставки, пришедшие за это время, MAX повторит сам
// (до 10 попыток с растущей паузой, CONTRACTS §1.3) — снятая же подписка не вернулась бы до следующего старта.
// Раньше тут стоял `bot.stopWebhook()`, но в SDK 0.3.1 он снимает подписку только если бот запускался через
// `startWebhook` (флаг webhookIsStarted); после `createWebhook` он ничего не делал — проверено тестом
// в server/test/webhook-mode.test.ts. Убран, чтобы код не обещал того, чего не делает, и не начал делать после
// обновления SDK.

export type Running = {
  scheduler: { stop(): void };
  /** только в режиме polling: остановить long poll (подписок у polling нет) */
  stopPolling?: () => void;
  app: { close(): Promise<unknown> };
  closeDb: () => Promise<void>;
};

export async function stopServices(r: Running): Promise<void> {
  r.scheduler.stop();
  r.stopPolling?.();
  await r.app.close(); // перестаёт принимать соединения и дожидается открытых запросов
  await r.closeDb();
}
