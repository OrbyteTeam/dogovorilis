// Показатели надёжности исполнителя (ЗАДАЧА_08 E, SPEC §7.11): только из фактов сделок, без публичного рейтинга.
// Чистая функция над строками завершённых сделок — определения показателей живут здесь и покрыты тестами.
import type { Reliability } from '../types.js';
import { receiptDeadline } from './time.js';

export type { Reliability };

/** Одна завершённая (closed / cancelled) не-демо сделка исполнителя — то, что нужно для показателей. */
export type FinishedDealFacts = {
  status: 'closed' | 'cancelled';
  confirmedAt: Date | null;
  doneAt: Date | null;
  paidAt: Date | null;
  closedAt: Date | null;
  cancelledByRole: 'seller' | 'client' | 'system' | null;
  /** был ли «Не вижу перевода» хоть раз */
  transferDisputed: boolean;
  /** чек приложен (время) */
  receiptAt: Date | null;
  /** закрыта сама, потому что исполнитель работает без чека */
  closedWithoutChequeByMode: boolean;
  /** оценка клиента, если есть */
  score: number | null;
};

const percent = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);

export function computeReliability(rows: readonly FinishedDealFacts[], tz: string): Reliability {
  const closed = rows.filter((r) => r.status === 'closed');

  // «Без спора»: считаем сделки, дошедшие до «Выполнено» (закрытые и отменённые после него).
  const afterDone = rows.filter((r) => r.status === 'closed' || r.doneAt !== null);
  const disputed = afterDone.filter((r) => r.transferDisputed || (r.status === 'cancelled' && r.doneAt !== null));

  // «Чек в срок»: закрытые, где чек был нужен (не закрытые сами по режиму «без чека»).
  const needCheque = closed.filter((r) => !r.closedWithoutChequeByMode && r.paidAt !== null);
  const onTime = needCheque.filter((r) => r.receiptAt !== null && r.receiptAt.getTime() <= receiptDeadline(r.paidAt!, tz).getTime());

  // «Отмены исполнителем»: только договорённые (клиент подтвердил) — отказ до подтверждения не про надёжность.
  const agreed = rows.filter((r) => r.confirmedAt !== null);
  const cancelledBySeller = agreed.filter((r) => r.status === 'cancelled' && r.cancelledByRole === 'seller');

  const scores = rows.map((r) => r.score).filter((s): s is number => s !== null);
  const rating = scores.length
    ? { average: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10, count: scores.length }
    : null;

  return {
    closed: closed.length,
    noDisputePercent: percent(afterDone.length - disputed.length, afterDone.length),
    chequeOnTimePercent: percent(onTime.length, needCheque.length),
    sellerCancelPercent: percent(cancelledBySeller.length, agreed.length),
    rating,
  };
}

/** Строка в карточке клиента показывается, когда закрытых сделок хотя бы столько: «1 сделка, 100 %» ничего не говорит. */
export const RELIABILITY_MIN_CLOSED = 3;
