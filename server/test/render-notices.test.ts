// Уведомления по шаблону DESIGN_BRIEF §4 (чек-лист §9 п. 7): факт первой строкой с эмодзи типа и номером сделки,
// действие второй строкой, одна кнопка. Рендер настоящим notify.noticesFor и текстами напоминаний; полный текст
// с кнопками хранится снимком __snapshots__/notifications.md для отчёта.
import { afterAll, describe, expect, it, vi } from 'vitest';

import { loadConfig, setConfig } from '../src/config.js';
import * as texts from '../src/texts.js';
import { digestKeyboard, reminderKeyboard, transferCheckKeyboard, transferDisputeKeyboard, transferKeyboard } from '../src/transport/bot/keyboards.js';
import { noticesFor } from '../src/transport/bot/notify.js';
import type { ReminderKind } from '../src/types.js';
import { FIXED_NOW, noticeCases, PUBLIC_ID, SCHEDULED } from './helpers/render-fixtures.js';

vi.useFakeTimers();
vi.setSystemTime(FIXED_NOW);
setConfig(
  loadConfig({
    NODE_ENV: 'test',
    MAX_MODE: 'off',
    MAX_BOT_USERNAME: 'dogovorilis_bot',
    PUBLIC_BASE_URL: 'http://localhost:8080',
    DATABASE_URL: 'postgres://unused@localhost:5432/unused',
    PAYMENT_PROVIDER: 'none',
    DEMO_MODE: 'true',
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv),
);
afterAll(() => {
  vi.useRealTimers();
});

type Btn = { type: string; text: string; payload?: string };
type Rendered = { id: string; title: string; to: string; text: string; keyboard?: unknown };
const buttons = (kb: unknown): Btn[][] => (kb as { payload?: { buttons?: Btn[][] } } | undefined)?.payload?.buttons ?? [];

const REMINDERS: Exclude<ReminderKind, 'daily_digest'>[] = [
  'client_not_opened', 'prepayment_due', 'prepayment_overdue', 'event_tomorrow', 'event_passed', 'acceptance_due',
  'payment_due', 'payment_overdue', 'receipt_due', 'receipt_deadline', 'refund_due', 'event_soon',
];

function all(): Rendered[] {
  const out: Rendered[] = [];
  for (const c of noticeCases()) {
    for (const n of noticesFor(c.bundle, c.event)) {
      const prefix = c.bundle.deal.demo ? texts.demoNotifyPrefix(n.to) : '';
      out.push({ id: c.id, title: c.title, to: n.to, text: prefix + n.text, keyboard: n.keyboard });
    }
  }
  const id = PUBLIC_ID;
  out.push({ id: 'N14', title: 'N14 сделка закрыта (подпись к квитанции)', to: 'both', text: texts.N14({ id, withReceipt: true }) });
  out.push({
    id: 'N16',
    title: 'N16 ручное напоминание клиенту',
    to: 'client',
    text: texts.N16({ id, context: texts.statusText('awaiting_prepayment', 'client', { prepaymentKopecks: 90_000, remainingKopecks: 210_000, scheduledAt: SCHEDULED }) }),
    keyboard: reminderKeyboard('prepayment_due', id),
  });
  out.push({ id: 'P2', title: 'P2 клиент сообщил о переводе', to: 'seller', text: texts.P2({ client: 'Саша', sumKopecks: 90_000, id }), keyboard: transferCheckKeyboard(id, 1) });
  out.push({ id: 'P3', title: 'P3 исполнитель не видит перевод', to: 'client', text: texts.P3({ id, sumKopecks: 90_000 }), keyboard: transferKeyboard(id, 1) });
  out.push({
    id: 'P3_DISPUTE',
    title: 'P3 второй раз подряд, оплата по ссылке доступна',
    to: 'client',
    text: texts.P3_DISPUTE({ id, sumKopecks: 90_000, linkAvailable: true }),
    keyboard: transferDisputeKeyboard(id, 1, true),
  });
  out.push({
    id: 'P3_DISPUTE-nolink',
    title: 'P3 второй раз подряд, оплаты по ссылке нет',
    to: 'client',
    text: texts.P3_DISPUTE({ id, sumKopecks: 90_000, linkAvailable: false }),
    keyboard: transferDisputeKeyboard(id, 1, false),
  });
  const at = (hhmm: string) => new Date(`2026-09-20T${hhmm}:00+03:00`);
  const digestLines: texts.DigestLine[] = [
    { scheduledAt: at('10:00'), title: 'Маникюр с покрытием', clientName: 'Саша', status: 'scheduled', prepaymentKopecks: 90_000, demo: false },
    { scheduledAt: at('13:30'), title: 'Стрижка', clientName: null, status: 'awaiting_confirmation', prepaymentKopecks: 0, demo: false },
    { scheduledAt: at('17:00'), title: 'Педикюр', clientName: 'Ира', status: 'awaiting_prepayment', prepaymentKopecks: 60_000, demo: false },
  ];
  out.push({
    id: 'digest',
    title: 'Утренняя сводка исполнителю',
    to: 'seller',
    text: texts.dailyDigest({ day: at('00:00'), lines: digestLines, now: FIXED_NOW }),
    keyboard: digestKeyboard('dogovorilis_bot'),
  });
  for (const kind of REMINDERS) {
    const text =
      kind === 'event_soon'
        ? texts.eventSoon({ to: 'seller', title: 'Маникюр с покрытием', clientName: 'Саша', sellerName: 'Анна Аксёнова', prepayment: 'received', prepaymentKopecks: 90_000 })
        : texts.reminderText(kind, { id, title: 'Маникюр с покрытием', sumKopecks: 90_000, scheduledAt: SCHEDULED, deadline: new Date('2026-10-09T20:59:00Z') });
    out.push({ id: `reminder:${kind}`, title: `Напоминание ${kind}`, to: 'recipient', text, keyboard: reminderKeyboard(kind, id) });
  }
  return out;
}

describe('уведомления по шаблону DESIGN_BRIEF §4', () => {
  const rendered = all();

  it.each(rendered.map((r) => [`${r.id} → ${r.to}`, r] as const))('%s', (_, r) => {
    const lines = r.text.replace(/^🧪 \((клиенту|исполнителю)\) /, '').split('\n');
    // Факт: эмодзи типа события первым, номер сделки (кроме «через 30 минут», где сделка названа по имени).
    expect(lines[0], r.text).toMatch(/^\p{Extended_Pictographic}/u);
    // Сделка названа номером; исключения: «через 30 минут» (по имени) и сводка (по времени и имени, сделок несколько).
    if (r.id !== 'reminder:event_soon' && r.id !== 'digest') expect(lines[0]).toContain(`#${PUBLIC_ID}`);
    // Эмодзи только в первой строке; исключение: строки 🧪.
    for (const line of lines.slice(1)) {
      if (!line.startsWith('🧪')) expect(/\p{Extended_Pictographic}/u.test(line), line).toBe(false);
    }
    // Одна кнопка, кроме ответов на вопрос с двумя-тремя вариантами (N3, N11, N13, P2, P3 по таблице §4).
    const flat = buttons(r.keyboard).flat();
    const multi = ['N3', 'N11', 'N13', 'P2', 'P3', 'P3_DISPUTE'].includes(r.id);
    expect(flat.length).toBeLessThanOrEqual(multi ? 3 : 1);
    // Пояс не больше одного раза; суммы и разделители по §2.
    expect(r.text.split('(МСК)').length - 1).toBeLessThanOrEqual(1);
    expect(r.text).not.toMatch(/[—–·•]/);
    expect(r.text).not.toMatch(/\d₽|\d%/);
  });

  it('действие второй строкой у всех уведомлений, где от получателя что-то нужно', () => {
    for (const r of rendered) {
      if (r.id === 'reminder:event_tomorrow' || r.id === 'reminder:event_soon') continue;
      expect(r.text.split('\n').length, r.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('кнопки по таблице §4: N6 и N7 исполнителю «Новая сделка», напоминание о чеке «Приложить чек», «через 30 минут» без кнопки', () => {
    const by = (id: string, to = 'seller') => rendered.find((r) => r.id === id && r.to === to)!;
    expect(buttons(by('N6').keyboard).flat().map((b) => b.text)).toEqual([texts.BTN.newDeal]);
    expect(buttons(by('N7').keyboard).flat().map((b) => b.text)).toEqual([texts.BTN.newDeal]);
    expect(by('N7', 'client').keyboard).toBeUndefined();
    expect(buttons(by('N15-client').keyboard).flat().map((b) => b.text)).toEqual([texts.BTN.open]);
    expect(buttons(by('reminder:receipt_due', 'recipient').keyboard).flat()).toEqual([expect.objectContaining({ text: texts.BTN.attachReceipt, payload: `rc:${PUBLIC_ID}` })]);
    expect(by('reminder:event_soon', 'recipient').keyboard).toBeUndefined();
  });

  it('снимок текстов и кнопок', async () => {
    const md = ['# Уведомления и напоминания: снимок рендера', '', 'Генерируется тестом `render-notices.test.ts`.', ''];
    for (const r of rendered) {
      md.push(`## ${r.title} → ${r.to} (\`${r.id}\`)`, '', '```', r.text, '```', '');
      const rows = buttons(r.keyboard);
      if (!rows.length) md.push('_кнопок нет_', '');
      for (const row of rows) md.push(`- ${row.map((b) => `[${b.text}] \`${b.type}:${b.payload ?? ''}\``).join(' + ')}`);
      md.push('');
    }
    await expect(md.join('\n')).toMatchFileSnapshot('./__snapshots__/notifications.md');
  });
});
