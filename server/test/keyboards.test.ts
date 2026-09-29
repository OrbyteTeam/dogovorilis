// Раскладка кнопок. Проверяется одна вещь, зато та, которую видно жюри: MAX не переносит длинную
// подпись, а обрезает её многоточием — «💳 Оплатить по ссы…». Значит две кнопки в ряду допустимы
// только когда обе подписи короткие. Поймано живым прогоном 21.09.2026 (и на телефоне, и на web.max.ru).
import { describe, expect, it } from 'vitest';
import { labelWidth, menuKeyboard, pair, PAIR_LABEL_WIDTH } from '../src/transport/bot/keyboards.js';
import { BTN } from '../src/texts.js';

type Btn = { text: string };
const btn = (text: string) => ({ type: 'callback', text, payload: 'x' }) as unknown as Parameters<typeof pair>[0];

/** Достать ряды кнопок из вложения-клавиатуры, как их увидит MAX. */
function rowsOf(attachment: unknown): Btn[][] {
  const payload = (attachment as { payload?: { buttons?: Btn[][] } }).payload;
  return payload?.buttons ?? [];
}

describe('ширина подписи', () => {
  it('кириллица и латиница считаются по одному знаку', () => {
    expect(labelWidth('Отмена')).toBe(6);
    expect(labelWidth('Cancel')).toBe(6);
  });

  it('эмодзи считается за два знака — он и занимает больше', () => {
    expect(labelWidth('✅ Да')).toBe(2 + 1 + 2);
  });

  it('невидимый вариационный селектор места не занимает', () => {
    // «✏️» — это ✏ + U+FE0F; без учёта селектора ширина была бы завышена.
    expect(labelWidth('✏️')).toBe(2);
  });
});

describe('пара кнопок в ряду', () => {
  it('две короткие подписи остаются в одном ряду', () => {
    expect(pair(btn('Да'), btn('Нет'))).toEqual([[{ type: 'callback', text: 'Да', payload: 'x' }, { type: 'callback', text: 'Нет', payload: 'x' }]]);
  });

  it('длинная подпись уезжает в свой ряд вместе с соседкой', () => {
    const rows = pair(btn('🔁 Перевести по реквизитам'), btn('Отмена'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(1);
    expect(rows[1]).toHaveLength(1);
  });
});

describe('подписи, которые реально используются', () => {
  // Если кто-то удлинит подпись, тест покажет, что она больше не влезает в пару.
  // Без эмодзи подписи короче (DESIGN_BRIEF §2.8): «Изменить условия» и «Есть замечания» теперь влезают в пару,
  // а эти пять по-прежнему длиннее 16 знаков и всегда занимают свой ряд.
  const mustBeAlone = [BTN.payByLink, BTN.payByTransfer, BTN.requestChanges, BTN.sendToMax, BTN.copyLink];

  it('короткие ответы на один вопрос помещаются в пару', () => {
    for (const label of [BTN.accept, BTN.remarks, BTN.newDeal, BTN.myDeals, BTN.settings, BTN.help]) {
      expect(labelWidth(label), label).toBeLessThanOrEqual(PAIR_LABEL_WIDTH);
    }
  });

  it.each(mustBeAlone)('«%s» слишком длинная для пары', (label) => {
    expect(labelWidth(label)).toBeGreaterThan(PAIR_LABEL_WIDTH);
  });

  it('в готовом меню ни один ряд из двух кнопок не содержит длинной подписи', () => {
    const rows = rowsOf(menuKeyboard({ botUsername: 'bot', demoMode: true }));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.length < 2) continue;
      for (const b of row) expect(labelWidth(b.text)).toBeLessThanOrEqual(PAIR_LABEL_WIDTH);
    }
  });
});
