// Возврат предоплаты после отмены (SPEC §5.3 «Возвраты», ЗАДАЧА_03 H1, аудит 22.09 §4.2).
// Продукт деньги не возвращает — он фиксирует обязательство (по правилу отмены) и факт: «Вернул(а)» у исполнителя,
// «Возврат получил(а)» у клиента. Статус сделки остаётся cancelled; через 48 ч без отметки — напоминание исполнителю.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { tick } from '../src/scheduler/index.js';
import { cardMid, createHarness, dealStatus, livePaymentId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;

const SELLER = 5101;
const SELLER_CHAT = 9101;
const CLIENT = 5102;
const CLIENT_CHAT = 9102;
const STRANGER = 5103;
const STRANGER_CHAT = 9103;

const TIMEOUT = 120_000;

describe.skipIf(!DB)('возврат после отмены', () => {
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

  const labels = (mid: string) => (h.max.byMid(mid)?.buttons ?? []).map((b) => b.text);

  /** Сделка-пример → клиент вошёл, подтвердил, перевёл предоплату, исполнитель получил → исполнитель отменил. */
  async function cancelledAfterPrepayment(): Promise<{ id: string; sellerCard: string; clientCard: string }> {
    await h.start(SELLER, SELLER_CHAT);
    await h.press(SELLER, SELLER_CHAT, 'ex:new', null);
    const [{ public_id: id }] = await h.query<{ public_id: string }>('SELECT public_id FROM deals');
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const sellerCard = await cardMid(h, id, 'seller');
    const clientCard = await cardMid(h, id, 'client');
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const pid = await livePaymentId(h, id, 'prepayment');
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, sellerCard);
    await h.press(SELLER, SELLER_CHAT, `cn:y:${id}:none`, sellerCard);
    expect(await dealStatus(h, id)).toBe('cancelled');
    return { id, sellerCard, clientCard };
  }

  it('обе стороны отмечают свой шаг: кнопки, строка в карточке, уведомления', async () => {
    const { id, sellerCard, clientCard } = await cancelledAfterPrepayment();
    expect(labels(sellerCard)).toEqual([texts.BTN.refundSent, texts.BTN.receiptPdf, texts.BTN.repeat]);
    expect(labels(clientCard)).toEqual([texts.BTN.refundReceived, texts.BTN.receiptPdf]);
    expect(h.max.byMid(clientCard)!.text).toContain('ожидается возврат');

    await h.press(SELLER, SELLER_CHAT, `rf:s:${id}`, sellerCard);
    expect(labels(sellerCard)).toEqual([texts.BTN.receiptPdf, texts.BTN.repeat]);
    expect(h.max.byMid(sellerCard)!.text).toContain('Исполнитель вернул 500');
    expect(h.max.inChat(CLIENT_CHAT).some((m) => m.text === texts.REFUND_SENT_NOTICE({ id, sumKopecks: 50_000 }))).toBe(true);

    await h.press(CLIENT, CLIENT_CHAT, `rf:c:${id}`, clientCard);
    expect(labels(clientCard)).toEqual([texts.BTN.receiptPdf]);
    expect(h.max.byMid(clientCard)!.text).toContain('получен клиентом');
    expect(h.max.inChat(SELLER_CHAT).some((m) => m.text.includes('подтвердил(а) возврат'))).toBe(true);

    const [deal] = await h.query<{ status: string; refund_sent_at: Date | null; refund_received_at: Date | null }>(
      'SELECT status, refund_sent_at, refund_received_at FROM deals WHERE public_id = $1',
      [id],
    );
    expect(deal.status).toBe('cancelled'); // машина состояний не менялась
    expect(deal.refund_sent_at).not.toBeNull();
    expect(deal.refund_received_at).not.toBeNull();
    const events = await h.query<{ payload: { by: string } }>(
      "SELECT payload FROM deal_events WHERE type = 'refund.confirmed' ORDER BY seq",
    );
    expect(events.map((e) => e.payload.by)).toEqual(['seller', 'client']);

    // Повтор — «уже сделано», второго события нет
    await h.press(CLIENT, CLIENT_CHAT, `rf:c:${id}`, clientCard);
    expect(h.max.byMid(clientCard)!.text.startsWith(texts.ALREADY_DONE)).toBe(true);
    expect(await h.query("SELECT 1 FROM deal_events WHERE type = 'refund.confirmed'")).toHaveLength(2);
  }, TIMEOUT);

  it('через 48 ч без «Вернул(а)» исполнителю приходит напоминание; после отметки — не приходит', async () => {
    const { id, sellerCard } = await cancelledAfterPrepayment();
    const [r] = await h.query<{ due_at: Date; status: string }>(
      "SELECT due_at, status FROM reminders WHERE kind = 'refund_due'",
    );
    expect(r.status).toBe('pending');
    const [{ cancelled_at }] = await h.query<{ cancelled_at: Date }>('SELECT cancelled_at FROM deals WHERE public_id = $1', [id]);
    expect(r.due_at.getTime() - cancelled_at.getTime()).toBe(48 * 3_600_000);

    await tick({ max: h.gateway, sendReminders: true }, new Date(r.due_at.getTime() + 1000));
    expect(h.max.inChat(SELLER_CHAT).some((m) => m.text.includes('возврат') && m.text.includes('не отмечен'))).toBe(true);

    // Второй сценарий на той же сделке: отметка «Вернул(а)» гасит будущие напоминания
    await h.press(SELLER, SELLER_CHAT, `rf:s:${id}`, sellerCard);
    expect(await h.query("SELECT 1 FROM reminders WHERE kind = 'refund_due' AND status = 'pending'")).toHaveLength(0);
  }, TIMEOUT);

  it('посторонний отметить возврат не может', async () => {
    const { id } = await cancelledAfterPrepayment();
    await h.start(STRANGER, STRANGER_CHAT);
    await h.press(STRANGER, STRANGER_CHAT, `rf:s:${id}`, null);
    const [deal] = await h.query<{ refund_sent_at: Date | null }>('SELECT refund_sent_at FROM deals WHERE public_id = $1', [id]);
    expect(deal.refund_sent_at).toBeNull();
    const answers = h.max.sent.filter((m) => m.kind === 'answer').map((m) => m.text);
    expect(answers.at(-1)).toContain('не ваша');
  }, TIMEOUT);
});
