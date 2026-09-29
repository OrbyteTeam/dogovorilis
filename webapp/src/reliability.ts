// Надёжность исполнителя в «Настройках» и оценка на экране сделки (ЗАДАЧА_08 E, SPEC §7.11) — чистые подписи.
// Модуль без React: его покрывают unit-тесты webapp/test/reliability.test.ts.
import type { Reliability } from './types';

export interface ReliabilityRow {
  label: string;
  value: string;
}

const NO_DATA = 'пока нет данных';

/** Число и «%» через неразрывный пробел: в узкой колонке «40 %» не должно разрываться на две строки. */
const percent = (value: number | null) => (value === null ? NO_DATA : `${value}\u00a0%`);

/**
 * «4,8 из 5, 12 оценок» — средняя с запятой, как принято в русском тексте. Внутри «4,8 из 5» и «12 оценок» пробелы
 * неразрывные: в узкой колонке строка переносится только после запятой, число не отрывается от слова.
 */
export function ratingText(rating: Reliability['rating']): string {
  if (!rating) return 'оценок пока нет';
  const average = rating.average.toFixed(1).replace('.', ',');
  return `${average}\u00a0из\u00a05, ${rating.count}\u00a0${pluralRatings(rating.count)}`;
}

function pluralRatings(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'оценка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'оценки';
  return 'оценок';
}

/** Пять строк блока «Надёжность» в том порядке, что в SPEC §7.11. */
export function reliabilityRows(r: Reliability): ReliabilityRow[] {
  return [
    { label: 'Сделок закрыто', value: String(r.closed) },
    { label: 'Без споров', value: percent(r.no_dispute_percent) },
    { label: 'Чек в срок', value: percent(r.cheque_on_time_percent) },
    { label: 'Отмены с вашей стороны', value: percent(r.seller_cancel_percent) },
    { label: 'Оценка клиентов', value: ratingText(r.rating) },
  ];
}

/** Строка оценки на экране сделки: исполнителю — «Оценка клиента: 5 из 5», клиенту — «Ваша оценка: 5 из 5». */
export function dealRatingText(role: 'seller' | 'client', rating: { score: number; comment: string | null }): string {
  const head = role === 'seller' ? `Оценка клиента: ${rating.score} из 5` : `Ваша оценка: ${rating.score} из 5`;
  return rating.comment ? `${head}. «${rating.comment}»` : head;
}
