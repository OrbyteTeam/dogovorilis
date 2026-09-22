// Истечение срока подтверждения (T8) и перепланирование напоминаний (SPEC §5.2, §10.1; аудит 22.09 п. 3).
//
// Баг, который здесь закрыт: T2 «клиент открыл ссылку» статус не меняет, а перепланирование гасило все pending
// и вставляло набор заново через ON CONFLICT DO NOTHING. Ключ confirmation_expired тот же — строка оставалась
// погашенной, и настоящая сделка, где клиент открыл ссылку и не ответил, не истекала никогда.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inTx } from '../src/db/pool.js';
import { MIGRATIONS_DIR } from '../src/db/migrate.js';
import * as remindersRepo from '../src/db/repos/reminders.js';
import * as texts from '../src/texts.js';
import { tick } from '../src/scheduler/index.js';
import { cardMid, createHarness, dealStatus, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const SELLER = 4101;
const SELLER_CHAT = 7101;
const CLIENT = 4102;
const CLIENT_CHAT = 7102;
const MINUTE = 60_000;

describe.skipIf(!DB)('истечение срока подтверждения и перепланирование напоминаний', () => {
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

  /** Настоящая сделка: исполнитель создаёт через API мини-приложения — клиент ещё не привязан. */
  async function createReal(): Promise<string> {
    await h.start(SELLER, SELLER_CHAT);
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'beauty',
      title: 'Маникюр с покрытием',
      total_rub: 2500,
      prepayment_rub: 500,
      scheduled_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      cancel_rule: 'free_24h',
      profile: {
        display_name: 'Анна Мастер',
        tax_mode: 'npd',
        payout_details: 'СБП +7 900 000-00-00, Т-Банк',
        transfer_enabled: true,
        link_enabled: false,
        default_cancel_rule: 'free_24h',
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.deal.public_id as string;
  }

  type Row = { kind: string; status: string; last_error: string | null; attempts: number; due_at: Date; dedupe_key: string };

  async function reminders(id: string): Promise<Row[]> {
    return h.query<Row>(
      `SELECT r.kind, r.status, r.last_error, r.attempts, r.due_at, r.dedupe_key FROM reminders r
       JOIN deals d ON d.id = r.deal_id WHERE d.public_id = $1 ORDER BY r.id`,
      [id],
    );
  }

  async function deal(id: string): Promise<{ id: number; expires_at: Date | null; status_changed_at: Date }> {
    const rows = await h.query<{ id: number; expires_at: Date | null; status_changed_at: Date }>(
      'SELECT id, expires_at, status_changed_at FROM deals WHERE public_id = $1',
      [id],
    );
    return rows[0];
  }

  async function expiredEvents(id: string): Promise<number> {
    const rows = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM deal_events e JOIN deals d ON d.id = e.deal_id
       WHERE d.public_id = $1 AND e.type = 'deal.expired'`,
      [id],
    );
    return rows[0].n;
  }

  it('клиент открыл ссылку (T2, статус тот же) → confirmation_expired жив → тик после срока → expired, N7 обеим', async () => {
    const id = await createReal();
    const before = await deal(id);
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`); // T2: клиент открыл ссылку и не ответил

    expect(await dealStatus(h, id)).toBe('awaiting_confirmation');
    const after = await deal(id);
    expect(after.status_changed_at.getTime()).toBe(before.status_changed_at.getTime()); // статус не менялся
    const rows = await reminders(id);
    const expiry = rows.filter((r) => r.kind === 'confirmation_expired');
    expect(expiry).toHaveLength(1);
    expect(expiry[0].status).toBe('pending'); // до исправления здесь был cancelled/replanned
    expect(expiry[0].due_at.getTime()).toBe(after.expires_at!.getTime());
    // T2 гасит «клиент не открыл» — клиент как раз открыл (SPEC §5.2 T2)
    expect(rows.find((r) => r.kind === 'client_not_opened')).toMatchObject({ status: 'cancelled', last_error: 'replanned' });

    h.max.reset();
    await tick({ max: h.gateway, sendReminders: true }, new Date(after.expires_at!.getTime() + MINUTE));

    expect(await dealStatus(h, id)).toBe('expired');
    expect(h.max.inChat(SELLER_CHAT).map((m) => m.text)).toContain(texts.N7({ id }));
    expect(h.max.inChat(CLIENT_CHAT).map((m) => m.text)).toContain(texts.N7({ id }));
    expect(await expiredEvents(id)).toBe(1);
    expect((await deal(id)).expires_at).toBeNull(); // вышли из ожидания подтверждения — срок обнулён

    // Повторный тик ничего не шлёт и второго события не пишет
    h.max.reset();
    await tick({ max: h.gateway, sendReminders: true }, new Date(after.expires_at!.getTime() + 2 * MINUTE));
    expect(h.max.sent).toHaveLength(0);
    expect(await expiredEvents(id)).toBe(1);
    expect((await reminders(id)).find((r) => r.kind === 'confirmation_expired')?.status).toBe('sent');
  });

  it('до срока тик сделку не трогает', async () => {
    const id = await createReal();
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const { expires_at } = await deal(id);
    h.max.reset();

    await tick({ max: h.gateway, sendReminders: true }, new Date(expires_at!.getTime() - MINUTE));

    expect(await dealStatus(h, id)).toBe('awaiting_confirmation');
    expect(h.max.sent).toHaveLength(0);
  });

  it('повторное открытие ссылки тем же клиентом и «Открыть как клиент» не хоронят срок', async () => {
    const real = await createReal();
    await h.start(CLIENT, CLIENT_CHAT, `d_${real}`);
    await h.start(CLIENT, CLIENT_CHAT, `d_${real}`);
    expect((await reminders(real)).filter((r) => r.kind === 'confirmation_expired' && r.status === 'pending')).toHaveLength(1);

    const demo = await createReal();
    await h.press(SELLER, SELLER_CHAT, `dm:${demo}`, await cardMid(h, demo, 'seller')); // демо: тоже без смены статуса
    const rows = await reminders(demo);
    expect(rows.filter((r) => r.kind === 'confirmation_expired' && r.status === 'pending')).toHaveLength(1);

    const { expires_at } = await deal(demo);
    await tick({ max: h.gateway, sendReminders: true }, new Date(expires_at!.getTime() + MINUTE));
    expect(await dealStatus(h, demo)).toBe('expired');
  });

  it('срок подтверждения обнуляется при выходе из ожидания и живёт внутри него (T4 → T6)', async () => {
    const id = await createReal();
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    const clientCard = await cardMid(h, id, 'client');

    // T4: «Предложить изменения» — всё ещё ждём подтверждения, срок на месте
    await h.press(CLIENT, CLIENT_CHAT, `cr:${id}`, clientCard);
    await h.say(CLIENT, CLIENT_CHAT, 'давайте на час позже');
    expect(await dealStatus(h, id)).toBe('changes_requested');
    expect((await deal(id)).expires_at).not.toBeNull();
    const pending = (await reminders(id)).filter((r) => r.status === 'pending').map((r) => r.kind);
    expect(pending).toEqual(['confirmation_expired']); // старый ключ погашен, новый — под новый status_changed_at

    // T6: «Оставить как есть» — снова ждём подтверждения, срок продлён
    await h.press(SELLER, SELLER_CHAT, `ka:${id}`, await cardMid(h, id, 'seller'));
    expect(await dealStatus(h, id)).toBe('awaiting_confirmation');
    expect((await deal(id)).expires_at).not.toBeNull();

    // T3: «Подтверждаю» — ожидание закончилось
    await h.press(CLIENT, CLIENT_CHAT, `cf:${id}`, clientCard);
    expect(await dealStatus(h, id)).toBe('awaiting_prepayment');
    expect((await deal(id)).expires_at).toBeNull();
    expect((await reminders(id)).filter((r) => r.kind === 'confirmation_expired' && r.status === 'pending')).toHaveLength(0);
  });

  it('planMany оживляет только строки, погашенные перепланированием', async () => {
    const id = await createReal();
    const { id: dealId } = await deal(id);
    const oldDue = new Date('2026-01-01T00:00:00Z');
    const newDue = new Date('2030-01-01T00:00:00Z');
    const cases: Array<{ key: string; status: string; lastError: string | null }> = [
      { key: 'replanned', status: 'cancelled', lastError: 'replanned' },
      { key: 'state_changed', status: 'cancelled', lastError: 'state_changed' },
      { key: 'no_chat', status: 'cancelled', lastError: 'no_chat' },
      { key: 'sending_disabled', status: 'cancelled', lastError: 'sending_disabled' },
      { key: 'sent', status: 'sent', lastError: null },
      { key: 'failed', status: 'failed', lastError: 'boom' },
      { key: 'pending', status: 'pending', lastError: null },
    ];
    for (const c of cases) {
      await h.query(
        `INSERT INTO reminders (deal_id, kind, recipient_role, due_at, dedupe_key, status, attempts, last_error)
         VALUES ($1, 'prepayment_due', 'client', $2, $3, $4, 2, $5)`,
        [dealId, oldDue, `test:${c.key}`, c.status, c.lastError],
      );
    }

    const touched = await inTx((c) =>
      remindersRepo.planMany(
        c,
        dealId,
        cases.map((x) => ({ kind: 'prepayment_due' as const, recipientRole: 'client' as const, dueAt: newDue, dedupeKey: `test:${x.key}` })),
      ),
    );

    expect(touched).toBe(1);
    const rows = await h.query<{ dedupe_key: string; status: string; last_error: string | null; attempts: number; due_at: Date }>(
      `SELECT dedupe_key, status, last_error, attempts, due_at FROM reminders WHERE dedupe_key LIKE 'test:%'`,
    );
    const byKey = new Map(rows.map((r) => [r.dedupe_key.slice('test:'.length), r]));
    expect(byKey.get('replanned')).toMatchObject({ status: 'pending', last_error: null, attempts: 0, due_at: newDue });
    for (const c of cases.filter((x) => x.key !== 'replanned')) {
      expect(byKey.get(c.key), c.key).toMatchObject({ status: c.status, last_error: c.lastError, attempts: 2, due_at: oldDue });
    }
  });

  describe('миграция 0003: зависшие на проде confirmation_expired', () => {
    async function runMigration(): Promise<void> {
      const sql = await readFile(path.join(MIGRATIONS_DIR, '0003_revive_confirmation_expired.sql'), 'utf8');
      await h.query(sql);
    }

    /** Состояние, в котором сделку оставлял старый код: T2 погасил срок, заново он не вставился. */
    async function stuckDeal(): Promise<string> {
      const id = await createReal();
      await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
      await h.query(
        `UPDATE reminders SET status = 'cancelled', last_error = 'replanned'
         WHERE kind = 'confirmation_expired' AND deal_id = (SELECT id FROM deals WHERE public_id = $1)`,
        [id],
      );
      return id;
    }

    it('оживляет срок у сделки, ждущей подтверждения, и после этого T8 срабатывает; повторный прогон ничего не меняет', async () => {
      const id = await stuckDeal();
      await h.query(`UPDATE reminders SET attempts = 1 WHERE kind = 'confirmation_expired'`);

      await runMigration();
      const row = (await reminders(id)).find((r) => r.kind === 'confirmation_expired')!;
      expect(row).toMatchObject({ status: 'pending', last_error: null, attempts: 0 });

      await runMigration(); // идемпотентна
      expect((await reminders(id)).filter((r) => r.kind === 'confirmation_expired')).toHaveLength(1);

      const { expires_at } = await deal(id);
      await tick({ max: h.gateway, sendReminders: true }, new Date(expires_at!.getTime() + MINUTE));
      expect(await dealStatus(h, id)).toBe('expired');
    });

    it('не трогает: отменённое планировщиком по делу, ключ прошлого статуса, сделку вне ожидания', async () => {
      // 1) погашено планировщиком как state_changed — не наше
      const a = await stuckDeal();
      await h.query(
        `UPDATE reminders SET last_error = 'state_changed' WHERE kind = 'confirmation_expired' AND deal_id = (SELECT id FROM deals WHERE public_id = $1)`,
        [a],
      );
      // 2) ключ относится к прошлому статусу (сделка с тех пор меняла status_changed_at)
      const b = await stuckDeal();
      await h.query(`UPDATE deals SET status_changed_at = status_changed_at + interval '1 second' WHERE public_id = $1`, [b]);
      // 3) сделка уже подтверждена — её старый срок законно погашен
      const c = await createReal();
      await h.start(CLIENT + 1, CLIENT_CHAT + 1, `d_${c}`);
      await h.press(CLIENT + 1, CLIENT_CHAT + 1, `cf:${c}`, await cardMid(h, c, 'client'));

      await runMigration();

      for (const id of [a, b, c]) {
        const row = (await reminders(id)).find((r) => r.kind === 'confirmation_expired')!;
        expect(row.status, id).toBe('cancelled');
      }
    });
  });
});
