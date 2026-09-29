// Спор «я перевёл / не вижу перевода» (аудит 22.09 §4.3, ЗАДАЧА_03 H2).
// Продукт не арбитр: каждая отметка сторон записывается с временем и попадает в квитанцию,
// а после двух «не вижу» подряд клиенту предлагается оплата по ссылке и честный текст про спор.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { transferHistory } from '../src/domain/payment/service.js';
import { getBundle } from '../src/domain/deal/service.js';
import { renderReceiptPdf } from '../src/domain/receipt/pdf.js';
import { buildReceiptData } from '../src/transport/bot/receipt.js';
import { cardMid, createHarness, livePaymentId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;

const SELLER = 4101;
const SELLER_CHAT = 8101;
const CLIENT = 4102;
const CLIENT_CHAT = 8102;

const TIMEOUT = 120_000;

describe.skipIf(!DB)('спор по переводу', () => {
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

  /** Пауза перед повторным «Я перевёл(а)» — 10 минут; в тесте сдвигаем прошлую отметку назад, а не ждём. */
  async function skipClaimCooldown(paymentId: number): Promise<void> {
    await h.query(`UPDATE payments SET claimed_at = claimed_at - interval '11 minutes' WHERE id = $1`, [paymentId]);
  }

  async function dealAwaitingPrepayment(): Promise<{ id: string; sellerCard: string; clientCard: string; pid: number }> {
    await h.start(SELLER, SELLER_CHAT);
    await h.press(SELLER, SELLER_CHAT, 'ex:new', null); // сделка-пример: реквизиты-пример в профиле
    const [{ public_id: id }] = await h.query<{ public_id: string }>('SELECT public_id FROM deals');
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const clientCard = await cardMid(h, id, 'client');
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    return { id, sellerCard: await cardMid(h, id, 'seller'), clientCard, pid: await livePaymentId(h, id, 'prepayment') };
  }

  it('первое «не вижу» — обычная подсказка, второе подряд — «продукт не арбитр»', async () => {
    const { id, sellerCard, clientCard, pid } = await dealAwaitingPrepayment();

    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:n:${id}:${pid}`, sellerCard);
    const first = h.max.inChat(CLIENT_CHAT).filter((m) => m.kind === 'send').at(-1)!;
    expect(first.text).toBe(texts.P3({ id, sumKopecks: 50_000 }));

    await skipClaimCooldown(pid);
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:n:${id}:${pid}`, sellerCard);
    const second = h.max.inChat(CLIENT_CHAT).filter((m) => m.kind === 'send').at(-1)!;
    // Провайдер в стенде не подключён — ссылку не предлагаем, но про спор говорим честно
    expect(second.text).toBe(texts.P3_DISPUTE({ id, sumKopecks: 50_000, linkAvailable: false }));
    expect(second.buttons.map((b) => b.text)).toEqual([texts.BTN.transferDone]);
  }, TIMEOUT);

  it('хронология «перевёл / не вижу / получил» уходит в квитанцию', async () => {
    const { id, sellerCard, clientCard, pid } = await dealAwaitingPrepayment();
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:n:${id}:${pid}`, sellerCard);
    await skipClaimCooldown(pid);
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, sellerCard);

    const bundle = await getBundle(id);
    const history = await transferHistory(bundle.deal.id);
    expect(history.map((s) => s.step)).toEqual(['claimed', 'not_received', 'claimed', 'received']);
    expect(history.every((s) => s.kind === 'prepayment' && s.amountKopecks === 50_000)).toBe(true);

    const data = buildReceiptData(bundle, new Date(), history);
    expect(data.transferLog).toHaveLength(4);
    const dir = await mkdtemp(path.join(tmpdir(), 'dg-test-'));
    try {
      const out = path.join(dir, 'k.pdf');
      await renderReceiptPdf(data, out);
      expect((await stat(out)).size).toBeGreaterThan(5_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
