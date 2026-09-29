// «Другое время» (ЗАДАЧА_08 D, SPEC §7.10): занятость исполнителя, предложение клиента, принятие одной кнопкой (T5),
// гонка «два клиента на одно время», устаревшее предложение, права. Машина состояний не меняется: T4 и T5.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { DAY_MS, partsIn, zonedToUtc } from '../src/domain/time.js';
import { cardMid, createHarness, dealStatus, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const TIMEOUT = 120_000;

/** Момент «через N дней в hh:mm по МСК» — всегда на сетке пикера и в пределах 30 дней. */
function msk(daysAhead: number, hh: number, mm = 0): Date {
  const p = partsIn(new Date(Date.now() + daysAhead * DAY_MS), 'Europe/Moscow');
  return zonedToUtc(p.year, p.month, p.day, hh, mm);
}

// Лимит /api — 60 запросов в минуту на пользователя: у каждого теста свои пользователи.
let run = 0;
let SELLER = 0;
let SELLER_CHAT = 0;
let CLIENT = 0;
let CLIENT_CHAT = 0;
let CLIENT2 = 0;
let CLIENT2_CHAT = 0;
let STRANGER = 0;

describe.skipIf(!DB)('«Другое время»: занятость, предложение, принятие', () => {
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
    SELLER = 50_000 + run * 10;
    CLIENT = SELLER + 1;
    CLIENT2 = SELLER + 2;
    STRANGER = SELLER + 3;
    SELLER_CHAT = 80_000 + run * 10;
    CLIENT_CHAT = SELLER_CHAT + 1;
    CLIENT2_CHAT = SELLER_CHAT + 2;
  });

  const profile = {
    display_name: 'Анна Мастер', tax_mode: 'npd', payout_details: 'СБП +7 900 000-00-00', transfer_enabled: true,
    link_enabled: false, default_cancel_rule: 'free_24h',
  };

  /** Сделка исполнителя без предоплаты; `serviceId` — длительность услуги. */
  async function createDeal(at: Date | null, serviceId?: number): Promise<string> {
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'free', title: 'Стрижка', total_rub: 2000, prepayment_rub: 0, cancel_rule: 'free_24h', profile,
      scheduled_at: at ? at.toISOString() : null,
      ...(serviceId ? { service_id: serviceId } : {}),
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.deal.public_id as string;
  }
  /** Сделка, в которой клиент открыл ссылку (ждём подтверждения). */
  async function dealWithClient(at: Date | null, client = CLIENT, chat = CLIENT_CHAT, serviceId?: number): Promise<string> {
    const id = await createDeal(at, serviceId);
    await h.start(client, chat, `d_${id}`);
    return id;
  }
  /** Договорились: клиент подтвердил, без предоплаты — `scheduled`, время занято. */
  async function scheduledDeal(at: Date, client = CLIENT2, chat = CLIENT2_CHAT, serviceId?: number): Promise<string> {
    const id = await dealWithClient(at, client, chat, serviceId);
    const r = await h.api('POST', `/api/deals/${id}/actions`, client, { action: 'confirm', version: 1 });
    expect(r.json.deal.status).toBe('scheduled');
    return id;
  }
  const propose = (id: string, user: number, at: Date) => h.api('POST', `/api/deals/${id}/time-proposals`, user, { scheduled_at: at.toISOString() });
  const busy = (id: string, user: number) => h.api('GET', `/api/deals/${id}/busy`, user);
  const proposals = (id: string) =>
    h.query<{ id: number; status: string; accepted_version: number | null }>(
      'SELECT p.id, p.status, p.accepted_version FROM time_proposals p JOIN deals d ON d.id = p.deal_id WHERE d.public_id = $1 ORDER BY p.id',
      [id],
    );
  const currentTime = async (id: string) =>
    (await h.query<{ scheduled_at: Date; version: number }>(
      'SELECT v.scheduled_at, v.version FROM deals d JOIN deal_versions v ON v.deal_id = d.id AND v.version = d.current_version WHERE d.public_id = $1',
      [id],
    ))[0];

  it('занятость: визиты в «договорились» с длительностью; без этой сделки, демо, неподтверждённых и отменённых', async () => {
    await h.start(SELLER, SELLER_CHAT);
    const service = await h.api('POST', '/api/services', SELLER, {
      title: 'Окрашивание', price_rub: 5000, duration_min: 90, prepayment: { kind: 'none', value: 0 }, cancel_rule: 'free_24h',
    });
    await scheduledDeal(msk(2, 10), CLIENT2, CLIENT2_CHAT, service.json.service.id); // 10:00–11:30
    await dealWithClient(msk(2, 15), STRANGER, 99_001); // ждёт подтверждения — не занято
    await h.press(SELLER, SELLER_CHAT, 'dm:new', null); // демо — не занято
    const mine = await dealWithClient(msk(3, 12));

    const res = await busy(mine, CLIENT);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ duration_min: 60, step_min: 30, first_slot: '08:00', last_slot: '21:30', horizon_days: 30, min_lead_min: 30 });
    expect(res.json.current).toBe(msk(3, 12).toISOString());
    expect(res.json.busy).toEqual([{ start: msk(2, 10).toISOString(), end: msk(2, 11, 30).toISOString() }]);
    // посторонний занятость не видит
    expect((await busy(mine, 99_999)).status).toBe(403);
  });

  it(
    'клиент предлагает время: T4, N3T с «Принять» вместо N3, кнопка «Принять» и в карточке исполнителя',
    async () => {
      await h.start(SELLER, SELLER_CHAT);
      const id = await dealWithClient(msk(3, 12));
      h.max.reset();
      const res = await propose(id, CLIENT, msk(4, 18));
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.proposal).toMatchObject({ status: 'pending', scheduled_at: msk(4, 18).toISOString() });
      expect(res.json.deal.status).toBe('changes_requested');
      expect(await dealStatus(h, id)).toBe('changes_requested');

      const toSeller = h.max.inChat(SELLER_CHAT);
      const n3t = toSeller.find((m) => m.text.includes('предлагает другое время'));
      expect(n3t, toSeller.map((m) => m.text).join('\n---\n')).toBeDefined();
      expect(n3t!.buttons.map((b) => b.type)).toEqual(['callback', 'open_app']);
      expect(n3t!.buttons[0].payload).toMatch(new RegExp(`^tp:${id}:\\d+$`));
      expect(toSeller.some((m) => m.text.includes('предлагает изменения'))).toBe(false); // без дубля N3
      // карточка исполнителя: «Принять …» первой, потом «Изменить условия», «Оставить как есть», «Отменить»
      const card = h.max.byMid(await cardMid(h, id, 'seller'))!;
      expect(card.buttons[0].payload).toMatch(/^tp:/);
      // экран сделки исполнителя: accept_time и подпись
      const full = await h.api('GET', `/api/deals/${id}/full`, SELLER);
      expect(full.json.actions[0]).toBe('accept_time');
      expect(full.json.time_proposal.scheduled_at).toBe(msk(4, 18).toISOString());
      expect(full.json.timeline.map((t: { text: string }) => t.text).at(-1)).toMatch(/^Клиент предложил другое время: /);

      // повторное предложение в changes_requested — без перехода, прежнее вытеснено
      const again = await propose(id, CLIENT, msk(5, 9));
      expect(again.status).toBe(200);
      expect((await proposals(id)).map((p) => p.status)).toEqual(['superseded', 'pending']);
    },
    TIMEOUT,
  );

  it('проверки предложения: сетка, «то же время», занято, чужие', async () => {
    await h.start(SELLER, SELLER_CHAT);
    await scheduledDeal(msk(2, 10));
    const id = await dealWithClient(msk(3, 12));
    expect((await propose(id, CLIENT, msk(3, 12))).status).toBe(400); // то же время
    expect((await propose(id, CLIENT, msk(4, 10, 15))).status).toBe(400); // не на сетке
    expect((await propose(id, CLIENT, msk(4, 7))).status).toBe(400); // раньше 08:00
    expect((await propose(id, CLIENT, msk(40, 12))).status).toBe(400); // дальше 30 дней
    const taken = await propose(id, CLIENT, msk(2, 9, 30)); // 09:30–10:30 задевает 10:00–11:00
    expect(taken.status).toBe(409);
    expect(taken.json.error).toMatchObject({ code: 'slot_busy', message: texts.API_SLOT_BUSY });
    expect((await propose(id, CLIENT, msk(2, 11))).status).toBe(200); // впритык после визита — свободно
    expect((await propose(id, SELLER, msk(4, 12))).status).toBe(403); // время предлагает клиент
    expect((await propose(id, 99_998, msk(4, 12))).status).toBe(403);
  });

  it(
    'исполнитель принимает кнопкой: новая версия с этим временем (T5), клиенту N4, клиент подтверждает версию 2',
    async () => {
      await h.start(SELLER, SELLER_CHAT);
      const id = await dealWithClient(msk(3, 12));
      await propose(id, CLIENT, msk(4, 18));
      const [p] = await proposals(id);
      h.max.reset();
      await h.press(SELLER, SELLER_CHAT, `tp:${id}:${p.id}`, null); // из уведомления N3T
      expect(await dealStatus(h, id)).toBe('awaiting_confirmation');
      const cur = await currentTime(id);
      expect(cur).toEqual({ scheduled_at: msk(4, 18), version: 2 });
      expect((await proposals(id))[0]).toMatchObject({ status: 'accepted', accepted_version: 2 });
      expect(h.max.texts().some((t) => t.includes(texts.TIME_ACCEPTED_ACK))).toBe(true);
      expect(h.max.inChat(CLIENT_CHAT).some((m) => m.text.includes('изменил условия') && m.text.includes('срок'))).toBe(true);
      // повторное нажатие — предложение уже неактуально, вторая версия не появляется
      await h.press(SELLER, SELLER_CHAT, `tp:${id}:${p.id}`, null);
      expect((await currentTime(id)).version).toBe(2);
      const ok = await h.api('POST', `/api/deals/${id}/actions`, CLIENT, { action: 'confirm', version: 2 });
      expect(ok.json.deal.status).toBe('scheduled');
    },
    TIMEOUT,
  );

  it(
    'гонка «два клиента на одно время»: первое принятие удерживает время, второе — «занято», клиенту — выбрать другое',
    async () => {
      await h.start(SELLER, SELLER_CHAT);
      const a = await dealWithClient(msk(3, 12), CLIENT, CLIENT_CHAT);
      const b = await dealWithClient(msk(3, 15), CLIENT2, CLIENT2_CHAT);
      expect((await propose(a, CLIENT, msk(5, 11))).status).toBe(200);
      expect((await propose(b, CLIENT2, msk(5, 11))).status).toBe(200); // пока никто не принял — оба могут предложить
      const [pa] = await proposals(a);
      const [pb] = await proposals(b);
      // оба принятия одновременно: блокировка исполнителя пропускает ровно одно
      const [ra, rb] = await Promise.all([
        h.api('POST', `/api/deals/${a}/actions`, SELLER, { action: 'accept_time', proposal_id: pa.id }),
        h.api('POST', `/api/deals/${b}/actions`, SELLER, { action: 'accept_time', proposal_id: pb.id }),
      ]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      const statuses = [(await proposals(a))[0].status, (await proposals(b))[0].status].sort();
      expect(statuses).toEqual(['accepted', 'taken']);
      const loser = (await proposals(a))[0].status === 'taken' ? { id: a, chat: CLIENT_CHAT, res: ra } : { id: b, chat: CLIENT2_CHAT, res: rb };
      expect(loser.res.json.notice).toBe(texts.TIME_TAKEN_SELLER);
      expect((await currentTime(loser.id)).version).toBe(1);
      const note = h.max.inChat(loser.chat).find((m) => m.text.includes('уже занято'));
      expect(note?.buttons.some((x) => x.type === 'open_app' && x.payload === `time_${loser.id}`)).toBe(true);
      // удержанное время занято и для новых предложений
      expect((await propose(loser.id, loser.id === a ? CLIENT : CLIENT2, msk(5, 11))).status).toBe(409);
    },
    TIMEOUT,
  );

  it('устаревшее предложение: после «Оставить как есть» принять нельзя; принять может только исполнитель', async () => {
    await h.start(SELLER, SELLER_CHAT);
    const id = await dealWithClient(msk(3, 12));
    await propose(id, CLIENT, msk(4, 18));
    const [p] = await proposals(id);
    expect((await h.api('POST', `/api/deals/${id}/actions`, CLIENT, { action: 'accept_time', proposal_id: p.id })).status).toBe(403);
    await h.api('POST', `/api/deals/${id}/actions`, SELLER, { action: 'keep_as_is' });
    expect((await proposals(id))[0].status).toBe('superseded');
    const stale = await h.api('POST', `/api/deals/${id}/actions`, SELLER, { action: 'accept_time', proposal_id: p.id });
    expect(stale.json.notice).toBe(texts.TIME_STALE);
    expect((await currentTime(id)).version).toBe(1);
  });

  it('«Предложить изменения» в чате: выбор «Другое время» (open_app time_<id>) или «Написать текстом» (прежний ввод)', async () => {
    await h.start(SELLER, SELLER_CHAT);
    const id = await dealWithClient(msk(3, 12));
    const clientCard = await cardMid(h, id, 'client');
    await h.press(CLIENT, CLIENT_CHAT, `cr:${id}`, clientCard);
    const card = h.max.byMid(clientCard)!;
    expect(card.text).toContain(texts.ASK_CHANGE_KIND);
    expect(card.buttons[0]).toMatchObject({ type: 'open_app', payload: `time_${id}` });
    expect(card.buttons[1].payload).toBe(`cr:t:${id}`);
    await h.press(CLIENT, CLIENT_CHAT, `cr:t:${id}`, clientCard);
    await h.say(CLIENT, CLIENT_CHAT, 'Давайте без предоплаты');
    expect(await dealStatus(h, id)).toBe('changes_requested');
  });
});
