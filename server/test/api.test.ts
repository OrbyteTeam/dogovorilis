// Контракт API мини-приложения (SPEC §7.8): формат ответов и ошибок, авторизация по initData.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const SELLER = 3001;

describe.skipIf(!DB)('API мини-приложения', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(DB!);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await truncateAll();
    h.max.reset();
  });

  it('без заголовка X-Max-Init-Data — 401 в формате { error: { code, message } }', async () => {
    const res = await h.apiRaw('GET', '/api/me', {});
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: { code: 'init_data_invalid', message: expect.any(String) } });
  });

  it('с испорченной подписью — тоже 401 и тот же формат', async () => {
    const res = await h.apiRaw('GET', '/api/me', { 'x-max-init-data': 'auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef' });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('init_data_invalid');
  });

  it('GET /api/me с подписью отдаёт пользователя, профиль и конфигурацию', async () => {
    const res = await h.api('GET', '/api/me', SELLER);
    expect(res.status).toBe(200);
    expect(res.json.user.id).toBe(SELLER);
    expect(res.json.profile).toBeNull();
    expect(res.json.config).toEqual({ provider: 'none', demo: true, bot_username: 't713_hakaton_max_bot' });
  });

  it('GET /api/templates отдаёт все шесть шаблонов §7.6', async () => {
    const res = await h.api('GET', '/api/templates', SELLER);
    expect(res.status).toBe(200);
    expect(res.json.items.map((t: { key: string }) => t.key)).toEqual([
      'beauty', 'lesson', 'repair', 'custom_order', 'freelance', 'free',
    ]);
    // Шаблон со 100 % предоплаты обязан объяснить это словами: форма молча ставит «Своя» на всю сумму.
    const lesson = res.json.items.find((t: { key: string }) => t.key === 'lesson');
    expect(lesson.prepayment_percent).toBe(100);
    expect(lesson.hint).toBeTruthy();
  });

  it('POST /api/deals с ошибкой в сумме — 400 validation с текстом для поля', async () => {
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'free', title: 'Слишком дорого', total_rub: 2_000_000, prepayment_rub: 0,
      scheduled_at: null, cancel_rule: 'free_24h',
      profile: { display_name: 'Анна', tax_mode: 'npd', payout_details: null, transfer_enabled: true, link_enabled: false, default_cancel_rule: 'free_24h' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('validation');
    expect(res.json.error.message).toContain('1 000 000');
  });

  it('POST /api/deals с датой в прошлом — 400 validation (§14 п. 11)', async () => {
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'free', title: 'Вчерашняя дата', total_rub: 1000, prepayment_rub: 0,
      scheduled_at: new Date(Date.now() - 86_400_000).toISOString(), cancel_rule: 'free_24h',
      profile: { display_name: 'Анна', tax_mode: 'npd', payout_details: null, transfer_enabled: true, link_enabled: false, default_cancel_rule: 'free_24h' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('validation');
  });

  it('POST /api/deals без профиля и без диалога с ботом — card_sent: false (§7.3)', async () => {
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'beauty', title: 'Маникюр с покрытием', total_rub: 2500, prepayment_rub: 500,
      scheduled_at: null, cancel_rule: 'free_24h',
      profile: { display_name: 'Анна Мастер', tax_mode: 'npd', payout_details: 'СБП +7 900 000-00-00', transfer_enabled: true, link_enabled: false, default_cancel_rule: 'free_24h' },
    });
    expect(res.status).toBe(200);
    expect(res.json.card_sent).toBe(false); // диалога с ботом нет — карточку отправить некуда
    expect(res.json.link).toBe(`https://max.ru/t713_hakaton_max_bot?start=d_${res.json.deal.public_id}`);
    expect(res.json.share_text).toContain('Подтвердите нашу договорённость');
    expect(res.json.deal.version.total_kopecks).toBe(250_000);
    expect(res.json.deal.remaining_kopecks).toBe(200_000);
  });

  it('PUT /api/me/profile сохраняет профиль и отдаёт его обратно', async () => {
    const res = await h.api('PUT', '/api/me/profile', SELLER, {
      display_name: 'Мастер Анна', tax_mode: 'ip_kkt', payout_details: 'Т-Банк',
      transfer_enabled: true, link_enabled: false, default_cancel_rule: 'nonrefundable',
    });
    expect(res.status).toBe(200);
    expect(res.json.profile.tax_mode).toBe('ip_kkt');
    const me = await h.api('GET', '/api/me', SELLER);
    expect(me.json.profile.display_name).toBe('Мастер Анна');
  });

  it('GET /api/deals: пустой список, когда сделок нет', async () => {
    const res = await h.api('GET', '/api/deals', SELLER);
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([]);
  });

  it('GET /api/deals отдаёт строку списка со статусом, сроком и суммами (§7.4)', async () => {
    const created = await h.api('POST', '/api/deals', SELLER, {
      template: 'beauty', title: 'Маникюр с покрытием', total_rub: 2500, prepayment_rub: 750,
      scheduled_at: null, cancel_rule: 'free_24h',
      profile: { display_name: 'Анна Мастер', tax_mode: 'npd', payout_details: 'СБП', transfer_enabled: true, link_enabled: false, default_cancel_rule: 'free_24h' },
    });
    expect(created.status).toBe(200);

    const res = await h.api('GET', '/api/deals', SELLER);
    expect(res.status).toBe(200);
    expect(res.json.items).toHaveLength(1);
    expect(res.json.items[0]).toMatchObject({
      public_id: created.json.deal.public_id,
      status: 'awaiting_confirmation',
      role: 'seller',
      demo: false,
      title: 'Маникюр с покрытием',
      scheduled_at: null,
      total_kopecks: 250_000,
      prepayment_kopecks: 75_000,
      paid_kopecks: 0,
    });
    expect(res.json.items[0].status_text).toBeTruthy();
  });

  it('GET /api/deals: фильтры done и awaiting_payment не показывают новую сделку', async () => {
    await h.api('POST', '/api/deals', SELLER, {
      template: 'free', title: 'Свежая сделка', total_rub: 1000, prepayment_rub: 0,
      scheduled_at: null, cancel_rule: 'free_24h',
      profile: { display_name: 'Анна', tax_mode: 'npd', payout_details: null, transfer_enabled: true, link_enabled: false, default_cancel_rule: 'free_24h' },
    });
    expect((await h.api('GET', '/api/deals?filter=active', SELLER)).json.items).toHaveLength(1);
    expect((await h.api('GET', '/api/deals?filter=all', SELLER)).json.items).toHaveLength(1);
    expect((await h.api('GET', '/api/deals?filter=done', SELLER)).json.items).toEqual([]);
    expect((await h.api('GET', '/api/deals?filter=awaiting_payment', SELLER)).json.items).toEqual([]);
  });

  it('GET /api/deals: чужие сделки не видны, role=client пуст для исполнителя', async () => {
    await h.api('POST', '/api/deals', SELLER, {
      template: 'free', title: 'Моя сделка', total_rub: 1000, prepayment_rub: 0,
      scheduled_at: null, cancel_rule: 'free_24h',
      profile: { display_name: 'Анна', tax_mode: 'npd', payout_details: null, transfer_enabled: true, link_enabled: false, default_cancel_rule: 'free_24h' },
    });
    const stranger = await h.api('GET', '/api/deals?filter=all', SELLER + 777);
    expect(stranger.status).toBe(200);
    expect(stranger.json.items).toEqual([]);
    expect((await h.api('GET', '/api/deals?role=client&filter=all', SELLER)).json.items).toEqual([]);
  });

  it('GET /api/deals: демо-сделка (клиент = исполнитель) попадает в список один раз', async () => {
    const created = await h.api('POST', '/api/deals', SELLER, {
      template: 'beauty', title: 'Демо-маникюр', total_rub: 2500, prepayment_rub: 500,
      scheduled_at: null, cancel_rule: 'free_24h',
      profile: { display_name: 'Анна', tax_mode: 'npd', payout_details: null, transfer_enabled: true, link_enabled: false, default_cancel_rule: 'free_24h' },
    });
    // В демо клиент — тот же пользователь (SPEC §12): условие OR в выборке не должно задвоить строку.
    await h.query('UPDATE deals SET demo = true, client_user_id = seller_user_id WHERE public_id = $1', [
      created.json.deal.public_id,
    ]);

    const res = await h.api('GET', '/api/deals?filter=all', SELLER);
    expect(res.json.items).toHaveLength(1);
    expect(res.json.items[0]).toMatchObject({ demo: true, role: 'seller' });
  });

  it('GET /api/deals с неизвестным filter — 400 validation', async () => {
    const res = await h.api('GET', '/api/deals?filter=hack', SELLER);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('validation');
  });

  it('неизвестный метод /api/* — 404 в формате контракта', async () => {
    const res = await h.api('GET', '/api/nothing-here', SELLER);
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('not_found');
  });
});
