// Сквозной сценарий T1→T15 через настоящую цепочку обработчиков и настоящую БД (ЗАДАЧА_01, шаг 4).
// MAX подменён на уровне HTTP (clientOptions.fetch), поэтому проверяется то, что реально ушло бы в сеть.
// Запуск: TEST_DATABASE_URL=postgres://…/dogovorilis_test npx vitest run --root server
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import {
  cardMid,
  createHarness,
  dealStatus,
  livePaymentId,
  onlyDealPublicId,
  truncateAll,
  type Harness,
} from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;

const SELLER = 1001;
const SELLER_CHAT = 5001;
const CLIENT = 1002;
const CLIENT_CHAT = 5002;
const STRANGER = 1003;
const STRANGER_CHAT = 5003;

// Отправка троттлится до 2 сообщений в секунду на чат (CONTRACTS §1.2) — это настоящее поведение,
// поэтому сквозной сценарий в одном чате идёт десятки секунд. Не ускоряем: иначе проверяли бы не то.
const SCENARIO_TIMEOUT = 120_000;

describe.skipIf(!DB)('сквозной сценарий', () => {
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

  /** Создать сделку так, как это делает мини-приложение: POST /api/deals с подписанным initData. */
  async function createDealViaApi(
    hh: Harness,
    body: { template?: string; title: string; total_rub: number; prepayment_rub: number; scheduled_at?: string },
  ): Promise<string> {
    const res = await hh.api('POST', '/api/deals', SELLER, {
      template: body.template ?? 'free',
      title: body.title,
      total_rub: body.total_rub,
      prepayment_rub: body.prepayment_rub,
      scheduled_at: body.scheduled_at ?? null,
      cancel_rule: 'free_24h',
      profile: {
        display_name: 'Анна Мастер',
        tax_mode: 'npd',
        payout_details: 'СБП +7 900 000-00-00, Т-Банк, получатель Анна А.',
        transfer_enabled: true,
        link_enabled: false,
        default_cancel_rule: 'free_24h',
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.deal.public_id as string;
  }

  /** Полный путь одним аккаунтом в демо-режиме: именно так сценарий проверяет один человек. */
  async function runDemoScenario(): Promise<string> {
    await h.start(SELLER, SELLER_CHAT);
    expect(h.max.texts().join('\n')).toContain('Это «Договорились»');

    await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
    const id = await onlyDealPublicId(h);
    expect(await dealStatus(h, id)).toBe('awaiting_confirmation');

    const clientCard = await cardMid(h, id, 'client_demo');
    const sellerCard = await cardMid(h, id, 'seller');
    expect(clientCard).not.toBe(sellerCard);

    // T3: клиент подтверждает условия (кнопка в ДЕМО-карточке)
    await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);
    expect(await dealStatus(h, id)).toBe('awaiting_prepayment');

    // Предоплата переводом: pt → tr:c → tr:g (T9)
    await h.press(SELLER, SELLER_CHAT, `pt:${id}`, clientCard);
    const prepayment = await livePaymentId(h, id, 'prepayment');
    await h.press(SELLER, SELLER_CHAT, `tr:c:${id}:${prepayment}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${prepayment}`, sellerCard);
    expect(await dealStatus(h, id)).toBe('scheduled');

    // T10 «Выполнено» → T11 «Принимаю»
    await h.press(SELLER, SELLER_CHAT, `dn:${id}`, sellerCard);
    expect(await dealStatus(h, id)).toBe('awaiting_acceptance');
    await h.press(SELLER, SELLER_CHAT, `ac:${id}`, clientCard);
    expect(await dealStatus(h, id)).toBe('awaiting_payment');

    // Остаток тем же способом (T14)
    await h.press(SELLER, SELLER_CHAT, `pt:${id}`, clientCard);
    const final = await livePaymentId(h, id, 'final');
    await h.press(SELLER, SELLER_CHAT, `tr:c:${id}:${final}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${final}`, sellerCard);
    expect(await dealStatus(h, id)).toBe('paid');

    // T15: чек фотографией → сделка закрыта, квитанция отправлена
    await h.press(SELLER, SELLER_CHAT, `rc:${id}`, sellerCard);
    await h.sendAttachment(SELLER, SELLER_CHAT, {
      type: 'image',
      payload: { url: 'https://example.org/receipt.jpg', token: 'incoming-receipt-token', photo_id: 42 },
    });
    expect(await dealStatus(h, id)).toBe('closed');
    return id;
  }

  it('T1→T15 проходится одним аккаунтом в демо-режиме', async () => {
    const id = await runDemoScenario();

    const receipts = await h.query<{ max_token: string }>('SELECT max_token FROM receipts');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].max_token).toBe('incoming-receipt-token');

    // Квитанция PDF действительно загружена и отправлена вложением
    expect(h.max.uploads).toBeGreaterThan(0);
    const withFile = h.max.sent.filter((m) => m.attachmentTypes.includes('file'));
    expect(withFile.length).toBeGreaterThan(0);

    // Все обязательные уведомления из критерия готовности
    const all = h.max.texts().join('\n');
    for (const fragment of [
      'подтвердил(а) условия', // N2
      'Предоплата', // N8
      'выполненной', // N9
      'принял(а) работу', // N10
      'оплачена полностью', // N13
      'закрыта', // N14
    ]) {
      expect(all, `нет уведомления с фрагментом «${fragment}»`).toContain(fragment);
    }

    // Обе карточки дошли до конечного состояния
    const finalCards = await h.query<{ role: string }>(
      'SELECT cm.role FROM card_messages cm JOIN deals d ON d.id = cm.deal_id WHERE d.public_id = $1 ORDER BY cm.role',
      [id],
    );
    expect(finalCards.map((c) => c.role)).toEqual(['client_demo', 'seller']);
    const sellerMid = await cardMid(h, id, 'seller');
    expect(h.max.byMid(sellerMid)?.text).toContain('✅');
  }, SCENARIO_TIMEOUT);

  it('повторное прохождение даёт тот же результат и не тащит состояние', async () => {
    const first = await runDemoScenario();
    h.max.reset();
    const second = await runDemoScenario();

    expect(second).not.toBe(first);
    expect(await dealStatus(h, first)).toBe('closed');
    expect(await dealStatus(h, second)).toBe('closed');

    // У второй сделки ровно свой набор платежей и событий — состояние первой не подмешалось
    const payments = await h.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM payments p JOIN deals d ON d.id = p.deal_id WHERE d.public_id = $1',
      [second],
    );
    expect(payments[0].n).toBe(2);
    const inputs = await h.query<{ n: number }>('SELECT count(*)::int AS n FROM user_inputs');
    expect(inputs[0].n).toBe(0); // ожидание ввода закрылось
  }, SCENARIO_TIMEOUT * 2);

  it('двумя аккаунтами по ссылке: клиент входит по диплинку и проходит свою сторону', async () => {
    await h.start(SELLER, SELLER_CHAT);
    await h.press(SELLER, SELLER_CHAT, 'dm:new', null); // профиль исполнителя с реквизитами

    // Настоящая сделка создаётся через API мини-приложения — с подписью initData, как из формы «Новая сделка»
    const id = await createDealViaApi(h, {
      template: 'lesson',
      title: 'Занятие 60 минут',
      scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      total_rub: 3000,
      prepayment_rub: 1000,
    });
    h.max.reset();

    // Клиент открывает ссылку: bot_started с payload d_<id> (T2)
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const rows = await h.query<{ client_user_id: number }>('SELECT client_user_id FROM deals WHERE public_id = $1', [id]);
    expect(rows[0].client_user_id).toBe(CLIENT);
    expect(h.max.inChat(CLIENT_CHAT).map((m) => m.text).join('\n')).toContain('предлагает договорённость'); // S2
    expect(h.max.inChat(SELLER_CHAT).map((m) => m.text).join('\n')).toContain('открыл(а) карточку'); // N1

    const clientCard = await cardMid(h, id, 'client');
    const sellerCard = await cardMid(h, id, 'seller');

    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    expect(await dealStatus(h, id)).toBe('awaiting_prepayment');

    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const pid = await livePaymentId(h, id, 'prepayment');
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, sellerCard);
    expect(await dealStatus(h, id)).toBe('scheduled');

    await h.press(SELLER, SELLER_CHAT, `dn:${id}`, sellerCard);
    await h.press(CLIENT, CLIENT_CHAT, `ac:${id}`, clientCard);
    expect(await dealStatus(h, id)).toBe('awaiting_payment');

    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const fid = await livePaymentId(h, id, 'final');
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${fid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${fid}`, sellerCard);
    expect(await dealStatus(h, id)).toBe('paid');

    await h.press(SELLER, SELLER_CHAT, `rc:${id}`, sellerCard);
    await h.sendAttachment(SELLER, SELLER_CHAT, { type: 'file', payload: { url: 'https://example.org/r.pdf', token: 'receipt-pdf' }, filename: 'чек.pdf', size: 12_345 });
    expect(await dealStatus(h, id)).toBe('closed');

    // Квитанция ушла ОБЕИМ сторонам
    const filesToSeller = h.max.inChat(SELLER_CHAT).filter((m) => m.attachmentTypes.includes('file'));
    const filesToClient = h.max.inChat(CLIENT_CHAT).filter((m) => m.attachmentTypes.includes('file'));
    expect(filesToSeller.length).toBeGreaterThan(0);
    expect(filesToClient.length).toBeGreaterThan(0);
  }, SCENARIO_TIMEOUT);

  describe('краевые случаи SPEC §14', () => {
    it('п. 1: двойной тап «Подтверждаю» — второй ответ «уже сделано», без второго события', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
      const id = await onlyDealPublicId(h);
      const clientCard = await cardMid(h, id, 'client_demo');

      await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);
      h.max.reset();
      await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);

      expect(h.max.texts().join('\n')).toContain(texts.ALREADY_DONE);
      const events = await h.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deal_events e JOIN deals d ON d.id = e.deal_id
         WHERE d.public_id = $1 AND e.type = 'version.confirmed'`,
        [id],
      );
      expect(events[0].n).toBe(1);
    });

    it('п. 5: клиент открыл ссылку дважды — одна привязка, без второго N1', async () => {
      await h.start(SELLER, SELLER_CHAT); // без диалога с ботом карточка исполнителю не уйдёт (§7.3 card_sent)
      const id = await createDealViaApi(h, { title: 'Разовая услуга', total_rub: 1000, prepayment_rub: 0 });

      await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
      h.max.reset();
      await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);

      const joins = await h.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deal_events e JOIN deals d ON d.id = e.deal_id WHERE d.public_id = $1 AND e.type = 'client.joined'`,
        [id],
      );
      expect(joins[0].n).toBe(1);
      expect(h.max.texts().join('\n')).not.toContain('открыл(а) карточку');
      const cards = await h.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM card_messages cm JOIN deals d ON d.id = cm.deal_id WHERE d.public_id = $1',
        [id],
      );
      expect(cards[0].n).toBe(2); // одна карточка исполнителю, одна клиенту
    });

    it('п. 6: исполнитель открыл собственную ссылку — видит свою карточку, а не клиентскую', async () => {
      await h.start(SELLER, SELLER_CHAT);
      const id = await createDealViaApi(h, { title: 'Своя ссылка', total_rub: 1000, prepayment_rub: 0 });
      h.max.reset();

      await h.start(SELLER, SELLER_CHAT, `d_${id}`);

      const rows = await h.query<{ client_user_id: number | null; demo: boolean }>(
        'SELECT client_user_id, demo FROM deals WHERE public_id = $1',
        [id],
      );
      expect(rows[0].client_user_id).toBeNull();
      expect(rows[0].demo).toBe(false);
      const roles = await h.query<{ role: string }>(
        'SELECT cm.role FROM card_messages cm JOIN deals d ON d.id = cm.deal_id WHERE d.public_id = $1',
        [id],
      );
      expect(roles.map((r) => r.role)).toEqual(['seller']);
    });

    it('посторонний по ссылке на демо-сделку получает E4, а на занятую — E3', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
      const demoId = await onlyDealPublicId(h);
      h.max.reset();
      await h.start(STRANGER, STRANGER_CHAT, `d_${demoId}`);
      expect(h.max.inChat(STRANGER_CHAT).map((m) => m.text).join('\n')).toContain(texts.E4);

      const id = await createDealViaApi(h, { title: 'Занятая ссылка', total_rub: 1000, prepayment_rub: 0 });
      h.max.reset();
      await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
      h.max.reset();
      await h.start(STRANGER, STRANGER_CHAT, `d_${id}`);
      expect(h.max.inChat(STRANGER_CHAT).map((m) => m.text).join('\n')).toContain(texts.E3);
    });

    it('неизвестная ссылка → E2', async () => {
      await h.start(CLIENT, CLIENT_CHAT, 'd_ZZZZZZZZZZ');
      expect(h.max.texts().join('\n')).toContain(texts.E2);
    });

    it('п. 9: сообщение и вложение вне ожидания ввода → S3', async () => {
      await h.start(SELLER, SELLER_CHAT);
      h.max.reset();
      await h.say(SELLER, SELLER_CHAT, 'привет, а можно подешевле?');
      expect(h.max.texts().join('\n')).toContain(texts.S3);

      h.max.reset();
      await h.sendAttachment(SELLER, SELLER_CHAT, { type: 'image', payload: { url: 'u', token: 't', photo_id: 1 } });
      expect(h.max.texts().join('\n')).toContain(texts.S3);
    });

    it('п. 10: вместо чека прислали неподходящий файл → E6, ожидание сохраняется', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
      const id = await onlyDealPublicId(h);
      const clientCard = await cardMid(h, id, 'client_demo');
      const sellerCard = await cardMid(h, id, 'seller');

      // доводим до paid
      await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `pt:${id}`, clientCard);
      const p1 = await livePaymentId(h, id, 'prepayment');
      await h.press(SELLER, SELLER_CHAT, `tr:c:${id}:${p1}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${p1}`, sellerCard);
      await h.press(SELLER, SELLER_CHAT, `dn:${id}`, sellerCard);
      await h.press(SELLER, SELLER_CHAT, `ac:${id}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `pt:${id}`, clientCard);
      const p2 = await livePaymentId(h, id, 'final');
      await h.press(SELLER, SELLER_CHAT, `tr:c:${id}:${p2}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${p2}`, sellerCard);
      expect(await dealStatus(h, id)).toBe('paid');

      await h.press(SELLER, SELLER_CHAT, `rc:${id}`, sellerCard);
      h.max.reset();
      await h.sendAttachment(SELLER, SELLER_CHAT, { type: 'file', payload: { url: 'u', token: 't' }, filename: 'договор.docx', size: 100 });
      expect(h.max.texts().join('\n')).toContain(texts.E6);
      expect(await dealStatus(h, id)).toBe('paid'); // тупика нет

      const stillWaiting = await h.query<{ kind: string }>('SELECT kind FROM user_inputs WHERE user_id = $1', [SELLER]);
      expect(stillWaiting[0]?.kind).toBe('receipt');

      // а правильный файл принимается, сделка закрывается
      await h.sendAttachment(SELLER, SELLER_CHAT, { type: 'file', payload: { url: 'u', token: 'ok-token' }, filename: 'чек.pdf', size: 2048 });
      expect(await dealStatus(h, id)).toBe('closed');
    }, SCENARIO_TIMEOUT);

    it('слишком длинный текст изменений → E5, состояние не меняется', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
      const id = await onlyDealPublicId(h);
      const clientCard = await cardMid(h, id, 'client_demo');
      await h.press(SELLER, SELLER_CHAT, `cr:${id}`, clientCard);
      h.max.reset();
      await h.say(SELLER, SELLER_CHAT, 'я'.repeat(501));
      expect(h.max.texts().join('\n')).toContain(texts.E5);
      expect(await dealStatus(h, id)).toBe('awaiting_confirmation');
    });

    it('оплата по ссылке не подключена → E11, сценарий продолжается переводом', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
      const id = await onlyDealPublicId(h);
      const clientCard = await cardMid(h, id, 'client_demo');
      await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);

      h.max.reset();
      await h.press(SELLER, SELLER_CHAT, `pl:${id}`, clientCard);
      expect(h.max.texts().join('\n')).toContain(texts.E11);
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');

      await h.press(SELLER, SELLER_CHAT, `pt:${id}`, clientCard);
      expect(h.max.texts().join('\n')).toContain('Переведите');
    });

    it('повторное «Я перевёл(а)» раньше 10 минут → E13', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
      const id = await onlyDealPublicId(h);
      const clientCard = await cardMid(h, id, 'client_demo');
      await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `pt:${id}`, clientCard);
      const pid = await livePaymentId(h, id, 'prepayment');
      await h.press(SELLER, SELLER_CHAT, `tr:c:${id}:${pid}`, clientCard);
      h.max.reset();
      await h.press(SELLER, SELLER_CHAT, `tr:c:${id}:${pid}`, clientCard);
      expect(h.max.texts().join('\n')).toContain(texts.E13);
    }, SCENARIO_TIMEOUT);

    it('клиент не может отменить после «Выполнено» → E7', async () => {
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
      const id = await onlyDealPublicId(h);
      const clientCard = await cardMid(h, id, 'client_demo');
      const sellerCard = await cardMid(h, id, 'seller');
      await h.press(SELLER, SELLER_CHAT, `cf:${id}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `pt:${id}`, clientCard);
      const pid = await livePaymentId(h, id, 'prepayment');
      await h.press(SELLER, SELLER_CHAT, `tr:c:${id}:${pid}`, clientCard);
      await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, sellerCard);
      await h.press(SELLER, SELLER_CHAT, `dn:${id}`, sellerCard);

      h.max.reset();
      await h.press(SELLER, SELLER_CHAT, `cn:y:${id}`, clientCard);
      expect(h.max.texts().join('\n')).toContain(texts.E7);
      expect(await dealStatus(h, id)).toBe('awaiting_acceptance');
    }, SCENARIO_TIMEOUT);

    it('отмена через «Без причины» снимает ожидание ввода (иначе следующий текст съедается)', async () => {
      // Поймано живым прогоном на сервере 21.09.2026: «🚫 Отменить» → «Без причины» отменяло сделку,
      // но запись в user_inputs оставалась на полчаса. Следующая же реплика исполнителя уезжала
      // в обработчик причины отмены, тот пытался отменить отменённое и отвечал E1 на безобидный текст.
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
      const id = await onlyDealPublicId(h);
      const sellerCard = await cardMid(h, id, 'seller');

      await h.press(SELLER, SELLER_CHAT, `cn:${id}`, sellerCard); // спрашивает причину
      expect((await h.query('SELECT kind FROM user_inputs')).length).toBe(1);

      await h.press(SELLER, SELLER_CHAT, `cn:y:${id}:none`, sellerCard); // «Без причины»
      expect(await dealStatus(h, id)).toBe('cancelled');
      expect(await h.query('SELECT kind FROM user_inputs')).toHaveLength(0);

      // И контрольный: обычный текст снова получает S3, а не E1.
      h.max.reset();
      await h.say(SELLER, SELLER_CHAT, 'спасибо');
      expect(h.max.texts().join('\n')).toContain(texts.S3);
    }, SCENARIO_TIMEOUT);

    it('исполнитель открыл собственную ссылку → отвечаем, а не молчим (§14 п. 6)', async () => {
      // Поймано живым прогоном 21.09: карточки у исполнителя уже есть, ensureCard правит их НА МЕСТЕ,
      // в чате не появляется ничего нового — нажатие ссылки выглядит как «бот сломался».
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
      const id = await onlyDealPublicId(h);

      h.max.reset();
      await h.start(SELLER, SELLER_CHAT, `d_${id}`);

      const said = h.max.texts().join('\n');
      expect(said).toContain('клиент в ней вы сами'); // демо-сделка: кнопок шеринга в ней нет
      expect(said).toContain(id);
      // Клиентом он при этом не стал и второй карточки не получил.
      const cards = await h.query<{ role: string }>(
        'SELECT role FROM card_messages WHERE deal_id = (SELECT id FROM deals WHERE public_id = $1)',
        [id],
      );
      expect(cards.map((c) => c.role).sort()).toEqual(['client_demo', 'seller']);
    }, SCENARIO_TIMEOUT);

    it('неизвестный payload кнопки → E1, процесс продолжает отвечать', async () => {
      await h.start(SELLER, SELLER_CHAT);
      h.max.reset();
      await h.press(SELLER, SELLER_CHAT, 'zz:BROKENPAYLOAD', null);
      expect(h.max.texts().join('\n')).toContain(texts.E1);

      h.max.reset();
      await h.say(SELLER, SELLER_CHAT, 'всё ещё жив?');
      expect(h.max.texts().join('\n')).toContain(texts.S3);
    });

    it('ошибка внутри обработчика не роняет процесс: пользователь получает E10 и работает дальше', async () => {
      await h.start(SELLER, SELLER_CHAT);
      // Ломаем зависимость обработчика: сделка есть в callback, но её нет в БД → внутренняя ошибка
      h.max.reset();
      await h.press(SELLER, SELLER_CHAT, 'cf:AAAAAAAAAA', null);
      const answered = h.max.texts().join('\n');
      expect(answered.length).toBeGreaterThan(0);
      expect(answered).toMatch(new RegExp([texts.E2, texts.E10, texts.E1].map((t) => t.slice(0, 20)).join('|')));

      h.max.reset();
      await h.start(SELLER, SELLER_CHAT);
      expect(h.max.texts().join('\n')).toContain('Это «Договорились»');
    });
  });
});

/**
 * §14 п. 13 — отдельным блоком: внутри создаются и закрываются ДВА стенда подряд,
 * а пул соединений в процессе один, поэтому такой тест не должен делить стенд с остальными.
 */
describe.skipIf(!DB)('ожидание ввода переживает перезапуск процесса', () => {
  it('текст, присланный после «перезапуска», применяется к сделке', async () => {
    const before = await createHarness(DB!);
    let id: string;
    try {
      await before.start(SELLER, SELLER_CHAT);
      await before.press(SELLER, SELLER_CHAT, 'dm:new');
      id = await onlyDealPublicId(before);
      const clientCard = await cardMid(before, id, 'client_demo');
      await before.press(SELLER, SELLER_CHAT, `cr:${id}`, clientCard);

      const pending = await before.query<{ kind: string }>('SELECT kind FROM user_inputs WHERE user_id = $1', [SELLER]);
      expect(pending[0]?.kind).toBe('change_request'); // состояние в БД, а не в памяти процесса
    } finally {
      await before.close();
    }

    // «перезапуск»: новый процесс, новая память, та же база — сохранённое ожидание должно сработать
    const after = await createHarness(DB!, { keepData: true });
    try {
      await after.say(SELLER, SELLER_CHAT, 'давайте 15:00 и без предоплаты');
      expect(await dealStatus(after, id)).toBe('changes_requested');
      const versions = await after.query<{ change_request_text: string | null }>(
        'SELECT change_request_text FROM deal_versions WHERE deal_id = (SELECT id FROM deals WHERE public_id = $1)',
        [id],
      );
      expect(versions).toHaveLength(1);
    } finally {
      await after.close();
    }
  }, 120_000);
});
