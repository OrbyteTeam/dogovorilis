// Карточка сделки в каждом статусе и роли (DESIGN_BRIEF §3, чек-лист §9 п. 3–6): рендер настоящим cards.renderCard
// по каталогу test/helpers/render-fixtures.ts. Правила проверяются на всех карточках сразу, а полный текст с кнопками
// и кодами callback лежит снимком в __snapshots__/cards.md: его читает человек и он же попадает в отчёт.
import { afterAll, describe, expect, it, vi } from 'vitest';

import { loadConfig, setConfig } from '../src/config.js';
import { renderCard } from '../src/transport/bot/cards.js';
import { cardCases, FIXED_NOW, PUBLIC_ID } from './helpers/render-fixtures.js';

// Конфиг и часы ставятся до сбора кейсов: it.each строится при загрузке файла, раньше beforeAll.
vi.useFakeTimers();
vi.setSystemTime(FIXED_NOW);
setConfig(
  loadConfig({
    NODE_ENV: 'test',
    MAX_MODE: 'off',
    MAX_BOT_USERNAME: 'dogovorilis_bot',
    PUBLIC_BASE_URL: 'http://localhost:8080',
    DATABASE_URL: 'postgres://unused@localhost:5432/unused',
    PAYMENT_PROVIDER: 'yookassa',
    YOOKASSA_SHOP_ID: '000000',
    YOOKASSA_SECRET_KEY: 'test_unused',
    DEMO_MODE: 'true',
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv),
);
afterAll(() => {
  vi.useRealTimers();
});

type Btn = { type: string; text: string; payload?: string; url?: string };
const rowsOf = (attachments: unknown[]): Btn[][] =>
  attachments.flatMap((a) => (a as { payload?: { buttons?: Btn[][] } }).payload?.buttons ?? []);

const EMOJI = /\p{Extended_Pictographic}/u;

function rendered() {
  return cardCases().flatMap((c) => c.roles.map((role) => ({ c, role, ...renderCard(c.bundle, role) })));
}

describe('карточка по макету DESIGN_BRIEF §3.1', () => {
  const all = rendered();

  it('каталог покрывает все 12 статусов и три роли', () => {
    expect(new Set(all.map((r) => r.c.bundle.deal.status)).size).toBe(12);
    expect(new Set(all.map((r) => r.role))).toEqual(new Set(['seller', 'client', 'client_demo']));
  });

  it.each(all.map((r) => [`${r.c.id}/${r.role}`, r] as const))('%s: лимиты, шапка, порядок блоков, эмодзи', (_, r) => {
    const lines = r.text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(r.text.length).toBeLessThanOrEqual(1200);

    // Шапка из двух строк: эмодзи статуса, название жирным, номер; затем «Статус: …» словом.
    const head = r.role === 'client_demo' ? 1 : 0;
    if (r.role === 'client_demo') expect(lines[0]).toBe('🧪 **Демо: так видит клиент**');
    expect(lines[head]).toMatch(new RegExp(`^\\S+ \\*\\*[^*]+\\*\\* #${PUBLIC_ID}(, демо)?$`));
    expect(lines[head + 1]).toMatch(/^Статус: [а-яё]/);

    // Блоки в порядке «условия, стороны, платёж и документы».
    const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
    const order = ['Когда:', 'Сумма:', 'Отмена:', 'Исполнитель:', 'Клиент:'].map(at);
    expect(order.every((i) => i > head + 1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // Эмодзи только в шапке; исключение: строки 🧪 (тест и демо).
    for (const [i, line] of lines.entries()) {
      if (i === head || line.startsWith('🧪')) continue;
      expect(EMOJI.test(line), line).toBe(false);
    }

    // Жирным только название и суммы.
    for (const line of lines.filter((l) => l.includes('**'))) {
      expect(line === lines[head] || line.startsWith('🧪 **Демо') || line.startsWith('Сумма:') || line.startsWith('Переведите **'), line).toBe(true);
    }

    // Пояс ровно один раз, если в карточке есть время (DESIGN_BRIEF §2.4, чек-лист п. 5).
    const hasTime = /\d\d:\d\d/.test(r.text);
    expect(r.text.split('(МСК)').length - 1).toBe(hasTime ? 1 : 0);

    // Суммы целыми рублями через пробел, проценты через пробел (п. 4).
    expect(r.text).not.toMatch(/\d,\d\d\s?₽/);
    expect(r.text).not.toMatch(/\d₽|\d%/);
    expect(r.text).not.toMatch(/[—–·•]/);
  });

  it('кнопки: главное действие первым рядом, «Отменить сделку» последним, эмодзи только у 🧪', () => {
    for (const r of all) {
      const rows = rowsOf(r.attachments);
      const flat = rows.flat();
      for (const b of flat) expect(EMOJI.test(b.text.replace('🧪 ', '')), b.text).toBe(false);
      const cancel = flat.findIndex((b) => b.text === 'Отменить сделку');
      if (cancel >= 0) expect(rows.at(-1)?.[0].text, `${r.c.id}/${r.role}`).toBe('Отменить сделку');
    }
  });

  it('снимок текста и кнопок во всех статусах и ролях', async () => {
    const md = ['# Карточки сделки: снимок рендера', '', 'Генерируется тестом `render-cards.test.ts`; «сейчас» 20 сен 2026, 12:00 (МСК).', ''];
    for (const r of all) {
      md.push(`## ${r.c.title}: ${r.role} (\`${r.c.id}\`)`, '', '```', r.text, '```', '');
      const rows = rowsOf(r.attachments);
      if (!rows.length) md.push('_кнопок нет_', '');
      for (const row of rows) {
        md.push(`- ${row.map((b) => `[${b.text}] \`${b.type}:${b.payload ?? (b.url ?? '').replace(/\?.*$/, '?…')}\``).join(' + ')}`);
      }
      md.push('');
    }
    await expect(md.join('\n')).toMatchFileSnapshot('./__snapshots__/cards.md');
  });
});
