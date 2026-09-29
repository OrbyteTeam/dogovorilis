// Надёжность исполнителя и оценка клиента (ЗАДАЧА_08 E, SPEC §7.11): R1 после закрытия, оценка один раз,
// комментарий, права, показатели из фактов (демо не считается), строка в карточке клиента по переключателю.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { cardMid, createHarness, livePaymentId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const TIMEOUT = 150_000;

let run = 0;
let SELLER = 0;
let SELLER_CHAT = 0;
let CLIENT = 0;
let CLIENT_CHAT = 0;
let STRANGER = 0;

describe('строка надёжности и склонение', () => {
  it('«N сделок, M % без споров»; без данных о спорах — только число', () => {
    expect(texts.reliabilityLine({ closed: 1, noDisputePercent: 100 })).toBe('1 сделка, 100 % без споров');
    expect(texts.reliabilityLine({ closed: 3, noDisputePercent: 67 })).toBe('3 сделки, 67 % без споров');
    expect(texts.reliabilityLine({ closed: 120, noDisputePercent: 98 })).toBe('120 сделок, 98 % без споров');
    expect(texts.reliabilityLine({ closed: 11, noDisputePercent: null })).toBe('11 сделок');
    expect(texts.reliabilityLine({ closed: 22, noDisputePercent: 50 })).toBe('22 сделки, 50 % без споров');
  });
});

describe.skipIf(!DB)('оценка клиента и надёжность исполнителя', () => {
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
    SELLER = 60_000 + run * 10;
    CLIENT = SELLER + 1;
    STRANGER = SELLER + 2;
    SELLER_CHAT = 90_000 + run * 10;
    CLIENT_CHAT = SELLER_CHAT + 1;
  });

  const profile = {
    display_name: 'Анна Мастер', tax_mode: 'npd', payout_details: 'СБП +7 900 000-00-00', transfer_enabled: true,
    link_enabled: false, default_cancel_rule: 'free_24h',
  };
  const act = (id: string, user: number, body: Record<string, unknown>) => h.api('POST', `/api/deals/${id}/actions`, user, body);

  /** Настоящая сделка до «закрыта»: предоплата 100 % переводом, «Выполнено», «Принимаю», «Закрыть без чека». */
  async function closedDeal(): Promise<string> {
    await h.start(SELLER, SELLER_CHAT);
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'free', title: 'Стрижка', total_rub: 2000, prepayment_rub: 2000, cancel_rule: 'free_24h', profile,
    });
    const id = res.json.deal.public_id as string;
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    await act(id, CLIENT, { action: 'confirm', version: 1 });
    const clientCard = await cardMid(h, id, 'client');
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const pid = await livePaymentId(h, id, 'prepayment');
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, await cardMid(h, id, 'seller'));
    await act(id, SELLER, { action: 'done' });
    await act(id, CLIENT, { action: 'accept' });
    const closed = await act(id, SELLER, { action: 'close_without_receipt' });
    expect(closed.json.deal.status).toBe('closed');
    return id;
  }

  /** Закрытые не-демо (и одна демо) сделки исполнителя — прямо в БД: показателям нужны только факты. */
  async function seedClosed(n: number, demo = 0): Promise<void> {
    await h.start(SELLER, SELLER_CHAT);
    await h.api('PUT', '/api/me/profile', SELLER, profile);
    for (let i = 0; i < n + demo; i += 1) {
      await h.query(
        `INSERT INTO deals (public_id, seller_user_id, template, status, demo, confirmed_at, done_at, paid_at, closed_at)
         VALUES ($1, $2, 'free', 'closed', $3, now(), now(), now(), now())`,
        [`Seed${String(run).padStart(3, '0')}${String(i).padStart(3, '0')}`, SELLER, i >= n],
      );
    }
  }

  it(
    'после закрытия клиенту R1; оценка один раз, R2 исполнителю, комментарий — R3; повтор не меняет оценку',
    async () => {
      const id = await closedDeal();
      const r1 = h.max.inChat(CLIENT_CHAT).find((m) => m.text.includes('Оцените работу'));
      expect(r1).toBeDefined();
      expect(r1!.buttons.map((b) => b.payload)).toEqual([1, 2, 3, 4, 5].map((n) => `rt:${id}:${n}`));
      // R1 — после квитанции: сначала документ, потом просьба оценить
      const clientMsgs = h.max.inChat(CLIENT_CHAT).map((m) => m.text);
      expect(clientMsgs.findIndex((t) => t.includes('Оцените работу'))).toBeGreaterThan(clientMsgs.findIndex((t) => t.includes('Квитанц')));

      h.max.reset();
      await h.press(CLIENT, CLIENT_CHAT, `rt:${id}:5`, null);
      expect(h.max.texts().some((t) => t.includes(texts.RATING_THANKS(5)))).toBe(true);
      expect(h.max.inChat(SELLER_CHAT).some((m) => m.text.includes('оценил(а) работу') && m.text.includes('5 из 5'))).toBe(true);
      await h.press(CLIENT, CLIENT_CHAT, `rt:${id}:1`, null);
      expect(h.max.texts().some((t) => t.includes(texts.RATING_ALREADY))).toBe(true);
      const [row] = await h.query<{ score: number; comment: string | null }>(
        'SELECT r.score, r.comment FROM deal_ratings r JOIN deals d ON d.id = r.deal_id WHERE d.public_id = $1',
        [id],
      );
      expect(row).toEqual({ score: 5, comment: null });

      await h.say(CLIENT, CLIENT_CHAT, 'Всё отлично, приду ещё');
      expect(h.max.inChat(SELLER_CHAT).some((m) => m.text.includes('Комментарий') && m.text.includes('приду ещё'))).toBe(true);
      const [after] = await h.query<{ comment: string | null }>(
        'SELECT r.comment FROM deal_ratings r JOIN deals d ON d.id = r.deal_id WHERE d.public_id = $1',
        [id],
      );
      expect(after.comment).toBe('Всё отлично, приду ещё');

      // экран сделки: исполнитель видит оценку и комментарий, клиент — свою оценку
      expect((await h.api('GET', `/api/deals/${id}/full`, SELLER)).json.rating).toEqual({ score: 5, comment: 'Всё отлично, приду ещё' });
      expect((await h.api('GET', `/api/deals/${id}/full`, CLIENT)).json.rating).toEqual({ score: 5, comment: 'Всё отлично, приду ещё' });
    },
    TIMEOUT,
  );

  it('права: исполнитель и посторонний оценить не могут; до закрытия — нельзя; «Без комментария» снимает ожидание', async () => {
    const id = await closedDeal();
    await h.start(STRANGER, 99_010);
    await h.press(STRANGER, 99_010, `rt:${id}:1`, null);
    await h.press(SELLER, SELLER_CHAT, `rt:${id}:1`, null);
    expect(await h.query('SELECT 1 FROM deal_ratings')).toEqual([]);

    await h.press(CLIENT, CLIENT_CHAT, `rt:${id}:4`, null);
    await h.press(CLIENT, CLIENT_CHAT, `rt:n:${id}`, null);
    expect(await h.query('SELECT 1 FROM user_inputs')).toEqual([]);
    h.max.reset();
    await h.say(CLIENT, CLIENT_CHAT, 'случайный текст');
    expect(h.max.texts().join('\n')).toContain(texts.S3); // ожидание комментария снято — обычный ответ

    // сделка не закрыта — оценки нет
    const res = await h.api('POST', '/api/deals', SELLER, { template: 'free', title: 'Ещё', total_rub: 1000, prepayment_rub: 0, cancel_rule: 'free_24h' });
    const open = res.json.deal.public_id as string;
    await h.start(CLIENT, CLIENT_CHAT, `d_${open}`);
    await h.press(CLIENT, CLIENT_CHAT, `rt:${open}:5`, null);
    expect((await h.query('SELECT 1 FROM deal_ratings')).length).toBe(1);
  }, TIMEOUT);

  it('показатели в /api/me из фактов, демо не считается; строка в карточке клиента — только по переключателю и от 3 сделок', async () => {
    await seedClosed(3, 1);
    const me = await h.api('GET', '/api/me', SELLER);
    expect(me.json.profile.show_reliability).toBe(false);
    expect(me.json.reliability).toMatchObject({ closed: 3, no_dispute_percent: 100, seller_cancel_percent: 0, rating: null });

    // живая сделка с клиентом — на её карточке строка появится после включения
    const res = await h.api('POST', '/api/deals', SELLER, { template: 'free', title: 'Живая', total_rub: 1000, prepayment_rub: 0, cancel_rule: 'free_24h' });
    const id = res.json.deal.public_id as string;
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const clientCard = await cardMid(h, id, 'client');
    expect(h.max.byMid(clientCard)!.text).not.toContain('без споров');
    expect((await h.api('GET', `/api/deals/${id}/full`, CLIENT)).json.reliability_line).toBeNull();

    const on = await h.api('PUT', '/api/me/profile', SELLER, { ...profile, show_reliability: true });
    expect(on.json.profile.show_reliability).toBe(true);
    await h.press(CLIENT, CLIENT_CHAT, `op:${id}`, clientCard);
    expect(h.max.byMid(clientCard)!.text).toContain('🛡 3 сделки, 100 % без споров');
    expect((await h.api('GET', `/api/deals/${id}/full`, CLIENT)).json.reliability_line).toBe('3 сделки, 100 % без споров');
    // исполнителю — своя строка на экране сделки, а в его карточке строки нет
    expect((await h.api('GET', `/api/deals/${id}/full`, SELLER)).json.reliability_line).toBe('3 сделки, 100 % без споров');
    expect(h.max.byMid(await cardMid(h, id, 'seller'))!.text).not.toContain('без споров');
    // профиль без поля show_reliability не выключает показ
    await h.api('PUT', '/api/me/profile', SELLER, profile);
    expect((await h.api('GET', '/api/me', SELLER)).json.profile.show_reliability).toBe(true);
  });

  it('меньше трёх закрытых сделок — клиенту строка не показывается даже при включённом переключателе', async () => {
    await seedClosed(2);
    await h.api('PUT', '/api/me/profile', SELLER, { ...profile, show_reliability: true });
    const res = await h.api('POST', '/api/deals', SELLER, { template: 'free', title: 'Живая', total_rub: 1000, prepayment_rub: 0, cancel_rule: 'free_24h' });
    const id = res.json.deal.public_id as string;
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    expect(h.max.byMid(await cardMid(h, id, 'client'))!.text).not.toContain('без споров');
    expect((await h.api('GET', `/api/deals/${id}/full`, CLIENT)).json.reliability_line).toBeNull();
  });
});
