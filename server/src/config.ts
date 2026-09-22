// Чтение и валидация окружения. Единственное место, где читается process.env.
// SPEC §4.3 (таблица переменных) и §4.4 п. 1: при ошибке — понятное сообщение и exit(1).
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const intIn = (min: number, max: number, def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .refine((n) => Number.isInteger(n) && n >= min && n <= max, `ожидается целое ${min}…${max}`);

const schema = z
  .object({
    NODE_ENV: z.string().optional().transform((v) => v || 'production'),
    MAX_MODE: z.enum(['polling', 'webhook', 'off']),
    MAX_BOT_TOKEN: z.string().optional().transform((v) => v ?? ''),
    MAX_BOT_USERNAME: z.string().optional().transform((v) => v ?? ''),
    MAX_WEBHOOK_SECRET: z.string().optional().transform((v) => v ?? ''),
    PUBLIC_BASE_URL: z.string().url('ожидается URL, например http://localhost:8080'),
    DATABASE_URL: z.string().min(1, 'пусто; в Docker его подставляет compose.yaml'),
    PAYMENT_PROVIDER: z.enum(['none', 'yookassa', 'tbank']),
    YOOKASSA_SHOP_ID: z.string().optional().transform((v) => v ?? ''),
    YOOKASSA_SECRET_KEY: z.string().optional().transform((v) => v ?? ''),
    TBANK_TERMINAL_KEY: z.string().optional().transform((v) => v ?? ''),
    TBANK_TERMINAL_PASSWORD: z.string().optional().transform((v) => v ?? ''),
    DEMO_MODE: bool(true),
    APP_TIMEZONE: z.string().optional().transform((v) => v || 'Europe/Moscow'),
    PORT: intIn(1, 65535, 8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional().transform((v) => v || 'info'),
    DEV_FAKE_USER_ID: z.string().optional().transform((v) => v ?? ''),
  })
  .superRefine((v, ctx) => {
    const need = (path: keyof typeof v, why: string) => {
      if (!v[path]) ctx.addIssue({ code: 'custom', path: [path], message: why });
    };
    if (v.MAX_MODE !== 'off') need('MAX_BOT_TOKEN', 'обязателен при MAX_MODE=polling|webhook (взять из .env организаторов)');
    if (v.MAX_MODE === 'webhook') {
      need('MAX_WEBHOOK_SECRET', 'обязателен при MAX_MODE=webhook: 5–256 символов [A-Za-z0-9_-]');
      if (v.MAX_WEBHOOK_SECRET && !/^[a-zA-Z0-9_-]{5,256}$/.test(v.MAX_WEBHOOK_SECRET))
        ctx.addIssue({ code: 'custom', path: ['MAX_WEBHOOK_SECRET'], message: 'не подходит под ^[a-zA-Z0-9_-]{5,256}$' });
      if (!v.PUBLIC_BASE_URL.startsWith('https://'))
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'при MAX_MODE=webhook нужен https:// (MAX не принимает http и самоподписанные сертификаты)' });
    }
    // Подмена пользователя мини-приложения — только для локального стенда. На https:// это публичный сервер,
    // и одна забытая переменная открыла бы /api от имени чужого пользователя без initData (ЗАДАЧА_03 G6).
    if (v.DEV_FAKE_USER_ID && v.PUBLIC_BASE_URL.startsWith('https://'))
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_FAKE_USER_ID'],
        message: 'запрещён при https:// в PUBLIC_BASE_URL — подмена пользователя только для локального стенда',
      });
    if (v.PAYMENT_PROVIDER === 'yookassa') {
      need('YOOKASSA_SHOP_ID', 'обязателен при PAYMENT_PROVIDER=yookassa');
      need('YOOKASSA_SECRET_KEY', 'обязателен при PAYMENT_PROVIDER=yookassa');
    }
    if (v.PAYMENT_PROVIDER === 'tbank') {
      need('TBANK_TERMINAL_KEY', 'обязателен при PAYMENT_PROVIDER=tbank');
      need('TBANK_TERMINAL_PASSWORD', 'обязателен при PAYMENT_PROVIDER=tbank');
    }
  });

export type Config = z.infer<typeof schema> & {
  /** Подмена пользователя мини-приложения без Bridge. Работает только при NODE_ENV=development (SPEC §4.3). */
  devFakeUserId: number | null;
  isDevelopment: boolean;
};

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super('Неверная конфигурация:\n' + issues.map((i) => '  • ' + i).join('\n'));
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`));
  }
  const v = parsed.data;
  const isDevelopment = v.NODE_ENV === 'development';
  const fake = Number(v.DEV_FAKE_USER_ID);
  return {
    ...v,
    isDevelopment,
    devFakeUserId: isDevelopment && v.DEV_FAKE_USER_ID && Number.isFinite(fake) ? fake : null,
  };
}

let current: Config | null = null;

/** Вызывается один раз из index.ts (или из тестового хелпера) до обращения к cfg(). */
export function setConfig(c: Config): Config {
  current = c;
  return c;
}

export function cfg(): Config {
  if (!current) throw new Error('config не инициализирован: вызовите setConfig(loadConfig()) при старте');
  return current;
}

/** Ник бота для диплинков. До ответа GET /me — 'bot' (SPEC §19). */
export function botUsername(): string {
  return current?.MAX_BOT_USERNAME || 'bot';
}

/** Ссылка клиента на сделку: https://max.ru/<ник>?start=d_<publicId> (SPEC §13). */
export function dealLink(publicId: string): string {
  return `https://max.ru/${botUsername()}?start=d_${publicId}`;
}
