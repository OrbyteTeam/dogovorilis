// «📝 Сделка-пример для клиента» (ЗАДАЧА_03 B, аудит 22.09 §3.2): настоящая сделка из чата, без мини-приложения.
// Проверяется то, ради чего она сделана: второй человек проходит по её ссылке, а кнопки шеринга видны.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { TRIAL_LIMIT_PER_HOUR } from '../src/domain/deal/service.js';
import { cardMid, createHarness, dealStatus, onlyDealPublicId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;

const SELLER = 3101;
const SELLER_CHAT = 7101;
const CLIENT = 3102;
const CLIENT_CHAT = 7102;

const TIMEOUT = 120_000;

describe.skipIf(!DB)('сделка-пример из чата', () => {
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

  it('кнопка есть в меню /start и в /new', async () => {
    await h.start(SELLER, SELLER_CHAT);
    await h.say(SELLER, SELLER_CHAT, '/new');
    const menus = h.max.inChat(SELLER_CHAT).filter((m) => m.buttons.some((b) => b.payload === 'ex:new'));
    expect(menus.map((m) => m.text)).toEqual(expect.arrayContaining([texts.S1, texts.NEW_DEAL_PROMPT]));
  }, TIMEOUT);

  it('создаёт настоящую сделку без клиента: ссылка и кнопки шеринга в карточке, меню остаётся', async () => {
    await h.start(SELLER, SELLER_CHAT);
    await h.press(SELLER, SELLER_CHAT, 'ex:new', null);
    const id = await onlyDealPublicId(h);

    const [deal] = await h.query<{ demo: boolean; client_user_id: number | null; status: string }>(
      'SELECT demo, client_user_id, status FROM deals WHERE public_id = $1',
      [id],
    );
    expect(deal).toEqual({ demo: false, client_user_id: null, status: 'awaiting_confirmation' });

    const answer = h.max.sent.find((m) => m.kind === 'answer')!;
    expect(answer.text).toBe(texts.EXAMPLE_CREATED(id));
    expect(answer.buttons.map((b) => b.payload)).toContain('ex:new'); // меню под ответом

    const card = h.max.byMid(await cardMid(h, id, 'seller'))!;
    expect(card.text).toContain(`start=d_${id}`);
    expect(card.buttons.map((b) => b.text)).toEqual(expect.arrayContaining([texts.BTN.sendToMax, texts.BTN.copyLink]));
  }, TIMEOUT);

  it('у отменённой сделки без клиента ссылки для клиента в карточке больше нет', async () => {
    await h.start(SELLER, SELLER_CHAT);
    await h.press(SELLER, SELLER_CHAT, 'ex:new', null);
    const id = await onlyDealPublicId(h);
    const sellerCard = await cardMid(h, id, 'seller');
    await h.press(SELLER, SELLER_CHAT, `cn:y:${id}:none`, sellerCard);
    expect(await dealStatus(h, id)).toBe('cancelled');
    expect(h.max.byMid(sellerCard)!.text).not.toContain('Ссылка для клиента');
  }, TIMEOUT);

  it('второй аккаунт проходит по ссылке сделки-примера и подтверждает', async () => {
    await h.start(SELLER, SELLER_CHAT);
    await h.press(SELLER, SELLER_CHAT, 'ex:new', null);
    const id = await onlyDealPublicId(h);

    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    expect(h.max.inChat(CLIENT_CHAT).map((m) => m.text).join('\n')).toContain('предлагает договорённость'); // S2
    expect(h.max.inChat(SELLER_CHAT).map((m) => m.text).join('\n')).toContain('открыл(а) карточку'); // N1

    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, await cardMid(h, id, 'client'));
    expect(await dealStatus(h, id)).toBe('awaiting_prepayment');
  }, TIMEOUT);

  it(`не больше ${TRIAL_LIMIT_PER_HOUR} сделок-примеров в час; демо считается отдельно`, async () => {
    await h.start(SELLER, SELLER_CHAT);
    for (let i = 0; i < TRIAL_LIMIT_PER_HOUR; i++) await h.press(SELLER, SELLER_CHAT, 'ex:new', null);
    h.max.reset();

    await h.press(SELLER, SELLER_CHAT, 'ex:new', null);
    const refused = h.max.sent.find((m) => m.kind === 'answer')!;
    expect(refused.text).toBe(texts.TOO_MANY_TRIALS);
    expect(refused.buttons.map((b) => b.payload)).toContain('ex:new'); // меню не пропало
    const [{ n }] = await h.query<{ n: number }>('SELECT count(*)::int AS n FROM deals');
    expect(n).toBe(TRIAL_LIMIT_PER_HOUR);

    // Демо — свой лимит: пять примеров его не съели
    await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
    const [{ demo }] = await h.query<{ demo: number }>('SELECT count(*)::int AS demo FROM deals WHERE demo');
    expect(demo).toBe(1);
  }, TIMEOUT);
});
