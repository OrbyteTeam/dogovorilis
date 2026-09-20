// Деньги — целые копейки. Форматирование в одном месте.
// Формат по SPEC §6: «1 500 ₽» с неразрывным пробелом между разрядами.
import { ValidationError } from '../errors.js';

const NBSP = ' ';
export const MIN_TOTAL_KOPECKS = 100; // 1 ₽ (CHECK в 0001_init.sql)
export const MAX_TOTAL_KOPECKS = 100_000_000; // 1 000 000 ₽ (SPEC §7.2)

/** «1 500 ₽», «1 500,50 ₽» — копейки показываем только если они есть. */
export function formatMoney(kopecks: number): string {
  const sign = kopecks < 0 ? '−' : '';
  const abs = Math.abs(Math.round(kopecks));
  const rub = Math.trunc(abs / 100);
  const kop = abs % 100;
  const groups = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const tail = kop === 0 ? '' : ',' + String(kop).padStart(2, '0');
  return `${sign}${groups}${tail}${NBSP}₽`;
}

export function rublesToKopecks(rubles: number): number {
  return Math.round(rubles * 100);
}

export function kopecksToRubles(kopecks: number): number {
  return kopecks / 100;
}

/** «30 %» от суммы, округление до рубля вверх (SPEC §7.2). */
export function percentOfTotal(totalKopecks: number, percent: number): number {
  return Math.ceil((totalKopecks * percent) / 100 / 100) * 100;
}

/** Доля предоплаты в процентах для строки карточки «предоплата 500 ₽ (20 %)». */
export function prepaymentPercent(totalKopecks: number, prepaymentKopecks: number): number {
  if (totalKopecks <= 0) return 0;
  return Math.round((prepaymentKopecks / totalKopecks) * 100);
}

/** Валидация суммы и предоплаты по SPEC §7.2. Бросает ValidationError с текстом для поля. */
export function assertAmounts(totalKopecks: number, prepaymentKopecks: number): void {
  if (!Number.isInteger(totalKopecks) || totalKopecks < MIN_TOTAL_KOPECKS || totalKopecks > MAX_TOTAL_KOPECKS) {
    throw new ValidationError('Сумма — от 1 до 1 000 000 ₽', 'total_rub');
  }
  if (!Number.isInteger(prepaymentKopecks) || prepaymentKopecks < 0 || prepaymentKopecks > totalKopecks) {
    throw new ValidationError('Предоплата — от 0 до суммы сделки', 'prepayment_rub');
  }
}
