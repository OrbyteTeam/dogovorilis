// Тесты проверки initData (CONTRACTS §4.1) и телефонного hash (CONTRACTS §4.2).
//
// Готового хеша в документации нет, поэтому эталон считается здесь независимой
// реализацией: шаги 7–9 повторены через crypto.subtle, как в референсном коде со
// страницы dev.max.ru, а не через ту же функцию, что проверяется. Это перекрёстная
// проверка алгоритма, а не тавтология.
import { describe, expect, it } from 'vitest';
import { UnauthorizedError } from '../src/errors.js';
import { verifyInitData, verifyPhoneHash } from '../src/transport/http/auth.js';

const BOT_TOKEN = '1234567890:AA-bb_токен-с-Юникодом';
const OTHER_TOKEN = '1234567890:CC-dd_другой';

/** Пары из примера §4.1 (порядок намеренно не алфавитный — проверяем шаг 5). */
const EXAMPLE_PAIRS: Array<[string, string]> = [
  ['chat', '{"id":12345,"type":"DIALOG"}'],
  ['ip', '192.168.0.1'],
  [
    'user',
    '{"id":67890,"first_name":"Max","last_name":"User","username":null,"language_code":"ru","photo_url":null}',
  ],
  ['auth_date', '1771409719'],
  ['query_id', '4c0ab423-342b-4e45-aea4-2747dbc500cd'],
];

/** Строка для подписи из примера §4.1 — дословно. */
const EXAMPLE_LAUNCH_PARAMS = [
  'auth_date=1771409719',
  'chat={"id":12345,"type":"DIALOG"}',
  'ip=192.168.0.1',
  'query_id=4c0ab423-342b-4e45-aea4-2747dbc500cd',
  'user={"id":67890,"first_name":"Max","last_name":"User","username":null,"language_code":"ru","photo_url":null}',
].join('\n');

const AUTH_DATE_MS = 1771409719 * 1000;
const enc = new TextEncoder();

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => ('00' + b.toString(16)).slice(-2))
    .join('');

/** HMAC-SHA256 через crypto.subtle — как в примере кода со страницы MAX. */
async function hmacSubtle(keyBytes: Uint8Array, messageBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, messageBytes as unknown as BufferSource);
  return new Uint8Array(signature);
}

/** Шаги 2, 4–9 референсной реализации: из закодированной строки пар → hex-подпись. */
async function referenceSign(encodedPairs: string, botToken: string): Promise<{ launchParams: string; hash: string }> {
  const params: string[][] = encodedPairs.split('&').map((x) => x.split('='));
  for (const p of params) p[1] = decodeURIComponent(p[1]);
  params.sort((a, b) => a[0].localeCompare(b[0]));
  const launchParams = params
    .filter((x) => x[0] !== 'hash')
    .map((x) => `${x[0]}=${x[1]}`)
    .join('\n');
  const secret = await hmacSubtle(enc.encode('WebAppData'), enc.encode(botToken));
  const signature = await hmacSubtle(secret, enc.encode(launchParams));
  return { launchParams, hash: toHex(signature) };
}

/** `key=value&…` с однократным URL-кодированием значений — как в значении WebAppData. */
function encodePairs(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** Готовая строка initData с корректной подписью. */
async function makeInitData(
  pairs: Array<[string, string]> = EXAMPLE_PAIRS,
  botToken = BOT_TOKEN,
): Promise<{ initData: string; hash: string; launchParams: string }> {
  const encoded = encodePairs(pairs);
  const { hash, launchParams } = await referenceSign(encoded, botToken);
  return { initData: `${encoded}&hash=${hash}`, hash, launchParams };
}

/** Проверяет, что вызов упал именно UnauthorizedError с кодом init_data_invalid. */
function expectUnauthorized(fn: () => unknown): UnauthorizedError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UnauthorizedError);
    expect((e as UnauthorizedError).code).toBe('init_data_invalid');
    return e as UnauthorizedError;
  }
  throw new Error('ожидался UnauthorizedError, но исключения не было');
}

/** «Сейчас» для примера из документации: auth_date + 1 минута. */
const nowForExample = new Date(AUTH_DATE_MS + 60_000);

describe('verifyInitData — пример из CONTRACTS §4.1', () => {
  it('строка для подписи совпадает с примером из документации', async () => {
    const { launchParams } = await makeInitData();
    expect(launchParams).toBe(EXAMPLE_LAUNCH_PARAMS);
  });

  it('принимает подпись, посчитанную независимой реализацией (crypto.subtle)', async () => {
    const { initData } = await makeInitData();
    const payload = verifyInitData(initData, BOT_TOKEN, { now: nowForExample });

    expect(payload.user.id).toBe(67890);
    expect(payload.user.firstName).toBe('Max');
    expect(payload.user.lastName).toBe('User');
    expect(payload.user.username).toBeNull();
    expect(payload.user.languageCode).toBe('ru');
    expect(payload.authDate.getTime()).toBe(AUTH_DATE_MS);
    expect(payload.authDate.toISOString()).toBe(new Date(AUTH_DATE_MS).toISOString());
    expect(payload.chat).toEqual({ id: 12345, type: 'DIALOG' });
    expect(payload.queryId).toBe('4c0ab423-342b-4e45-aea4-2747dbc500cd');
    expect(payload.startParam).toBeNull();
    expect(payload.raw).toBe(initData);
  });
});

describe('verifyInitData — подделка данных', () => {
  it('изменённое значение поля при том же hash → 401', async () => {
    const { hash } = await makeInitData();
    const tampered = encodePairs(
      EXAMPLE_PAIRS.map(([k, v]) => (k === 'ip' ? ['ip', '10.0.0.1'] : [k, v]) as [string, string]),
    );
    expectUnauthorized(() => verifyInitData(`${tampered}&hash=${hash}`, BOT_TOKEN, { now: nowForExample }));
  });

  it('подменённый user.id при том же hash → 401', async () => {
    const { hash } = await makeInitData();
    const tampered = encodePairs(
      EXAMPLE_PAIRS.map(([k, v]) =>
        k === 'user' ? ['user', v.replace('67890', '11111')] : [k, v],
      ) as Array<[string, string]>,
    );
    expectUnauthorized(() => verifyInitData(`${tampered}&hash=${hash}`, BOT_TOKEN, { now: nowForExample }));
  });

  it('изменённый hash → 401', async () => {
    const { initData, hash } = await makeInitData();
    const broken = initData.replace(hash, hash.slice(0, -1) + (hash.endsWith('a') ? 'b' : 'a'));
    expectUnauthorized(() => verifyInitData(broken, BOT_TOKEN, { now: nowForExample }));
  });

  it('обрезанный hash (другая длина) → 401, без исключения из timingSafeEqual', async () => {
    const { initData, hash } = await makeInitData();
    expectUnauthorized(() =>
      verifyInitData(initData.replace(hash, hash.slice(0, 10)), BOT_TOKEN, { now: nowForExample }),
    );
  });

  it('два параметра hash → 401', async () => {
    const { initData, hash } = await makeInitData();
    expectUnauthorized(() => verifyInitData(`${initData}&hash=${hash}`, BOT_TOKEN, { now: nowForExample }));
  });

  it('отсутствие hash → 401', async () => {
    expectUnauthorized(() => verifyInitData(encodePairs(EXAMPLE_PAIRS), BOT_TOKEN, { now: nowForExample }));
  });

  it('пустая строка → 401', () => {
    expectUnauthorized(() => verifyInitData('', BOT_TOKEN, { now: nowForExample }));
  });
});

describe('verifyInitData — срок действия auth_date', () => {
  it('auth_date старше 24 ч → 401', async () => {
    const { initData } = await makeInitData();
    expectUnauthorized(() =>
      verifyInitData(initData, BOT_TOKEN, { now: new Date(AUTH_DATE_MS + 25 * 3600_000) }),
    );
  });

  it('та же строка при увеличенном maxAgeMs → проходит', async () => {
    const { initData } = await makeInitData();
    const payload = verifyInitData(initData, BOT_TOKEN, {
      now: new Date(AUTH_DATE_MS + 25 * 3600_000),
      maxAgeMs: 48 * 3600_000,
    });
    expect(payload.user.id).toBe(67890);
  });

  it('ровно на границе 24 ч → проходит', async () => {
    const { initData } = await makeInitData();
    const payload = verifyInitData(initData, BOT_TOKEN, { now: new Date(AUTH_DATE_MS + 24 * 3600_000) });
    expect(payload.user.id).toBe(67890);
  });

  it('auth_date в будущем на час → 401', async () => {
    const { initData } = await makeInitData();
    expectUnauthorized(() => verifyInitData(initData, BOT_TOKEN, { now: new Date(AUTH_DATE_MS - 3600_000) }));
  });

  it('небольшой перекос часов (2 минуты вперёд) допустим', async () => {
    const { initData } = await makeInitData();
    const payload = verifyInitData(initData, BOT_TOKEN, { now: new Date(AUTH_DATE_MS - 2 * 60_000) });
    expect(payload.user.id).toBe(67890);
  });

  it('нечисловой auth_date → 401', async () => {
    const pairs = EXAMPLE_PAIRS.map(([k, v]) => (k === 'auth_date' ? ['auth_date', 'вчера'] : [k, v]) as [string, string]);
    const { initData } = await makeInitData(pairs);
    expectUnauthorized(() => verifyInitData(initData, BOT_TOKEN, { now: nowForExample }));
  });
});

describe('verifyInitData — токен бота', () => {
  it('пустой botToken → 401', async () => {
    const { initData } = await makeInitData();
    expectUnauthorized(() => verifyInitData(initData, '', { now: nowForExample }));
  });

  it('другой токен бота → 401', async () => {
    const { initData } = await makeInitData();
    expectUnauthorized(() => verifyInitData(initData, OTHER_TOKEN, { now: nowForExample }));
  });

  it('подпись, посчитанная чужим токеном → 401', async () => {
    const { initData } = await makeInitData(EXAMPLE_PAIRS, OTHER_TOKEN);
    expectUnauthorized(() => verifyInitData(initData, BOT_TOKEN, { now: nowForExample }));
  });
});

describe('verifyInitData — start_param и кодирование значений', () => {
  it('диплинк ?startapp=d_AbC123xyZ0 доходит до payload.startParam и входит в подпись', async () => {
    const pairs: Array<[string, string]> = [...EXAMPLE_PAIRS, ['start_param', 'd_AbC123xyZ0']];
    const { initData, launchParams } = await makeInitData(pairs);
    expect(launchParams).toContain('start_param=d_AbC123xyZ0');

    const payload = verifyInitData(initData, BOT_TOKEN, { now: nowForExample });
    expect(payload.startParam).toBe('d_AbC123xyZ0');

    // тот же start_param, но подпись от строки без него → 401
    const { hash: hashWithout } = await makeInitData();
    expectUnauthorized(() =>
      verifyInitData(`${encodePairs(pairs)}&hash=${hashWithout}`, BOT_TOKEN, { now: nowForExample }),
    );
  });

  it('значения с URL-кодированием (пробел, %, эмодзи) проходят проверку', async () => {
    const user = JSON.stringify({
      id: 67890,
      first_name: 'Мария Анна %100 🎉',
      last_name: 'Ф+Ф & Co',
      username: 'mary=max',
      language_code: 'ru',
      photo_url: null,
    });
    const pairs: Array<[string, string]> = [
      ['auth_date', '1771409719'],
      ['user', user],
      ['start_param', 'd_AbC123xyZ0'],
    ];
    const { initData } = await makeInitData(pairs);
    const payload = verifyInitData(initData, BOT_TOKEN, { now: nowForExample });

    expect(payload.user.firstName).toBe('Мария Анна %100 🎉');
    expect(payload.user.lastName).toBe('Ф+Ф & Co');
    expect(payload.user.username).toBe('mary=max');
    expect(payload.chat).toBeNull();
  });

  it('user без числового id → 401', async () => {
    const pairs: Array<[string, string]> = [
      ['auth_date', '1771409719'],
      ['user', '{"first_name":"Max"}'],
    ];
    const { initData } = await makeInitData(pairs);
    expectUnauthorized(() => verifyInitData(initData, BOT_TOKEN, { now: nowForExample }));
  });

  it('без user → 401', async () => {
    const pairs: Array<[string, string]> = [
      ['auth_date', '1771409719'],
      ['ip', '192.168.0.1'],
    ];
    const { initData } = await makeInitData(pairs);
    expectUnauthorized(() => verifyInitData(initData, BOT_TOKEN, { now: nowForExample }));
  });
});

describe('verifyPhoneHash — CONTRACTS §4.2', () => {
  const PHONE = '79991234567';
  const AUTH_DATE = '1771409719';
  const USER_ID = 67890;

  const phoneHash = async (message: string, botToken = BOT_TOKEN): Promise<string> =>
    toHex(await hmacSubtle(enc.encode(botToken), enc.encode(message)));

  const camelMessage = `authDate=${AUTH_DATE}\nphone=${PHONE}\nuserId=${USER_ID}`;
  const snakeMessage = `auth_date=${AUTH_DATE}\nphone=${PHONE}\nuser_id=${USER_ID}`;

  it('вариант camel (authDate/phone/userId) → { ok: true, variant: "camel" }', async () => {
    const hash = await phoneHash(camelMessage);
    expect(verifyPhoneHash({ phone: PHONE, authDate: AUTH_DATE, userId: USER_ID, hash, botToken: BOT_TOKEN })).toEqual({
      ok: true,
      variant: 'camel',
    });
  });

  it('вариант snake (auth_date/phone/user_id) → { ok: true, variant: "snake" }', async () => {
    const hash = await phoneHash(snakeMessage);
    expect(verifyPhoneHash({ phone: PHONE, authDate: AUTH_DATE, userId: USER_ID, hash, botToken: BOT_TOKEN })).toEqual({
      ok: true,
      variant: 'snake',
    });
  });

  it('мусорный hash → { ok: false, variant: null }', () => {
    expect(
      verifyPhoneHash({ phone: PHONE, authDate: AUTH_DATE, userId: USER_ID, hash: 'deadbeef', botToken: BOT_TOKEN }),
    ).toEqual({ ok: false, variant: null });
  });

  it('+7… и 7… дают одинаковый результат (§4.2: phone без «+»)', async () => {
    const hash = await phoneHash(camelMessage);
    const withPlus = verifyPhoneHash({ phone: `+${PHONE}`, authDate: AUTH_DATE, userId: USER_ID, hash, botToken: BOT_TOKEN });
    const without = verifyPhoneHash({ phone: PHONE, authDate: AUTH_DATE, userId: USER_ID, hash, botToken: BOT_TOKEN });
    expect(withPlus).toEqual(without);
    expect(withPlus).toEqual({ ok: true, variant: 'camel' });
  });

  it('чужой токен бота → { ok: false, variant: null }', async () => {
    const hash = await phoneHash(camelMessage, OTHER_TOKEN);
    expect(verifyPhoneHash({ phone: PHONE, authDate: AUTH_DATE, userId: USER_ID, hash, botToken: BOT_TOKEN })).toEqual({
      ok: false,
      variant: null,
    });
  });

  it('другой userId → { ok: false, variant: null }', async () => {
    const hash = await phoneHash(camelMessage);
    expect(verifyPhoneHash({ phone: PHONE, authDate: AUTH_DATE, userId: 11111, hash, botToken: BOT_TOKEN })).toEqual({
      ok: false,
      variant: null,
    });
  });

  it('пустые botToken и hash → { ok: false, variant: null }, без исключения', async () => {
    const hash = await phoneHash(camelMessage);
    expect(verifyPhoneHash({ phone: PHONE, authDate: AUTH_DATE, userId: USER_ID, hash, botToken: '' })).toEqual({
      ok: false,
      variant: null,
    });
    expect(verifyPhoneHash({ phone: PHONE, authDate: AUTH_DATE, userId: USER_ID, hash: '', botToken: BOT_TOKEN })).toEqual({
      ok: false,
      variant: null,
    });
  });

  it('hash в верхнем регистре тоже принимается', async () => {
    const hash = (await phoneHash(camelMessage)).toUpperCase();
    expect(verifyPhoneHash({ phone: PHONE, authDate: AUTH_DATE, userId: USER_ID, hash, botToken: BOT_TOKEN })).toEqual({
      ok: true,
      variant: 'camel',
    });
  });
});
