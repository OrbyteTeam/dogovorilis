// Ответ на кнопку карточки — всегда карточка (SPEC §6.4, аудит 22.09 §3.1).
//
// POST /answers в MAX ПРАВИТ сообщение, на кнопке которого нажали. Раньше ответ на «Перевести по реквизитам»
// был текстом с реквизитами, а сразу за ним syncCards перерисовывал ту же карточку выбором рейла — клиент
// реквизитов так и не видел. Поддельный MAX теперь моделирует правку по /answers, и эти тесты читают
// итоговое содержимое сообщения по его mid — то, что человек увидит на экране.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { cardMid, createHarness, dealStatus, livePaymentId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;

const SELLER = 2001;
const SELLER_CHAT = 6001;
const CLIENT = 2002;
const CLIENT_CHAT = 6002;
const PAYOUT = 'СБП +7 900 000-00-00, Т-Банк, получатель Анна А.';

const TIMEOUT = 120_000;

describe.skipIf(!DB)('ответ на кнопку карточки — карточкой', () => {
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

  /** Настоящая сделка двух людей: исполнитель создаёт через API мини-приложения, клиент входит по ссылке. */
  async function realDeal(): Promise<{ id: string; sellerCard: string; clientCard: string }> {
    await h.start(SELLER, SELLER_CHAT);
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'beauty',
      title: 'Маникюр с покрытием',
      total_rub: 2500,
      prepayment_rub: 500,
      scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      cancel_rule: 'free_24h',
      profile: {
        display_name: 'Анна Мастер',
        tax_mode: 'npd',
        payout_details: PAYOUT,
        transfer_enabled: true,
        link_enabled: false,
        default_cancel_rule: 'free_24h',
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const id = res.json.deal.public_id as string;
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    return { id, sellerCard: await cardMid(h, id, 'seller'), clientCard: await cardMid(h, id, 'client') };
  }

  /** Сколько раз после отметки `from` сообщение `mid` правили через PUT /messages. */
  function editsOf(mid: string, from: number): number {
    return h.max.sent.slice(from).filter((m) => m.kind === 'edit' && m.mid === mid).length;
  }

  const labels = (mid: string) => (h.max.byMid(mid)?.buttons ?? []).map((b) => b.text);

  it('«Перевести по реквизитам»: реквизиты и «Я перевёл(а)» остаются в карточке клиента', async () => {
    const { id, clientCard } = await realDeal();
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);

    const mark = h.max.sent.length;
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);

    const shown = h.max.byMid(clientCard)!;
    expect(shown.text).toContain(texts.esc(PAYOUT));
    expect(shown.text).toContain('Перевод продукт не видит');
    expect(labels(clientCard)).toContain(texts.BTN.transferDone);
    expect(labels(clientCard)).toContain(texts.BTN.transferCancel);
    expect(labels(clientCard)).not.toContain(texts.BTN.payByTransfer);
    // syncCards пропустил нажатую карточку: её не перезаписали поверх ответа
    expect(editsOf(clientCard, mark)).toBe(0);
  }, TIMEOUT);

  it('«Я перевёл(а)»: у исполнителя в карточке «Получил(а)» и «Не вижу перевода», у клиента — ожидание', async () => {
    const { id, sellerCard, clientCard } = await realDeal();
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const pid = await livePaymentId(h, id, 'prepayment');

    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);

    expect(h.max.byMid(clientCard)!.text).toContain('Вы сообщили о переводе');
    expect(labels(clientCard)).not.toContain(texts.BTN.transferDone);
    expect(labels(sellerCard)).toEqual(expect.arrayContaining([texts.BTN.transferReceived, texts.BTN.transferNotReceived]));
    expect(h.max.byMid(sellerCard)!.text).toContain('клиент сообщил о переводе');
    // P2 по-прежнему приходит отдельным сообщением — правка карточки не даёт push-уведомления
    expect(h.max.inChat(SELLER_CHAT).some((m) => m.kind === 'send' && m.text.includes('сообщает о переводе'))).toBe(true);

    // «Получил(а)» прямо из карточки двигает сделку
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, sellerCard);
    expect(await dealStatus(h, id)).toBe('scheduled');
    expect(labels(sellerCard)).toContain(texts.BTN.done);
  }, TIMEOUT);

  it('«Не вижу перевода» → клиент снова видит реквизиты; повтор раньше 10 минут — E13 над карточкой', async () => {
    const { id, sellerCard, clientCard } = await realDeal();
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const pid = await livePaymentId(h, id, 'prepayment');
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);

    await h.press(SELLER, SELLER_CHAT, `tr:n:${id}:${pid}`, sellerCard);
    expect(labels(sellerCard)).not.toContain(texts.BTN.transferReceived);
    expect(labels(clientCard)).toContain(texts.BTN.transferDone);
    expect(h.max.inChat(CLIENT_CHAT).some((m) => m.text.includes('пока не видит перевод'))).toBe(true); // P3

    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    const shown = h.max.byMid(clientCard)!;
    expect(shown.text.startsWith(texts.E13)).toBe(true);
    expect(labels(clientCard)).toContain(texts.BTN.transferDone); // кнопки не стёрты ошибкой
  }, TIMEOUT);

  it('«Отмена перевода» возвращает выбор способа оплаты', async () => {
    const { id, clientCard } = await realDeal();
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const pid = await livePaymentId(h, id, 'prepayment');

    await h.press(CLIENT, CLIENT_CHAT, `tr:x:${id}:${pid}`, clientCard);
    expect(labels(clientCard)).toContain(texts.BTN.payByTransfer);
    expect(h.max.byMid(clientCard)!.text).not.toContain(texts.esc(PAYOUT));
  }, TIMEOUT);

  it('ошибка на карточке (E7) — заметкой над карточкой, кнопки на месте', async () => {
    const { id, sellerCard, clientCard } = await realDeal();
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const pid = await livePaymentId(h, id, 'prepayment');
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, sellerCard);
    await h.press(SELLER, SELLER_CHAT, `dn:${id}`, sellerCard);

    await h.press(CLIENT, CLIENT_CHAT, `cn:y:${id}`, clientCard);
    expect(h.max.byMid(clientCard)!.text.startsWith(texts.E7)).toBe(true);
    expect(labels(clientCard)).toEqual(expect.arrayContaining([texts.BTN.accept, texts.BTN.remarks]));
  }, TIMEOUT);

  it('запрос ввода с карточки не стирает её: подсказка сверху, условия и кнопки на месте', async () => {
    const { id, clientCard } = await realDeal();
    await h.press(CLIENT, CLIENT_CHAT, `cr:${id}`, clientCard);
    const shown = h.max.byMid(clientCard)!;
    expect(shown.text.startsWith(texts.ASK_CHANGE_REQUEST)).toBe(true);
    expect(shown.text).toContain('Маникюр с покрытием');
    expect(labels(clientCard)).toContain(texts.BTN.confirm);
  }, TIMEOUT);

  it('«Отменить» → «Не отменять»: ожидание причины снято, следующий текст сделку не отменяет', async () => {
    const { id, sellerCard } = await realDeal();
    await h.press(SELLER, SELLER_CHAT, `cn:${id}`, sellerCard);
    expect(labels(sellerCard)).toEqual([texts.BTN.noReason, texts.BTN.keepDeal]);
    expect(h.max.byMid(sellerCard)!.text).toContain('Маникюр с покрытием'); // подтверждение — поверх карточки

    await h.press(SELLER, SELLER_CHAT, `op:${id}`, sellerCard);
    expect(labels(sellerCard)).toContain(texts.BTN.cancelDeal); // обычная карточка вернулась
    expect(await h.query('SELECT 1 FROM user_inputs')).toHaveLength(0);

    await h.say(SELLER, SELLER_CHAT, 'передумала, всё в силе');
    expect(await dealStatus(h, id)).toBe('awaiting_confirmation');
  }, TIMEOUT);

  it('«Открыть» в уведомлении: карточка приходит вниз чата, старая становится указателем', async () => {
    const { id, sellerCard } = await realDeal();
    const mark = h.max.sent.length;
    await h.press(SELLER, SELLER_CHAT, `op:${id}`, null); // кнопка в уведомлении N1, не в карточке

    const moved = await cardMid(h, id, 'seller');
    expect(moved).not.toBe(sellerCard);
    expect(h.max.sent.slice(mark).some((m) => m.kind === 'send' && m.mid === moved)).toBe(true);
    expect(h.max.byMid(sellerCard)!.text).toBe(texts.CARD_MOVED(id));
    expect(h.max.byMid(sellerCard)!.buttons).toHaveLength(0);
    // Сообщение-уведомление ответом не затёрто: /answers ушёл без message
    const answer = h.max.sent.slice(mark).find((m) => m.kind === 'answer');
    expect(answer?.text).toBe('');
  }, TIMEOUT);

  it('«Квитанция PDF» на карточке закрытой сделки: квитанция приходит, кнопка не пропадает', async () => {
    const { id, sellerCard } = await realDeal();
    await h.press(SELLER, SELLER_CHAT, `cn:y:${id}:none`, sellerCard);
    expect(await dealStatus(h, id)).toBe('cancelled');

    const mark = h.max.sent.length;
    await h.press(SELLER, SELLER_CHAT, `pdf:${id}`, sellerCard);
    expect(labels(sellerCard)).toEqual([texts.BTN.receiptPdf]);
    expect(h.max.sent.slice(mark).some((m) => m.attachmentTypes.includes('file'))).toBe(true);
  }, TIMEOUT);

  it('клиент открыл ссылку повторно: карточка одна, но показана внизу чата', async () => {
    const { id, clientCard } = await realDeal();
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const cards = await h.query<{ mid: string }>(
      "SELECT mid FROM card_messages WHERE role = 'client' AND deal_id = (SELECT id FROM deals WHERE public_id = $1)",
      [id],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].mid).not.toBe(clientCard);
    expect(h.max.byMid(clientCard)!.text).toBe(texts.CARD_MOVED(id));
  }, TIMEOUT);
});
