// «/deals» в чате, шеринг и короткие статусы (ЗАДАЧА_04 A1–A2). Чистые функции — без БД и сети.
import { describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { dealsListMessage } from '../src/transport/bot/handlers/menu.js';
import { menuKeyboard, shareUrl, tryKeyboard } from '../src/transport/bot/keyboards.js';
import { dayAndTime, zonedToUtc } from '../src/domain/time.js';
import type { DealListItem, DealStatus } from '../src/types.js';

const NOW = zonedToUtc(2026, 9, 27, 18, 0);

let seq = 0;
function item(p: Partial<DealListItem> & { scheduledAt: Date | null }): DealListItem {
  seq += 1;
  return {
    publicId: `Deal${String(seq).padStart(6, '0')}`,
    status: 'awaiting_prepayment' as DealStatus,
    demo: false,
    role: 'seller',
    title: 'Маникюр с покрытием',
    totalKopecks: 250_000,
    prepaymentKopecks: 50_000,
    paidKopecks: 0,
    updatedAt: NOW,
    ...p,
  };
}

type Btn = { type: string; text: string; payload?: string };
/** Деньги форматируются с неразрывным пробелом между разрядами — для сравнения со строкой-эталоном заменяем. */
const plain = (s: string) => s.replace(/\u00a0/g, ' ');
const texts_ = (rows: Btn[][]) => rows.flat().map((b) => b.text);

describe('dayAndTime', () => {
  it('«Пн 28 сен» и «14:00» по Москве, год — только если не текущий', () => {
    expect(dayAndTime(zonedToUtc(2026, 9, 28, 14, 0), undefined, NOW)).toEqual({ day: 'Пн 28 сен', time: '14:00' });
    expect(dayAndTime(zonedToUtc(2027, 1, 5, 9, 30), undefined, NOW)).toEqual({ day: 'Вт 5 янв 2027', time: '09:30' });
  });
});

describe('/deals — два раздела, даты, названия ссылками (ЗАДАЧА_04 A2)', () => {
  it('строка: дата · [название](диплинк) · сумма · статус словом — без кода и эмодзи-статуса', () => {
    const d = item({ scheduledAt: zonedToUtc(2026, 9, 28, 14, 0) });
    const { text } = dealsListMessage([d], NOW);
    expect(plain(text)).toContain(
      `Пн 28 сен, 14:00 · [Маникюр с покрытием](https://max.ru/bot?start=d_${d.publicId}) · 2 500 ₽ · ждём предоплату`,
    );
    expect(text).not.toContain(`#${d.publicId}`);
    expect(text).not.toContain(texts.statusEmoji('awaiting_prepayment'));
    expect(text).toContain('МСК'); // метка пояса — один раз, в заголовке
  });

  it('разделы «Я исполнитель» / «Я клиент»; пустой не показывается', () => {
    const onlySeller = dealsListMessage([item({ scheduledAt: null })], NOW).text;
    expect(onlySeller).toContain(texts.DEALS_SELLER);
    expect(onlySeller).not.toContain(texts.DEALS_CLIENT);

    const onlyClient = dealsListMessage([item({ scheduledAt: null, role: 'client', status: 'awaiting_confirmation' })], NOW).text;
    expect(onlyClient).not.toContain(texts.DEALS_SELLER);
    expect(onlyClient).toContain(texts.DEALS_CLIENT);
    expect(onlyClient).toContain('подтвердите условия'); // статус — глазами клиента
  });

  it('сортировка по дате, «без даты» — в конце; демо помечено', () => {
    const late = item({ scheduledAt: zonedToUtc(2026, 10, 3, 10, 0), title: 'Поздняя' });
    const none = item({ scheduledAt: null, title: 'Без срока', demo: true });
    const early = item({ scheduledAt: zonedToUtc(2026, 9, 28, 9, 0), title: 'Ранняя' });
    const { text, rows } = dealsListMessage([late, none, early], NOW);
    const order = ['Ранняя', 'Поздняя', 'Без срока'].map((t) => text.indexOf(`[${t}]`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(plain(text)).toMatch(/\[Без срока\]\([^)]+\) · 2 500 ₽ · ждём предоплату · демо$/m);
    // Кнопки — «день время · название», в том же порядке, что строки; последняя — мини-приложение
    const labels = texts_(rows as Btn[][]);
    expect(labels.slice(0, 3)).toEqual(['Пн 28 сен 09:00 · Ранняя', 'Сб 3 окт 10:00 · Поздняя', 'Без даты · Без срока']);
    expect(labels.at(-1)).toBe(texts.BTN.myDeals);
    expect((rows as Btn[][]).flat()[0].payload).toBe(`op:${early.publicId}`);
  });

  it('до 10 строк на раздел, дальше «…и ещё N — в «📁 Мои сделки»»', () => {
    const many = Array.from({ length: 13 }, (_, i) => item({ scheduledAt: zonedToUtc(2026, 10, 1 + i, 12, 0) }));
    const { text, rows } = dealsListMessage(many, NOW);
    expect(text.split('\n').filter((l) => l.includes('](https://max.ru/'))).toHaveLength(10);
    expect(text).toContain('…и ещё 3 — в «📁 Мои сделки»');
    expect(rows).toHaveLength(11); // 10 «Открыть» + «Мои сделки»
  });

  it('длинное название в кнопке обрезается, в строке — нет; разметка в названии экранирована', () => {
    const d = item({ scheduledAt: null, title: 'Ремонт [стиральной] машины *с выездом* на дом' });
    const { text, rows } = dealsListMessage([d], NOW);
    expect(text).toContain('[Ремонт \\[стиральной\\] машины \\*с выездом\\* на дом](');
    expect(texts_(rows as Btn[][])[0].length).toBeLessThanOrEqual('Без даты · '.length + 18);
  });
});

describe('шеринг — ссылка ровно один раз (ЗАДАЧА_04 A1)', () => {
  it('текст приглашения без ссылки: название и дата с МСК', () => {
    const invite = texts.shareInvite('Маникюр', zonedToUtc(2026, 9, 28, 14, 0));
    expect(invite).toMatch(/^Подтвердите нашу договорённость: Маникюр, пн, 28 сен, 14:00 \(МСК\)$/);
    expect(texts.shareInvite('Маникюр', null)).toBe('Подтвердите нашу договорённость: Маникюр');
  });

  it(':share несёт ссылку один раз', () => {
    const link = 'https://max.ru/bot?start=d_AAAAAAAAAA';
    const text = decodeURIComponent(new URL(shareUrl(link, texts.shareInvite('Маникюр', null))).searchParams.get('text')!);
    expect(text.split(link)).toHaveLength(2);
  });
});

describe('меню из пяти кнопок и «🧪 Попробовать» (ЗАДАЧА_04 A3)', () => {
  const buttons = (kb: unknown) => (kb as { payload: { buttons: Btn[][] } }).payload.buttons.flat();

  it('меню: новая сделка, мои сделки, настройки, как это работает, попробовать', () => {
    expect(buttons(menuKeyboard({ botUsername: 'bot', demoMode: true })).map((b) => b.text)).toEqual([
      texts.BTN.newDeal,
      texts.BTN.myDeals,
      texts.BTN.settings,
      texts.BTN.help,
      texts.BTN.tryIt,
    ]);
  });

  it('«Попробовать»: демо (если включено), сделка-пример, назад в меню', () => {
    expect(buttons(tryKeyboard({ demoMode: true })).map((b) => b.payload)).toEqual(['dm:new', 'ex:new', 'menu']);
    expect(buttons(tryKeyboard({ demoMode: false })).map((b) => b.payload)).toEqual(['ex:new', 'menu']);
  });
});

describe('статус словом — на каждую пару (статус, роль)', () => {
  const all: DealStatus[] = [
    'awaiting_confirmation', 'changes_requested', 'declined', 'expired', 'awaiting_prepayment', 'scheduled',
    'awaiting_acceptance', 'remarks', 'awaiting_payment', 'paid', 'closed', 'cancelled',
  ];
  it.each(all)('%s', (s) => {
    for (const role of ['seller', 'client'] as const) {
      const t = texts.statusShort(s, role);
      expect(t).toMatch(/^[а-яё ,]+$/); // строчными, без эмодзи и кодов
    }
  });
});
