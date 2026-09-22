// Безопасность на живой БД (ЗАДАЧА_03 G1, G5):
//   - посторонний, нажавший кнопку чужой сделки (пересланная карточка, подобранный payload), получает только
//     «Это не ваша сделка» — ни карточки, ни строки card_messages, ни сообщений в свой чат, ни действия;
//   - «Проверить оплату» принимает только платёж своей сделки;
//   - тело чужой или битой доставки вебхука в webhook_log целиком не хранится.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { cardMid, createHarness, dealStatus, livePaymentId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;

const SELLER = 5001;
const SELLER_CHAT = 9001;
const CLIENT = 5002;
const CLIENT_CHAT = 9002;
const STRANGER = 5003;
const STRANGER_CHAT = 9003;

const TIMEOUT = 120_000;

describe.skipIf(!DB)('безопасность: чужая сделка и вебхуки', () => {
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

  /** Настоящая сделка двух людей: клиент подтвердил и выбрал перевод — есть и карточки, и живой платёж. */
  async function dealWithTransfer(): Promise<{ id: string; clientCard: string; pid: number }> {
    await h.start(SELLER, SELLER_CHAT);
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'beauty',
      title: 'Маникюр с покрытием',
      total_rub: 2500,
      prepayment_rub: 500,
      scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      cancel_rule: 'free_24h',
      profile: { display_name: 'Анна Мастер', tax_mode: 'npd', payout_details: 'СБП, Т-Банк', transfer_enabled: true, link_enabled: false },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const id = res.json.deal.public_id as string;
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const clientCard = await cardMid(h, id, 'client');
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    return { id, clientCard, pid: await livePaymentId(h, id, 'prepayment') };
  }

  const count = async (sql: string, params: unknown[] = []) => (await h.query<{ n: number }>(sql, params))[0].n;

  describe('G1: посторонний на чужой сделке', () => {
    it('op/rs/pdf/pc/cr/rm/rc/cn и остальные коды → «Это не ваша сделка», больше ничего', async () => {
      const { id, pid } = await dealWithTransfer();
      await h.start(STRANGER, STRANGER_CHAT); // у постороннего есть диалог с ботом — карточку было бы куда прислать
      const cardsBefore = await count('SELECT count(*)::int AS n FROM card_messages');
      const eventsBefore = await count('SELECT count(*)::int AS n FROM deal_events');
      const mark = h.max.sent.length;

      const payloads = [
        `op:${id}`,
        `rs:${id}`,
        `pdf:${id}`,
        `pc:${id}:${pid}`,
        `cr:${id}`,
        `rm:${id}`,
        `rc:${id}`,
        `cn:${id}`,
        `cn:y:${id}:none`,
        `cf:${id}`,
        `dc:y:${id}`,
        `ac:${id}`,
        `dm:${id}`,
        `pl:${id}`,
        `pt:${id}`,
        `tr:c:${id}:${pid}`,
        `tr:g:${id}:${pid}`,
      ];
      for (const p of payloads) await h.press(STRANGER, STRANGER_CHAT, p, null);

      const after = h.max.sent.slice(mark);
      const answers = after.filter((m) => m.kind === 'answer');
      expect(answers).toHaveLength(payloads.length);
      for (const a of answers) {
        expect(a.text).toBe(texts.NOT_YOUR_DEAL);
        expect(a.buttons).toHaveLength(0);
      }
      // Ни новых сообщений (карточки, уведомления), ни правок чужих карточек.
      expect(after.filter((m) => m.kind !== 'answer')).toHaveLength(0);
      expect(await count('SELECT count(*)::int AS n FROM card_messages')).toBe(cardsBefore);
      expect(await count('SELECT count(*)::int AS n FROM card_messages WHERE user_id = $1', [STRANGER])).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM user_inputs WHERE user_id = $1', [STRANGER])).toBe(0);
      // Сделка и платёж не тронуты.
      expect(await count('SELECT count(*)::int AS n FROM deal_events')).toBe(eventsBefore);
      expect(await dealStatus(h, id)).toBe('awaiting_prepayment');
      expect((await h.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [pid]))[0].status).toBe('pending');
    }, TIMEOUT);

    it('«Проверить оплату» с платежом другой сделки → E1 над карточкой, чужой платёж не трогается', async () => {
      const first = await dealWithTransfer();
      const second = await dealWithTransfer();

      await h.press(CLIENT, CLIENT_CHAT, `pc:${first.id}:${second.pid}`, first.clientCard);

      expect(h.max.byMid(first.clientCard)!.text.startsWith(texts.E1)).toBe(true);
      expect((await h.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [second.pid]))[0].status).toBe('pending');
    }, TIMEOUT);
  });

  describe('G5: webhook_log не хранит чужие и битые тела целиком', () => {
    const settle = async () => {
      for (let i = 0; i < 100; i++) {
        const open = await count('SELECT count(*)::int AS n FROM webhook_log WHERE result IS NULL');
        if (open === 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const logged = () => h.query<{ result: string; payload: Record<string, unknown> }>('SELECT result, payload FROM webhook_log ORDER BY id');

    it('битая доставка → ignored:malformed, в payload только event, object.id и размер', async () => {
      const body = { junk: 'x'.repeat(5000), event: 42, object: { secret: 'не хранить' } };
      await h.webhook('/webhooks/yookassa', body, '203.0.113.5');
      await settle();

      const [row] = await logged();
      expect(row.result).toBe('ignored:malformed');
      expect(row.payload).toEqual({ event: null, object_id: null, size: Buffer.byteLength(JSON.stringify(body)) });
    }, TIMEOUT);

    it('чужой платёж → ignored:foreign, тело заменено сводкой', async () => {
      const body = { type: 'notification', event: 'payment.succeeded', object: { id: 'чужой-платёж-1', status: 'succeeded', metadata: { card: '5555' } } };
      await h.webhook('/webhooks/yookassa', body, '185.71.76.1');
      await settle();

      const [row] = await logged();
      expect(row.result).toBe('ignored:foreign');
      expect(row.payload).toEqual({ event: 'payment.succeeded', object_id: 'чужой-платёж-1', size: Buffer.byteLength(JSON.stringify(body)) });
    }, TIMEOUT);
  });
});
