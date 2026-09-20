// Проверка initData мини-приложения MAX и hash номера телефона.
//
// Первоисточник — docs/CONTRACTS.md §4.1 (дословный алгоритм со страницы
// dev.max.ru/docs/webapps/validation) и §4.2 (номер телефона). Наши дополнительные
// правила — docs/SPEC.md §9.4/§9.5: срок auth_date 24 ч, сравнение timingSafeEqual,
// отказ → 401 init_data_invalid.
//
// ПОРЯДОК ШАГОВ 2–10 ИЗ §4.1 МЕНЯТЬ НЕЛЬЗЯ: разбор пар идёт до URL-декодирования,
// декодирование — до сортировки, сортировка — до сборки строки для подписи. Любая
// перестановка ломает совпадение с подписью MAX (в примере §4.1 значения закодированы
// дважды, поэтому URLSearchParams здесь тоже не подходит).
//
// Модуль чистый: ни БД, ни config — токен и «сейчас» приходят параметрами.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '../../errors.js';
import { log } from '../../logger.js';

export type InitDataUser = {
  id: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
};

export type InitDataPayload = {
  /** исходная строка, как пришла (для логов её НЕ пишем) */
  raw: string;
  authDate: Date;
  queryId: string | null;
  startParam: string | null;
  user: InitDataUser;
  chat: { id: number; type: 'DIALOG' | 'CHAT' | 'CHANNEL' } | null;
};

/** Срок жизни initData по умолчанию: 24 ч (SPEC §9.4 — наше правило, в документации срока нет). */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Допустимый перекос часов клиента относительно сервера. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const CHAT_TYPES = ['DIALOG', 'CHAT', 'CHANNEL'] as const;
type ChatType = (typeof CHAT_TYPES)[number];

/** Единственная точка отказа: в лог уходит только причина, сама строка initData — никогда. */
function fail(reason: string): never {
  log.warn({ reason }, 'initData: проверка не пройдена');
  throw new UnauthorizedError(`initData: ${reason}`, 'init_data_invalid');
}

/**
 * Сравнение hex-подписей за постоянное время. Разная длина — сразу неудача,
 * без исключения из timingSafeEqual. Входящее значение приводим к нижнему регистру:
 * §4.1 даёт hex в нижнем, но регистр клиента в документации не зафиксирован.
 */
function hexEqual(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received.toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Непустая строка или null — для необязательных полей. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Проверка подписи initData по алгоритму MAX (CONTRACTS §4.1).
 * Бросает UnauthorizedError('…', 'init_data_invalid') при любой неудаче.
 * maxAgeMs по умолчанию 24 ч (SPEC §9.4 — наше правило, в документации срок не задан).
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  opts?: { now?: Date; maxAgeMs?: number },
): InitDataPayload {
  // SPEC §9.4: при MAX_MODE=off и отсутствии токена — 401 всегда (кроме dev-подмены,
  // которая решается выше, в плагине аутентификации).
  if (!botToken) fail('пустой botToken');
  if (typeof initData !== 'string' || initData.trim() === '') fail('пустая строка');

  // Шаг 2: `key=value&…` → [['key','value'], …].
  const params: string[][] = initData.split('&').map((x) => x.split('='));

  // Шаг 3: ключ hash присутствует ровно один раз.
  const hashPairs = params.filter((x) => x[0] === 'hash');
  if (hashPairs.length !== 1) {
    fail(hashPairs.length === 0 ? 'нет параметра hash' : 'параметр hash встречается больше одного раза');
  }
  // Держим ссылку на пару, как в референсном коде: её значение тоже декодируется на шаге 4.
  const hashPair = hashPairs[0];
  if (typeof hashPair[1] !== 'string' || hashPair[1] === '') fail('пустое значение hash');

  // Шаг 4: URL-декодирование всех значений. Параметр без `=` считаем пустым значением
  // (референсный код получил бы там строку "undefined" — артефакт приведения типов).
  for (const p of params) {
    try {
      p[1] = decodeURIComponent(p[1] ?? '');
    } catch {
      fail('значение не декодируется: битая %-последовательность');
    }
  }

  // Шаг 5: сортировка по ключам a → z.
  params.sort((a, b) => a[0].localeCompare(b[0]));

  // Шаг 6: строка `key1=value1\nkey2=value2` без hash.
  const launchParams = params
    .filter((x) => x[0] !== 'hash')
    .map((x) => `${x[0]}=${x[1]}`)
    .join('\n');

  // Шаги 7–9: secret = HMAC('WebAppData', BOT_TOKEN); подпись = HMAC(secret, строка) в hex.
  const secret = createHmac('sha256', 'WebAppData').update(botToken, 'utf8').digest();
  const expected = createHmac('sha256', secret).update(launchParams, 'utf8').digest('hex');

  // Шаг 10.
  if (!hexEqual(expected, hashPair[1])) fail('подпись не совпала');

  // Дальше — разбор полезной нагрузки: только после успешной проверки подписи.
  const values = new Map<string, string>();
  for (const p of params) if (!values.has(p[0])) values.set(p[0], p[1]);

  // auth_date — секунды Unix (в примере §4.1 это 1771409719).
  const rawAuthDate = values.get('auth_date');
  if (!rawAuthDate) fail('нет auth_date');
  if (!/^\d+$/.test(rawAuthDate)) fail('auth_date не целое число секунд');
  const authSeconds = Number(rawAuthDate);
  if (!Number.isSafeInteger(authSeconds) || authSeconds <= 0) fail('auth_date вне допустимого диапазона');
  const authDate = new Date(authSeconds * 1000);

  const now = opts?.now ?? new Date();
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const ageMs = now.getTime() - authDate.getTime();
  if (ageMs > maxAgeMs) fail('auth_date устарел');
  if (ageMs < -CLOCK_SKEW_MS) fail('auth_date из будущего');

  // user обязателен: без id сделку не к кому привязать.
  const rawUser = values.get('user');
  if (!rawUser) fail('нет user');
  let parsedUser: unknown;
  try {
    parsedUser = JSON.parse(rawUser);
  } catch {
    fail('user не разбирается как JSON');
  }
  if (typeof parsedUser !== 'object' || parsedUser === null) fail('user не объект');
  const u = parsedUser as Record<string, unknown>;
  const id = u.id;
  if (typeof id !== 'number' || !Number.isFinite(id)) fail('в user нет числового id');
  const user: InitDataUser = {
    id,
    firstName: str(u.first_name) ?? '',
    lastName: str(u.last_name),
    username: str(u.username),
    languageCode: str(u.language_code),
  };

  // chat — необязателен: приходит не для всех точек входа (§4.1, структура initDataUnsafe).
  let chat: InitDataPayload['chat'] = null;
  const rawChat = values.get('chat');
  if (rawChat) {
    try {
      const c = JSON.parse(rawChat) as { id?: unknown; type?: unknown };
      const chatId = typeof c?.id === 'number' && Number.isFinite(c.id) ? c.id : null;
      const chatType = CHAT_TYPES.includes(c?.type as ChatType) ? (c.type as ChatType) : null;
      if (chatId !== null && chatType !== null) chat = { id: chatId, type: chatType };
      else log.warn({ reason: 'chat без числового id или с неизвестным type' }, 'initData: chat проигнорирован');
    } catch {
      log.warn({ reason: 'chat не разбирается как JSON' }, 'initData: chat проигнорирован');
    }
  }

  return {
    raw: initData,
    authDate,
    queryId: str(values.get('query_id')),
    startParam: str(values.get('start_param')),
    user,
    chat,
  };
}

/**
 * Проверка hash из WebApp.requestContact() (CONTRACTS §4.2).
 * Документация не фиксирует имена ключей — пробуем оба варианта (authDate/auth_date, userId/user_id)
 * и возвращаем, какой совпал, чтобы это можно было залогировать и потом зафиксировать в коде.
 */
export function verifyPhoneHash(a: {
  phone: string;
  authDate: string;
  userId: number;
  hash: string;
  botToken: string;
}): { ok: boolean; variant: 'camel' | 'snake' | null } {
  if (!a.botToken || !a.hash) {
    log.warn(
      { reason: !a.botToken ? 'пустой botToken' : 'пустой hash', userId: a.userId },
      'phone hash: проверка невозможна',
    );
    return { ok: false, variant: null };
  }

  // §4.2: «значение phone не должно содержать `+`».
  const phone = a.phone.trim().replace(/^\+/, '');

  // Основной вариант — camel: так названы поля в ответе requestContact() и в формуле
  // «authDate + phone + userId» на странице бриджа. snake — резервный (§4.2, «что не описано»).
  const variants: Array<{ variant: 'camel' | 'snake'; pairs: Array<[string, string]> }> = [
    {
      variant: 'camel',
      pairs: [
        ['authDate', a.authDate],
        ['phone', phone],
        ['userId', String(a.userId)],
      ],
    },
    {
      variant: 'snake',
      pairs: [
        ['auth_date', a.authDate],
        ['phone', phone],
        ['user_id', String(a.userId)],
      ],
    },
  ];

  for (const v of variants) {
    // Пары — в алфавитном порядке ключей, разделитель \n; ключ HMAC — сам botToken (без secret_key).
    const message = [...v.pairs]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([k, value]) => `${k}=${value}`)
      .join('\n');
    const computed = createHmac('sha256', a.botToken).update(message, 'utf8').digest('hex');
    if (hexEqual(computed, a.hash)) return { ok: true, variant: v.variant };
  }

  log.warn({ userId: a.userId, reason: 'не совпал ни camel, ни snake' }, 'phone hash: проверка не пройдена');
  return { ok: false, variant: null };
}
