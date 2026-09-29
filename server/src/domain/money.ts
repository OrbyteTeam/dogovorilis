// Деньги — целые копейки. Форматирование в одном месте.
// Формат по DESIGN_BRIEF §2.3: «1 500 ₽», разряды и знак рубля через неразрывный пробел.
import { ValidationError } from '../errors.js';

const NBSP = ' ';
export const MIN_TOTAL_KOPECKS = 100; // 1 ₽ (CHECK в 0001_init.sql)
export const MAX_TOTAL_KOPECKS = 100_000_000; // 1 000 000 ₽ (SPEC §7.2)

/**
 * «1 500 ₽»: целые рубли, разряды и знак рубля через неразрывный пробел (DESIGN_BRIEF §2.3). Копейки в интерфейсе
 * не показываются: суммы сделок целые, а копейки, если придут от провайдера, округляются до рубля. В БД копейки есть.
 * Отрицательная сумма пишется с типографским минусом: «−1 500 ₽» (хронология и квитанция).
 */
export function formatMoney(kopecks: number): string {
  const sign = kopecks < 0 ? '−' : '';
  const rub = Math.round(Math.abs(kopecks) / 100);
  const groups = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${sign}${groups}${NBSP}₽`;
}

/** «30 %»: процент через неразрывный пробел (DESIGN_BRIEF §2.3). */
export function formatPercent(percent: number): string {
  return `${percent}${NBSP}%`;
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
    throw new ValidationError('Сумма от 1 до 1 000 000 ₽', 'total_rub');
  }
  if (!Number.isInteger(prepaymentKopecks) || prepaymentKopecks < 0 || prepaymentKopecks > totalKopecks) {
    throw new ValidationError('Предоплата от 0 до суммы сделки', 'prepayment_rub');
  }
}
