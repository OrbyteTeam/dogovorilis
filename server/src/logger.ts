// pino. Никаких console.log в проекте. PII и секреты в логи не попадают:
// токен, initData, реквизиты и ключи провайдеров маскируются redact-правилами (SPEC §4.5).
import { pino } from 'pino';

const REDACT = [
  'token',
  'initData',
  'init_data',
  'headers["x-max-init-data"]',
  'headers.authorization',
  'payoutDetails',
  'payout_details',
  'phone',
  'MAX_BOT_TOKEN',
  'YOOKASSA_SECRET_KEY',
  'TBANK_TERMINAL_PASSWORD',
  'MAX_WEBHOOK_SECRET',
  '*.token',
  '*.initData',
  '*.payoutDetails',
  '*.payout_details',
  '*.phone',
];

let root = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT, censor: '[скрыто]' },
  base: { svc: 'dogovorilis' },
});

/** Переинициализация уровня после загрузки конфигурации. */
export function initLogger(level: string): void {
  root = pino({ level, redact: { paths: REDACT, censor: '[скрыто]' }, base: { svc: 'dogovorilis' } });
}

export const log = {
  child: (bindings: Record<string, unknown>) => root.child(bindings),
  trace: (...a: Parameters<typeof root.trace>) => root.trace(...a),
  debug: (...a: Parameters<typeof root.debug>) => root.debug(...a),
  info: (...a: Parameters<typeof root.info>) => root.info(...a),
  warn: (...a: Parameters<typeof root.warn>) => root.warn(...a),
  error: (...a: Parameters<typeof root.error>) => root.error(...a),
  fatal: (...a: Parameters<typeof root.fatal>) => root.fatal(...a),
};
