// Правило отмены SPEC §5.3: все 4 значения cancel_rule × кто отменил × граница окна × «без даты» × без предоплаты.
import { describe, expect, it } from 'vitest';
import { cancelRuleAllowsFreeCancel, refundExpected } from '../src/domain/deal/rules.js';
import { HOUR_MS } from '../src/domain/time.js';
import type { CancelRule } from '../src/types.js';

const ALL_RULES = ['free_24h', 'free_48h', 'nonrefundable', 'full_refund'] as const satisfies readonly CancelRule[];

const NOW = new Date('2026-09-20T12:00:00.000Z');
/** Момент через N часов от NOW — «до услуги осталось N часов». */
const inHours = (hours: number) => new Date(NOW.getTime() + hours * HOUR_MS);

type Args = Parameters<typeof refundExpected>[0];
function args(over: Partial<Args> = {}): Args {
  return {
    cancelRule: 'free_24h',
    cancelledBy: 'client',
    scheduledAt: inHours(72),
    prepaymentSucceeded: true,
    now: NOW,
    ...over,
  };
}

describe('предоплата не получена — возврат не обсуждается (null)', () => {
  const combos = ALL_RULES.flatMap((cancelRule) =>
    (['seller', 'client', 'system'] as const).map((cancelledBy) => ({ cancelRule, cancelledBy })),
  );

  it.each(combos)('$cancelRule, отменил $cancelledBy → null', ({ cancelRule, cancelledBy }) => {
    expect(refundExpected(args({ cancelRule, cancelledBy, prepaymentSucceeded: false }))).toBeNull();
    // «Без даты» и просроченная дата ничего не меняют: платежа не было.
    expect(refundExpected(args({ cancelRule, cancelledBy, prepaymentSucceeded: false, scheduledAt: null }))).toBeNull();
    expect(refundExpected(args({ cancelRule, cancelledBy, prepaymentSucceeded: false, scheduledAt: inHours(1) }))).toBeNull();
  });
});

describe('T16: отмена исполнителем — возврат ожидается всегда', () => {
  it.each(ALL_RULES)('%s → true', (cancelRule) => {
    expect(refundExpected(args({ cancelRule, cancelledBy: 'seller' }))).toBe(true);
    expect(refundExpected(args({ cancelRule, cancelledBy: 'seller', scheduledAt: null }))).toBe(true);
    // Даже за час до услуги и даже по «невозвратному» правилу: срок нарушил исполнитель.
    expect(refundExpected(args({ cancelRule, cancelledBy: 'seller', scheduledAt: inHours(1) }))).toBe(true);
  });
});

describe('системная отмена — возврат ожидается всегда', () => {
  it.each(ALL_RULES)('%s → true', (cancelRule) => {
    expect(refundExpected(args({ cancelRule, cancelledBy: 'system' }))).toBe(true);
    expect(refundExpected(args({ cancelRule, cancelledBy: 'system', scheduledAt: inHours(1) }))).toBe(true);
  });
});

describe('T17: отмена клиентом', () => {
  type Case = { rule: CancelRule; label: string; scheduledAt: Date | null; expected: boolean };

  const CASES: readonly Case[] = [
    // free_24h: граница включительна — «за 24 ч и более».
    { rule: 'free_24h', label: 'ровно 24 ч до услуги', scheduledAt: inHours(24), expected: true },
    { rule: 'free_24h', label: 'на миллисекунду меньше 24 ч', scheduledAt: new Date(NOW.getTime() + 24 * HOUR_MS - 1), expected: false },
    { rule: 'free_24h', label: '48 ч до услуги', scheduledAt: inHours(48), expected: true },
    { rule: 'free_24h', label: '23 ч 59 мин до услуги', scheduledAt: new Date(NOW.getTime() + 24 * HOUR_MS - 60_000), expected: false },
    { rule: 'free_24h', label: 'услуга уже прошла', scheduledAt: inHours(-2), expected: false },
    { rule: 'free_24h', label: 'без даты', scheduledAt: null, expected: true },
    // free_48h: то же с 48 ч.
    { rule: 'free_48h', label: 'ровно 48 ч до услуги', scheduledAt: inHours(48), expected: true },
    { rule: 'free_48h', label: 'на миллисекунду меньше 48 ч', scheduledAt: new Date(NOW.getTime() + 48 * HOUR_MS - 1), expected: false },
    { rule: 'free_48h', label: '24 ч до услуги — окна 48 ч не хватает', scheduledAt: inHours(24), expected: false },
    { rule: 'free_48h', label: '72 ч до услуги', scheduledAt: inHours(72), expected: true },
    { rule: 'free_48h', label: 'услуга уже прошла', scheduledAt: inHours(-2), expected: false },
    { rule: 'free_48h', label: 'без даты', scheduledAt: null, expected: true },
    // nonrefundable: возврата нет никогда.
    { rule: 'nonrefundable', label: 'месяц до услуги', scheduledAt: inHours(720), expected: false },
    { rule: 'nonrefundable', label: 'ровно 24 ч до услуги', scheduledAt: inHours(24), expected: false },
    { rule: 'nonrefundable', label: 'ровно 48 ч до услуги', scheduledAt: inHours(48), expected: false },
    { rule: 'nonrefundable', label: 'без даты', scheduledAt: null, expected: false },
    // full_refund: возврат всегда.
    { rule: 'full_refund', label: 'час до услуги', scheduledAt: inHours(1), expected: true },
    { rule: 'full_refund', label: 'услуга уже прошла', scheduledAt: inHours(-2), expected: true },
    { rule: 'full_refund', label: 'без даты', scheduledAt: null, expected: true },
  ];

  it.each(CASES)('$rule, $label → $expected', ({ rule, scheduledAt, expected }) => {
    expect(refundExpected(args({ cancelRule: rule, cancelledBy: 'client', scheduledAt }))).toBe(expected);
    // cancelRuleAllowsFreeCancel — то же решение без учёта факта предоплаты.
    expect(cancelRuleAllowsFreeCancel(rule, scheduledAt, NOW)).toBe(expected);
  });
});
