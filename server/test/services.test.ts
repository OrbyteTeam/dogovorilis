// «Мои услуги» исполнителя (ЗАДАЧА_08 C, SPEC §7.6a, §7.8): проверка полей, CRUD, права, порядок, лимит,
// сделка из услуги (service_id, длительность), «Повторить» и правка условий со сменой услуги.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { servicePrepaymentKopecks, validateService, SERVICES_LIMIT } from '../src/domain/services.js';
import type { ServiceFields } from '../src/db/repos/services.js';
import { createHarness, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
// Лимит /api — 60 запросов в минуту на пользователя (SPEC §17), счётчик живёт в процессе: каждому сквозному
// тесту — свои пользователи, иначе тесты упирались бы в лимит друг друга.
let SELLER = 4901;
let SELLER_CHAT = 7901;
let OTHER = 4902;
let OTHER_CHAT = 7902;
let run = 0;

const base: ServiceFields = {
  title: 'Маникюр с покрытием',
  description: null,
  priceKopecks: 250_000,
  durationMin: 90,
  prepaymentKind: 'percent',
  prepaymentValue: 30,
  cancelRule: 'free_24h',
  template: 'beauty',
};

describe('поля услуги (SPEC §7.6a)', () => {
  it('корректная услуга проходит, название и уточнения подрезаются', () => {
    expect(validateService({ ...base, title: '  Стрижка  ', description: '   ' })).toMatchObject({ title: 'Стрижка', description: null });
  });

  it('ошибки называют поле', () => {
    const bad: Array<[Partial<ServiceFields>, string]> = [
      [{ title: 'Я' }, 'title'],
      [{ description: 'x'.repeat(1001) }, 'description'],
      [{ priceKopecks: 50 }, 'price_rub'],
      [{ priceKopecks: 100_000_001 }, 'price_rub'],
      [{ durationMin: 10 }, 'duration_min'],
      [{ durationMin: 50 }, 'duration_min'],
      [{ durationMin: 735 }, 'duration_min'],
      [{ prepaymentKind: 'percent', prepaymentValue: 0 }, 'prepayment'],
      [{ prepaymentKind: 'percent', prepaymentValue: 101 }, 'prepayment'],
      [{ prepaymentKind: 'amount', prepaymentValue: 300_000 }, 'prepayment'],
      [{ prepaymentKind: 'none', prepaymentValue: 5 }, 'prepayment'],
    ];
    for (const [over, field] of bad) {
      expect(() => validateService({ ...base, ...over }), JSON.stringify(over)).toThrow(expect.objectContaining({ details: { field } }));
    }
  });

  it('предоплата для сделки: процент с округлением до рубля вверх, сумма как есть, нет — 0', () => {
    expect(servicePrepaymentKopecks({ priceKopecks: 250_000, prepaymentKind: 'percent', prepaymentValue: 30 })).toBe(75_000);
    expect(servicePrepaymentKopecks({ priceKopecks: 99_900, prepaymentKind: 'percent', prepaymentValue: 33 })).toBe(33_000);
    expect(servicePrepaymentKopecks({ priceKopecks: 250_000, prepaymentKind: 'amount', prepaymentValue: 50_000 })).toBe(50_000);
    expect(servicePrepaymentKopecks({ priceKopecks: 250_000, prepaymentKind: 'none', prepaymentValue: 0 })).toBe(0);
  });
});

describe.skipIf(!DB)('«Мои услуги»: API и сделки из услуг', () => {
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
    run += 1;
    SELLER = 49_000 + run * 10;
    SELLER_CHAT = 79_000 + run * 10;
    OTHER = SELLER + 1;
    OTHER_CHAT = SELLER_CHAT + 1;
  });

  const body = (over: Record<string, unknown> = {}) => ({
    title: 'Маникюр с покрытием',
    description: 'Снятие, опил, покрытие',
    price_rub: 2500,
    duration_min: 90,
    prepayment: { kind: 'percent', value: 30 },
    cancel_rule: 'free_24h',
    template: 'beauty',
    ...over,
  });
  const create = async (user = SELLER, over: Record<string, unknown> = {}) => {
    const res = await h.api('POST', '/api/services', user, body(over));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.service as { id: number; sort_order: number; active: boolean };
  };
  const list = async (user = SELLER, all = false) => (await h.api('GET', `/api/services${all ? '?all=1' : ''}`, user)).json.items as Array<{ id: number; title: string; active: boolean }>;

  const profile = {
    display_name: 'Анна Мастер', tax_mode: 'npd', payout_details: 'СБП +7 900 000-00-00', transfer_enabled: true,
    link_enabled: false, default_cancel_rule: 'free_24h',
  };
  const createDeal = (serviceId?: number | null, user = SELLER) =>
    h.api('POST', '/api/deals', user, {
      template: 'beauty', title: 'Маникюр с покрытием', total_rub: 2500, prepayment_rub: 750, cancel_rule: 'free_24h', profile,
      ...(serviceId !== undefined ? { service_id: serviceId } : {}),
    });
  const dealRow = async (publicId: string) =>
    (await h.query<{ service_id: number | null; duration_min: number | null }>('SELECT service_id, duration_min FROM deals WHERE public_id = $1', [publicId]))[0];

  it('создать, прочитать, изменить, скрыть и показать снова; суммы в рублях', async () => {
    const s = await create(SELLER, { prepayment: { kind: 'amount', value: 500 } });
    expect(s).toMatchObject({ price_rub: 2500, duration_min: 90, prepayment: { kind: 'amount', value: 500 }, active: true, sort_order: 0 });
    const upd = await h.api('PUT', `/api/services/${s.id}`, SELLER, body({ title: 'Маникюр и дизайн', price_rub: 3000 }));
    expect(upd.json.service).toMatchObject({ title: 'Маникюр и дизайн', price_rub: 3000, active: true });
    const hidden = await h.api('PUT', `/api/services/${s.id}`, SELLER, body({ active: false }));
    expect(hidden.json.service.active).toBe(false);
    expect(await list()).toEqual([]);
    expect((await list(SELLER, true)).map((x) => x.id)).toEqual([s.id]);
    const shown = await h.api('PUT', `/api/services/${s.id}`, SELLER, body({ active: true }));
    expect(shown.json.service.active).toBe(true);
    // правка без active не меняет видимость
    await h.api('PUT', `/api/services/${s.id}`, SELLER, body({ active: false }));
    expect((await h.api('PUT', `/api/services/${s.id}`, SELLER, body())).json.service.active).toBe(false);
  });

  it('валидация в API: 400 с текстом поля; предоплата-сумма больше цены — отказ', async () => {
    expect((await h.api('POST', '/api/services', SELLER, body({ price_rub: 0 }))).status).toBe(400);
    expect((await h.api('POST', '/api/services', SELLER, body({ duration_min: 20 }))).status).toBe(400);
    const tooMuch = await h.api('POST', '/api/services', SELLER, body({ prepayment: { kind: 'amount', value: 3000 } }));
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.json.error.message).toMatch(/Предоплата/);
  });

  it('права: чужую услугу не видно, не изменить, не упорядочить и не подставить в сделку', async () => {
    const mine = await create(SELLER);
    const theirs = await create(OTHER, { title: 'Чужая услуга' });
    expect((await list(OTHER)).map((x) => x.title)).toEqual(['Чужая услуга']);
    expect((await h.api('PUT', `/api/services/${mine.id}`, OTHER, body())).status).toBe(404);
    expect((await h.api('PUT', '/api/services/999999', SELLER, body())).status).toBe(404);
    expect((await h.api('PUT', '/api/services/abc', SELLER, body())).status).toBe(404);
    expect((await h.api('PUT', '/api/services/order', SELLER, { ids: [mine.id, theirs.id] })).status).toBe(400);
    await h.start(SELLER, SELLER_CHAT);
    const foreign = await createDeal(theirs.id);
    expect(foreign.status).toBe(404);
    expect(await h.query('SELECT 1 FROM deals')).toEqual([]);
  });

  it('порядок: только полный список своих без повторов; новая услуга — в конец', async () => {
    const a = await create(SELLER, { title: 'Первая' });
    const b = await create(SELLER, { title: 'Вторая' });
    const c = await create(SELLER, { title: 'Третья' });
    expect([a.sort_order, b.sort_order, c.sort_order]).toEqual([0, 1, 2]);
    const ok = await h.api('PUT', '/api/services/order', SELLER, { ids: [c.id, a.id, b.id] });
    expect(ok.json.items.map((x: { title: string }) => x.title)).toEqual(['Третья', 'Первая', 'Вторая']);
    expect((await h.api('PUT', '/api/services/order', SELLER, { ids: [c.id, a.id] })).status).toBe(400);
    expect((await h.api('PUT', '/api/services/order', SELLER, { ids: [c.id, a.id, a.id] })).status).toBe(400);
    expect((await list()).map((x) => x.title)).toEqual(['Третья', 'Первая', 'Вторая']);
  });

  it(`не больше ${SERVICES_LIMIT} услуг у исполнителя`, async () => {
    for (let i = 0; i < SERVICES_LIMIT; i += 1) await create(SELLER, { title: `Услуга ${i}` });
    const over = await h.api('POST', '/api/services', SELLER, body({ title: 'Лишняя' }));
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe('services_limit');
  }, 60_000);

  it('сделка из услуги помнит её и длительность; без услуги — пусто (считается 60 минут)', async () => {
    await h.start(SELLER, SELLER_CHAT);
    const s = await create(SELLER);
    const withService = await createDeal(s.id);
    expect(withService.status, JSON.stringify(withService.json)).toBe(200);
    const id = withService.json.deal.public_id as string;
    expect(await dealRow(id)).toEqual({ service_id: s.id, duration_min: 90 });
    const edit = await h.api('GET', `/api/deals/${id}`, SELLER);
    expect(edit.json).toMatchObject({ service_id: s.id, duration_min: 90 });

    const plain = await createDeal();
    expect(await dealRow(plain.json.deal.public_id)).toEqual({ service_id: null, duration_min: null });
    // клиент о привязке к услуге ничего не узнаёт: в карточке только условия
    const clientView = h.max.inChat(SELLER_CHAT).map((m) => m.text).join('\n');
    expect(clientView).not.toContain('услуг');
  });

  it('скрытая услуга годится для «Повторить»; правка условий меняет услугу и длительность, null — отвязывает', async () => {
    await h.start(SELLER, SELLER_CHAT);
    const s1 = await create(SELLER);
    const s2 = await create(SELLER, { title: 'Педикюр', duration_min: 120 });
    const id = (await createDeal(s1.id)).json.deal.public_id as string;
    await h.api('PUT', `/api/services/${s1.id}`, SELLER, body({ active: false }));
    expect((await createDeal(s1.id)).status).toBe(200);

    const terms = { title: 'Педикюр', total_rub: 3000, prepayment_rub: 900, cancel_rule: 'free_24h' };
    const changed = await h.api('PUT', `/api/deals/${id}`, SELLER, { ...terms, service_id: s2.id });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    expect(await dealRow(id)).toEqual({ service_id: s2.id, duration_min: 120 });
    // без поля service_id услуга не меняется
    await h.api('PUT', `/api/deals/${id}`, SELLER, { ...terms, total_rub: 3100 });
    expect(await dealRow(id)).toEqual({ service_id: s2.id, duration_min: 120 });
    // чужая услуга при правке — 404, версия не создаётся
    const theirs = await create(OTHER);
    expect((await h.api('PUT', `/api/deals/${id}`, SELLER, { ...terms, total_rub: 3200, service_id: theirs.id })).status).toBe(404);
    const unlinked = await h.api('PUT', `/api/deals/${id}`, SELLER, { ...terms, total_rub: 3300, service_id: null });
    expect(unlinked.status).toBe(200);
    expect(await dealRow(id)).toEqual({ service_id: null, duration_min: null });
    await h.start(OTHER, OTHER_CHAT);
  });
});
