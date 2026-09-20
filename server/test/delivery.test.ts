// Доставка: троттлинг 2 сообщения/с на чат и обновление карточек НА МЕСТЕ у обеих сторон.
// Это те свойства, которые жюри видит глазами: карточка не дублируется, а меняется (SPEC §19, §14 п. 15).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cardMid, createHarness, livePaymentId, onlyDealPublicId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const SELLER = 2001;
const SELLER_CHAT = 6001;
const CLIENT = 2002;
const CLIENT_CHAT = 6002;

describe.skipIf(!DB)('доставка сообщений', () => {
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

  it('карточки обеих сторон обновляются правкой на месте, а не новыми сообщениями', async () => {
    await h.start(SELLER, SELLER_CHAT);
    const id = await createDeal(h);
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const clientCard = await cardMid(h, id, 'client');
    const sellerCard = await cardMid(h, id, 'seller');

    h.max.reset();
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);

    // Карточка исполнителя изменена правкой (PUT /messages), новой карточки ему не отправляли
    const edits = h.max.sent.filter((m) => m.kind === 'edit');
    expect(edits.map((e) => e.mid)).toContain(sellerCard);

    // Карточка клиента обновлена ответом на нажатие (POST /answers) — то же сообщение
    expect(h.max.sent.some((m) => m.kind === 'answer')).toBe(true);

    // mid карточек не изменились: сообщения те же
    expect(await cardMid(h, id, 'seller')).toBe(sellerCard);
    expect(await cardMid(h, id, 'client')).toBe(clientCard);

    // Текст карточки исполнителя теперь отражает новый статус
    expect(h.max.byMid(sellerCard)?.text).toContain('предоплат');
  }, 60_000);

  it('если карточка удалена, вместо правки уходит новая и mid обновляется (§14 п. 4)', async () => {
    await h.start(SELLER, SELLER_CHAT);
    const id = await createDeal(h);
    const sellerCard = await cardMid(h, id, 'seller');

    // Подменяем mid на несуществующий — так ведёт себя удалённое пользователем сообщение
    await h.query('UPDATE card_messages SET mid = $1 WHERE mid = $2', ['deleted-mid', sellerCard]);
    h.max.reset();

    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`); // событие, которое обновляет карточку исполнителя
    const midNow = await cardMid(h, id, 'seller');
    expect(midNow).not.toBe('deleted-mid');
    expect(h.max.sent.some((m) => m.kind === 'send' && m.mid === midNow)).toBe(true);
  }, 60_000);

  it('в один чат уходит не чаще 2 сообщений в секунду, разные чаты не ждут друг друга', async () => {
    await h.start(SELLER, SELLER_CHAT);
    const id = await createDeal(h);
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const clientCard = await cardMid(h, id, 'client');
    const sellerCard = await cardMid(h, id, 'seller');

    h.max.reset();
    const started = Date.now();
    // Один переход рассылает: ответ клиенту, правку карточки исполнителя и уведомление N2 исполнителю
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const pid = await livePaymentId(h, id, 'prepayment');
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, sellerCard);
    const elapsed = Date.now() - started;

    const toSeller = h.max.sent.filter((m) => m.chatId === SELLER_CHAT && m.kind === 'send');
    expect(toSeller.length).toBeGreaterThanOrEqual(2);
    // На N сообщений в один чат нужно минимум (N-1) × 500 мс
    expect(elapsed).toBeGreaterThanOrEqual((toSeller.length - 1) * 500);
    // При этом весь обмен уложился в разумное время — очередь не последовательна по всем чатам сразу
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);

  it('уведомление не уходит тому, кто не открывал бота: событие reminder.skipped, сделка живёт', async () => {
    await h.start(SELLER, SELLER_CHAT);
    const id = await createDeal(h);
    // Клиент вошёл по ссылке, затем остановил бота — писать ему больше некуда
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    await h.feed({ update_type: 'bot_stopped', timestamp: Date.now(), chat_id: CLIENT_CHAT, user: { user_id: CLIENT, name: 'c', first_name: 'c', username: null, is_bot: false, last_activity_time: 1 } } as never);
    h.max.reset();

    const sellerCard = await cardMid(h, id, 'seller');
    await h.press(SELLER, SELLER_CHAT, `cn:y:${id}`, sellerCard); // отмена → N15 клиенту

    // Новых сообщений клиенту нет: бот не может писать в закрытый диалог (MAX_API §1 п. 5).
    // Правка уже существующей карточки — не «первое сообщение», её мы не запрещаем.
    expect(h.max.sent.some((m) => m.chatId === CLIENT_CHAT && m.kind === 'send')).toBe(false);
    const skipped = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM deal_events e JOIN deals d ON d.id = e.deal_id
       WHERE d.public_id = $1 AND e.type = 'reminder.skipped'`,
      [id],
    );
    expect(skipped[0].n).toBeGreaterThan(0);
    const status = await h.query<{ status: string }>('SELECT status FROM deals WHERE public_id = $1', [id]);
    expect(status[0].status).toBe('cancelled');
  }, 60_000);
});

async function createDeal(h: Harness): Promise<string> {
  const res = await h.api('POST', '/api/deals', SELLER, {
    template: 'beauty',
    title: 'Маникюр с покрытием',
    total_rub: 2500,
    prepayment_rub: 500,
    scheduled_at: null,
    cancel_rule: 'free_24h',
    profile: {
      display_name: 'Анна Мастер',
      tax_mode: 'npd',
      payout_details: 'СБП +7 900 000-00-00',
      transfer_enabled: true,
      link_enabled: false,
      default_cancel_rule: 'free_24h',
    },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await onlyDealPublicId(h);
  return res.json.deal.public_id as string;
}
