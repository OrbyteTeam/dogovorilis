// HTTP-периметр (ЗАДАЧА_03 G2, G5, G6): /pay/return без XSS, лимит на /webhooks/*, доверие к X-Forwarded-For
// только от своего прокси, /readyz без текста ошибки БД, DEV_FAKE_USER_ID запрещён на https.
// База не нужна и намеренно не подключается: так же проверяется, что /readyz не отдаёт текст ошибки БД.
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, setConfig } from '../src/config.js';
import { createHttpServer, escapeHtml } from '../src/transport/http/server.js';

const BOT = 't713_hakaton_max_bot';

function config() {
  return setConfig(
    loadConfig({
      NODE_ENV: 'test',
      MAX_MODE: 'off',
      MAX_BOT_USERNAME: BOT,
      PUBLIC_BASE_URL: 'http://localhost:8080',
      DATABASE_URL: 'postgres://unused@localhost:5432/unused',
      PAYMENT_PROVIDER: 'none',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv),
  );
}

describe('HTTP-периметр', () => {
  let app: FastifyInstance | null = null;

  async function server(limit = 3): Promise<FastifyInstance> {
    app = await createHttpServer({ config: config(), max: null, botReady: () => true, webhookRateLimit: { max: limit, timeWindowMs: 60_000 } });
    // Служебный маршрут только в тесте: какой IP Fastify считает клиентским при данном прокси.
    app.get('/__test/ip', async (req) => ({ ip: req.ip }));
    await app.ready();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  describe('G2: /pay/return', () => {
    it('d с разметкой → ссылка на бота без payload, ничего не подставлено в HTML', async () => {
      const a = await server();
      const res = await a.inject({ method: 'GET', url: `/pay/return?d=${encodeURIComponent('"><script>alert(1)</script>')}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toMatch(/<script/i);
      expect(res.body).not.toContain('alert(1)');
      expect(res.body).toContain(`href="https://max.ru/${BOT}"`);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    });

    it('валидный public_id → ссылка в сделку; fail=1 → «Оплата не прошла»', async () => {
      const a = await server();
      const ok = await a.inject({ method: 'GET', url: '/pay/return?d=AbC123xyZ0' });
      expect(ok.body).toContain(`href="https://max.ru/${BOT}?start=d_AbC123xyZ0"`);
      expect(ok.body).toContain('Спасибо! Оплата обрабатывается');

      const failed = await a.inject({ method: 'GET', url: '/pay/return?d=AbC123xyZ0&fail=1' });
      expect(failed.body).toContain('Оплата не прошла');

      const tooLong = await a.inject({ method: 'GET', url: '/pay/return?d=AbC123xyZ01' });
      expect(tooLong.body).toContain(`href="https://max.ru/${BOT}"`);
    });

    it('escapeHtml экранирует всё, что ломает атрибут или разметку', () => {
      expect(escapeHtml(`"><img src=x onerror='a'>&`)).toBe('&quot;&gt;&lt;img src=x onerror=&#39;a&#39;&gt;&amp;');
    });
  });

  describe('G5: лимит на /webhooks/* и доверие к X-Forwarded-For', () => {
    const post = (a: FastifyInstance, remoteAddress: string, xff?: string) =>
      a.inject({
        method: 'POST',
        url: '/webhooks/yookassa',
        remoteAddress,
        headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
        payload: '{}',
      });

    it('снаружи X-Forwarded-For не принимается: IP — адрес соединения', async () => {
      const a = await server();
      const ip = async (remoteAddress: string, xff: string) =>
        (await a.inject({ method: 'GET', url: '/__test/ip', remoteAddress, headers: { 'x-forwarded-for': xff } })).json().ip;
      expect(await ip('203.0.113.7', '185.71.76.1')).toBe('203.0.113.7'); // чужой «прокси» — не верим
      expect(await ip('172.18.0.2', '185.71.76.1')).toBe('185.71.76.1'); // Caddy в сети Docker — верим
      expect(await ip('127.0.0.1', '185.71.76.1')).toBe('185.71.76.1'); // loopback — верим
    });

    it('сверх лимита — 429; подмена X-Forwarded-For снаружи лимит не обходит', async () => {
      const a = await server(3);
      const codes: number[] = [];
      for (let i = 1; i <= 4; i++) codes.push((await post(a, '203.0.113.7', `185.71.76.${i}`)).statusCode);
      expect(codes).toEqual([200, 200, 200, 429]);
    });

    it('за своим прокси лимит считается по настоящему клиенту, а не по адресу Caddy', async () => {
      const a = await server(3);
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await post(a, '172.18.0.2', '198.51.100.1')).statusCode);
      expect(codes).toEqual([200, 200, 200, 429]);
      // Другой клиент через тот же Caddy — свой счётчик.
      expect((await post(a, '172.18.0.2', '198.51.100.2')).statusCode).toBe(200);
    });

    it('остальные маршруты лимитом не считаются', async () => {
      const a = await server(1);
      for (let i = 0; i < 5; i++) {
        const res = await a.inject({ method: 'GET', url: '/healthz', remoteAddress: '203.0.113.9' });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  describe('G6: /readyz и DEV_FAKE_USER_ID', () => {
    it('БД недоступна → 503 db:false без текста ошибки', async () => {
      const a = await server();
      const res = await a.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body).toMatchObject({ ok: false, db: false });
      expect(body).not.toHaveProperty('error');
      expect(res.body).not.toMatch(/пул|postgres|connect/i);
    });

    const base = {
      NODE_ENV: 'development',
      MAX_MODE: 'off',
      DATABASE_URL: 'postgres://unused@localhost:5432/unused',
      PAYMENT_PROVIDER: 'none',
    };

    it('DEV_FAKE_USER_ID при https:// в PUBLIC_BASE_URL — ConfigError при старте', () => {
      const env = { ...base, PUBLIC_BASE_URL: 'https://dogovorilis.example', DEV_FAKE_USER_ID: '12345' } as NodeJS.ProcessEnv;
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow(/DEV_FAKE_USER_ID/);
    });

    it('на локальном http:// подмена работает, на https:// без неё сервис стартует', () => {
      const local = loadConfig({ ...base, PUBLIC_BASE_URL: 'http://localhost:8080', DEV_FAKE_USER_ID: '12345' } as NodeJS.ProcessEnv);
      expect(local.devFakeUserId).toBe(12345);
      const prod = loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://dogovorilis.example' } as NodeJS.ProcessEnv);
      expect(prod.devFakeUserId).toBeNull();
    });
  });
});
