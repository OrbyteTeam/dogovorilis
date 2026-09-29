// Подписи надёжности и оценки (ЗАДАЧА_08 E, SPEC §7.11).
import { describe, expect, it } from 'vitest';

import { dealRatingText, ratingText, reliabilityRows } from '../src/reliability';

describe('надёжность исполнителя', () => {
  it('пять строк; нет данных — «пока нет данных», а не 0 %', () => {
    const rows = reliabilityRows({ closed: 0, no_dispute_percent: null, cheque_on_time_percent: null, seller_cancel_percent: null, rating: null });
    expect(rows.map((r) => r.label)).toEqual(['Сделок закрыто', 'Без споров', 'Чек в срок', 'Отмены с вашей стороны', 'Оценка клиентов']);
    expect(rows.map((r) => r.value)).toEqual(['0', 'пока нет данных', 'пока нет данных', 'пока нет данных', 'оценок пока нет']);
  });

  it('проценты и средняя оценка с запятой и склонением', () => {
    const rows = reliabilityRows({ closed: 120, no_dispute_percent: 98, cheque_on_time_percent: 91, seller_cancel_percent: 2, rating: { average: 4.8, count: 12 } });
    expect(rows.map((r) => r.value)).toEqual(['120', '98 %', '91 %', '2 %', '4,8 из 5, 12 оценок']);
    expect(ratingText({ average: 5, count: 1 })).toBe('5,0 из 5, 1 оценка');
    expect(ratingText({ average: 4.5, count: 3 })).toBe('4,5 из 5, 3 оценки');
  });

  it('оценка на экране сделки: исполнителю — клиента, клиенту — своя; комментарий в кавычках', () => {
    expect(dealRatingText('seller', { score: 5, comment: 'Всё отлично' })).toBe('Оценка клиента: 5 из 5. «Всё отлично»');
    expect(dealRatingText('client', { score: 4, comment: null })).toBe('Ваша оценка: 4 из 5');
  });
});
