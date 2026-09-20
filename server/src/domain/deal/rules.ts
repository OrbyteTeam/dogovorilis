// Правило отмены и ожидание возврата предоплаты (SPEC §5.3). Сам возврат денег продукт не выполняет [модель] —
// здесь считается только `deals.cancel_refund_expected`, из которого берётся строка в карточке.
import { HOUR_MS } from '../time.js';
import type { CancelRule } from '../../types.js';

/** Сколько часов до услуги отмена считается бесплатной. Для правил без окна — null. */
const FREE_WINDOW_HOURS: Record<CancelRule, number | null> = {
  free_24h: 24,
  free_48h: 48,
  nonrefundable: null,
  full_refund: null,
};

/**
 * Попадает ли отмена клиентом в бесплатное окно правила.
 * «Без даты» трактуется в пользу клиента: срок нарушить нельзя, если срока нет.
 */
export function cancelRuleAllowsFreeCancel(rule: CancelRule, scheduledAt: Date | null, now: Date): boolean {
  if (rule === 'full_refund') return true;
  if (rule === 'nonrefundable') return false;
  const hours = FREE_WINDOW_HOURS[rule];
  if (hours === null) return false;
  if (scheduledAt === null) return true;
  // Граница включительна: «за 24 ч и более» — это ровно 24 ч тоже.
  return scheduledAt.getTime() - now.getTime() >= hours * HOUR_MS;
}

/**
 * Ожидается ли возврат предоплаты при отмене.
 * null — предоплата не была получена (в карточке про возврат ничего не пишем).
 */
export function refundExpected(args: {
  cancelRule: CancelRule;
  cancelledBy: 'seller' | 'client' | 'system';
  /** дата/время оказания услуги; null = «без даты» */
  scheduledAt: Date | null;
  /** предоплата получена (есть succeeded-платёж kind=prepayment) */
  prepaymentSucceeded: boolean;
  now: Date;
}): boolean | null {
  if (!args.prepaymentSucceeded) return null;
  // T16 и системная отмена: клиент услугу не получил и срок не нарушал — возврат ожидается всегда.
  if (args.cancelledBy !== 'client') return true;
  return cancelRuleAllowsFreeCancel(args.cancelRule, args.scheduledAt, args.now);
}
