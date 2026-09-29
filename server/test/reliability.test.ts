// Показатели надёжности исполнителя (ЗАДАЧА_08 E, SPEC §7.11) — определения на фактах сделок.
import { describe, expect, it } from 'vitest';
import { computeReliability, type FinishedDealFacts } from '../src/domain/reliability.js';

const TZ = 'Europe/Moscow';
const d = (iso: string) => new Date(iso);
const base: FinishedDealFacts = {
  status: 'closed',
  confirmedAt: d('2026-09-01T09:00:00Z'),
  doneAt: d('2026-09-02T09:00:00Z'),
  paidAt: d('2026-09-02T10:00:00Z'),
  closedAt: d('2026-09-03T10:00:00Z'),
  cancelledByRole: null,
  transferDisputed: false,
  receiptAt: d('2026-09-03T10:00:00Z'),
  closedWithoutChequeByMode: false,
  score: null,
};
const row = (over: Partial<FinishedDealFacts>): FinishedDealFacts => ({ ...base, ...over });

describe('показатели надёжности', () => {
  it('нет сделок — ничего не утверждаем', () => {
    expect(computeReliability([], TZ)).toEqual({ closed: 0, noDisputePercent: null, chequeOnTimePercent: null, sellerCancelPercent: null, rating: null });
  });

  it('закрытые без спора, со спором по переводу, отмена после «Выполнено»', () => {
    const r = computeReliability(
      [
        row({}),
        row({}),
        row({ transferDisputed: true }),
        row({ status: 'cancelled', cancelledByRole: 'client', closedAt: null, paidAt: null, receiptAt: null }), // после «Выполнено»
        row({ status: 'cancelled', cancelledByRole: 'seller', doneAt: null, closedAt: null, paidAt: null, receiptAt: null }), // до
      ],
      TZ,
    );
    expect(r.closed).toBe(3);
    expect(r.noDisputePercent).toBe(50); // 4 дошли до «Выполнено», 2 без спора
    expect(r.sellerCancelPercent).toBe(20); // 1 из 5 договорённых
  });

  it('чек в срок: до 9-го числа месяца после оплаты; «без чека» по режиму не считается; закрытие без чека — не в срок', () => {
    const r = computeReliability(
      [
        row({ paidAt: d('2026-09-20T10:00:00Z'), receiptAt: d('2026-10-09T20:00:00Z') }), // 9 окт 23:00 МСК — в срок
        row({ paidAt: d('2026-09-20T10:00:00Z'), receiptAt: d('2026-10-09T21:30:00Z') }), // 10 окт 00:30 МСК — поздно
        row({ receiptAt: null }), // закрыта без чека вручную
        row({ receiptAt: null, closedWithoutChequeByMode: true }), // режим «без чека» — не учитывается
      ],
      TZ,
    );
    expect(r.chequeOnTimePercent).toBe(33);
  });

  it('отказ клиента до подтверждения не считается отменой исполнителя; оценка — среднее до десятых', () => {
    const r = computeReliability(
      [
        row({ score: 5 }),
        row({ score: 4 }),
        row({ score: 4 }),
        row({ status: 'cancelled', confirmedAt: null, doneAt: null, cancelledByRole: 'seller', paidAt: null, receiptAt: null }),
      ],
      TZ,
    );
    expect(r.sellerCancelPercent).toBe(0);
    expect(r.rating).toEqual({ average: 4.3, count: 3 });
  });
});
