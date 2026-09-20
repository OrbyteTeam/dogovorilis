// Таблица SPEC §5.2 строка за строкой: разрешённые переходы, запрещённые, идемпотентность.
import { describe, expect, it } from 'vitest';
import { InvalidTransition } from '../src/errors.js';
import { assertTransition, canTransition, TRANSITIONS } from '../src/domain/deal/state-machine.js';
import type { TransitionContext } from '../src/domain/deal/state-machine.js';
import { TERMINAL_STATUSES } from '../src/types.js';
import type { DealAction, DealStatus, Role } from '../src/types.js';

/** Все действия из types.ts — чтобы перебор по терминальным статусам был полным. */
const ALL_ACTIONS = [
  'join',
  'confirm',
  'request_changes',
  'new_version',
  'keep_as_is',
  'decline',
  'expire',
  'prepayment_succeeded',
  'done',
  'accept',
  'remarks',
  'fixed',
  'final_succeeded',
  'attach_receipt',
  'close_without_receipt',
  'cancel',
] as const satisfies readonly DealAction[];

const ALL_ROLES = ['seller', 'client', 'system'] as const satisfies readonly Role[];

/** Перехват исключения: в vitest-матчерах нужен сам объект ошибки, а не только факт броска. */
function catchTransitionError(fn: () => unknown): InvalidTransition {
  try {
    fn();
  } catch (e) {
    return e as InvalidTransition;
  }
  throw new Error('ожидалось исключение InvalidTransition');
}

/** Сделка 2000 ₽ с предоплатой 500 ₽: есть и предоплата, и остаток — обе ветки T3/T11 ненулевые. */
function ctx(status: DealStatus, over: Partial<TransitionContext> = {}): TransitionContext {
  return {
    status,
    prepaymentKopecks: 50_000,
    totalKopecks: 200_000,
    paidKopecks: 0,
    taxMode: 'npd',
    clientJoined: true,
    ...over,
  };
}

type Case = {
  id: string;
  label: string;
  from: DealStatus;
  action: DealAction;
  role: Role;
  to: DealStatus;
  over?: Partial<TransitionContext>;
};

const ALLOWED: readonly Case[] = [
  { id: 'T2', label: 'клиент открыл ссылку — статус не меняется', from: 'awaiting_confirmation', action: 'join', role: 'client', to: 'awaiting_confirmation' },
  { id: 'T3', label: '«Подтверждаю» с предоплатой', from: 'awaiting_confirmation', action: 'confirm', role: 'client', to: 'awaiting_prepayment' },
  { id: 'T3', label: '«Подтверждаю» без предоплаты', from: 'awaiting_confirmation', action: 'confirm', role: 'client', to: 'scheduled', over: { prepaymentKopecks: 0 } },
  { id: 'T4', label: '«Предложить изменения»', from: 'awaiting_confirmation', action: 'request_changes', role: 'client', to: 'changes_requested' },
  { id: 'T5', label: 'новая версия условий из changes_requested', from: 'changes_requested', action: 'new_version', role: 'seller', to: 'awaiting_confirmation' },
  // §7.5: «Изменить условия» доступно и в awaiting_confirmation, после сохранения — тоже T5.
  { id: 'T5', label: 'новая версия условий из awaiting_confirmation', from: 'awaiting_confirmation', action: 'new_version', role: 'seller', to: 'awaiting_confirmation' },
  { id: 'T6', label: '«Оставить как есть»', from: 'changes_requested', action: 'keep_as_is', role: 'seller', to: 'awaiting_confirmation' },
  { id: 'T7', label: '«Отказаться»', from: 'awaiting_confirmation', action: 'decline', role: 'client', to: 'declined' },
  { id: 'T8', label: 'таймер 72 ч из awaiting_confirmation', from: 'awaiting_confirmation', action: 'expire', role: 'system', to: 'expired' },
  { id: 'T8', label: 'таймер 72 ч из changes_requested', from: 'changes_requested', action: 'expire', role: 'system', to: 'expired' },
  { id: 'T9', label: 'предоплата succeeded', from: 'awaiting_prepayment', action: 'prepayment_succeeded', role: 'system', to: 'scheduled' },
  { id: 'T10', label: '«Выполнено»', from: 'scheduled', action: 'done', role: 'seller', to: 'awaiting_acceptance' },
  { id: 'T11', label: '«Принимаю», остаток есть', from: 'awaiting_acceptance', action: 'accept', role: 'client', to: 'awaiting_payment' },
  { id: 'T11', label: '«Принимаю», остатка нет (предоплата = сумма)', from: 'awaiting_acceptance', action: 'accept', role: 'client', to: 'paid', over: { prepaymentKopecks: 200_000, paidKopecks: 200_000 } },
  { id: 'T12', label: '«Есть замечания»', from: 'awaiting_acceptance', action: 'remarks', role: 'client', to: 'remarks' },
  { id: 'T13', label: '«Исправлено, проверьте»', from: 'remarks', action: 'fixed', role: 'seller', to: 'awaiting_acceptance' },
  { id: 'T14', label: 'остаток succeeded', from: 'awaiting_payment', action: 'final_succeeded', role: 'system', to: 'paid' },
  { id: 'T14', label: 'остаток succeeded при taxMode=none — всё равно paid, closed делает T15', from: 'awaiting_payment', action: 'final_succeeded', role: 'system', to: 'paid', over: { taxMode: 'none' } },
  { id: 'T15', label: 'чек приложен', from: 'paid', action: 'attach_receipt', role: 'seller', to: 'closed' },
  { id: 'T15', label: '«Закрыть без чека» исполнителем', from: 'paid', action: 'close_without_receipt', role: 'seller', to: 'closed' },
  { id: 'T15', label: 'автозакрытие системой при taxMode=none', from: 'paid', action: 'close_without_receipt', role: 'system', to: 'closed', over: { taxMode: 'none' } },
  // T16 — отмена исполнителем из каждого нетерминального статуса, кроме paid.
  { id: 'T16', label: 'отмена исполнителем из awaiting_confirmation', from: 'awaiting_confirmation', action: 'cancel', role: 'seller', to: 'cancelled' },
  { id: 'T16', label: 'отмена исполнителем из changes_requested', from: 'changes_requested', action: 'cancel', role: 'seller', to: 'cancelled' },
  { id: 'T16', label: 'отмена исполнителем из awaiting_prepayment', from: 'awaiting_prepayment', action: 'cancel', role: 'seller', to: 'cancelled' },
  { id: 'T16', label: 'отмена исполнителем из scheduled', from: 'scheduled', action: 'cancel', role: 'seller', to: 'cancelled' },
  { id: 'T16', label: 'отмена исполнителем из awaiting_acceptance', from: 'awaiting_acceptance', action: 'cancel', role: 'seller', to: 'cancelled' },
  { id: 'T16', label: 'отмена исполнителем из remarks', from: 'remarks', action: 'cancel', role: 'seller', to: 'cancelled' },
  { id: 'T16', label: 'отмена исполнителем из awaiting_payment', from: 'awaiting_payment', action: 'cancel', role: 'seller', to: 'cancelled' },
  { id: 'T17', label: 'отмена клиентом из awaiting_prepayment', from: 'awaiting_prepayment', action: 'cancel', role: 'client', to: 'cancelled' },
  { id: 'T17', label: 'отмена клиентом из scheduled', from: 'scheduled', action: 'cancel', role: 'client', to: 'cancelled' },
];

/** Строки таблицы SPEC §5.2, у которых есть исходный статус (T1 — создание сделки, T18 — запрет). */
const SPEC_ROWS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17'];

describe('SPEC §5.2: разрешённые переходы', () => {
  it.each(ALLOWED)('$id: $label → $to', (c) => {
    expect(canTransition(ctx(c.from, c.over), c.action, c.role)).toEqual({ ok: true, to: c.to });
    expect(assertTransition(ctx(c.from, c.over), c.action, c.role)).toBe(c.to);
  });

  it('таблица TRANSITIONS содержит каждую строку T2–T17', () => {
    const ids = new Set(TRANSITIONS.map((r) => r.id));
    expect(SPEC_ROWS.filter((id) => !ids.has(id))).toEqual([]);
  });

  it('каждая строка T2–T17 проверена выше', () => {
    const covered = new Set(ALLOWED.map((c) => c.id));
    expect(SPEC_ROWS.filter((id) => !covered.has(id))).toEqual([]);
  });

  it('в таблице нет правил с терминальным исходным статусом', () => {
    const bad = TRANSITIONS.filter((r) => r.from.some((s) => (TERMINAL_STATUSES as readonly DealStatus[]).includes(s)));
    expect(bad).toEqual([]);
  });
});

describe('T18: клиент не может отменить после «Выполнено» (текст E7)', () => {
  it.each(['awaiting_acceptance', 'remarks', 'awaiting_payment'] as const)('T18: отмена клиентом из %s заблокирована', (status) => {
    expect(canTransition(ctx(status), 'cancel', 'client')).toEqual({ ok: false, reason: 'client_cancel_locked' });
  });

  it('T18: assertTransition бросает InvalidTransition с кодом client_cancel_locked', () => {
    const e = catchTransitionError(() => assertTransition(ctx('awaiting_payment'), 'cancel', 'client'));
    expect(e).toBeInstanceOf(InvalidTransition);
    expect(e.reason).toBe('client_cancel_locked');
    expect(e.code).toBe('client_cancel_locked');
  });
});

describe('запрещённые переходы', () => {
  const terminalCases = TERMINAL_STATUSES.flatMap((status) =>
    ALL_ACTIONS.flatMap((action) => ALL_ROLES.map((role) => ({ status, action, role }))),
  );

  it.each(terminalCases)('терминальный $status: $action ($role) запрещён', ({ status, action, role }) => {
    const verdict = canTransition(ctx(status), action, role);
    expect(verdict.ok).toBe(false);
  });

  // В терминальном статусе «уже сделано» допустимо только для действия, которое в этот статус и привело.
  it.each([
    { status: 'declined', action: 'confirm', role: 'client' },
    { status: 'declined', action: 'cancel', role: 'seller' },
    { status: 'expired', action: 'done', role: 'seller' },
    { status: 'closed', action: 'accept', role: 'client' },
    { status: 'closed', action: 'final_succeeded', role: 'system' },
    { status: 'cancelled', action: 'prepayment_succeeded', role: 'system' },
  ] as const)('терминальный $status: $action ($role) — именно forbidden', ({ status, action, role }) => {
    expect(canTransition(ctx(status), action, role)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it.each([
    { label: 'confirm исполнителем', status: 'awaiting_confirmation', action: 'confirm', role: 'seller' },
    { label: 'join исполнителем', status: 'awaiting_confirmation', action: 'join', role: 'seller' },
    { label: 'expire исполнителем (только system)', status: 'awaiting_confirmation', action: 'expire', role: 'seller' },
    { label: 'decline исполнителем', status: 'awaiting_confirmation', action: 'decline', role: 'seller' },
    { label: 'done клиентом', status: 'scheduled', action: 'done', role: 'client' },
    { label: 'accept исполнителем', status: 'awaiting_acceptance', action: 'accept', role: 'seller' },
    { label: 'prepayment_succeeded клиентом (только system)', status: 'awaiting_prepayment', action: 'prepayment_succeeded', role: 'client' },
    { label: 'keep_as_is клиентом', status: 'changes_requested', action: 'keep_as_is', role: 'client' },
    { label: 'new_version клиентом', status: 'changes_requested', action: 'new_version', role: 'client' },
    { label: 'attach_receipt клиентом', status: 'paid', action: 'attach_receipt', role: 'client' },
  ] as const)('чужая роль: $label', ({ status, action, role }) => {
    expect(canTransition(ctx(status), action, role)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('T16: отмена исполнителем из paid запрещена — после полной оплаты только закрытие', () => {
    expect(canTransition(ctx('paid'), 'cancel', 'seller')).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('отмена клиентом из paid запрещена и не подпадает под E7', () => {
    expect(canTransition(ctx('paid'), 'cancel', 'client')).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('assertTransition бросает InvalidTransition с кодом invalid_transition', () => {
    const e = catchTransitionError(() => assertTransition(ctx('scheduled'), 'done', 'client'));
    expect(e).toBeInstanceOf(InvalidTransition);
    expect(e.reason).toBe('forbidden');
    expect(e.code).toBe('invalid_transition');
    expect(e.status).toBe('scheduled');
    expect(e.action).toBe('done');
    expect(e.role).toBe('client');
  });
});

describe('идемпотентность (SPEC §5.2, «Конкурентность»)', () => {
  type RepeatCase = { label: string; status: DealStatus; action: DealAction; role: Role; over?: Partial<TransitionContext> };

  const REPEATS: readonly RepeatCase[] = [
    { label: 'двойной тап «Подтверждаю» при awaiting_prepayment', status: 'awaiting_prepayment', action: 'confirm', role: 'client' },
    { label: 'двойной тап «Подтверждаю» без предоплаты при scheduled', status: 'scheduled', action: 'confirm', role: 'client', over: { prepaymentKopecks: 0 } },
    { label: 'повторный вебхук предоплаты при scheduled', status: 'scheduled', action: 'prepayment_succeeded', role: 'system' },
    { label: 'повторное «Выполнено» при awaiting_acceptance', status: 'awaiting_acceptance', action: 'done', role: 'seller' },
    { label: 'повторный вебхук остатка при paid', status: 'paid', action: 'final_succeeded', role: 'system' },
    { label: 'повторное «Принимаю» при awaiting_payment', status: 'awaiting_payment', action: 'accept', role: 'client' },
    { label: 'повторное закрытие при closed', status: 'closed', action: 'close_without_receipt', role: 'seller' },
    { label: 'повторный чек при closed', status: 'closed', action: 'attach_receipt', role: 'seller' },
    { label: 'повторная отмена при cancelled (исполнитель)', status: 'cancelled', action: 'cancel', role: 'seller' },
    { label: 'повторная отмена при cancelled (клиент)', status: 'cancelled', action: 'cancel', role: 'client' },
    { label: 'повторный таймер при expired', status: 'expired', action: 'expire', role: 'system' },
    { label: 'повторный отказ при declined', status: 'declined', action: 'decline', role: 'client' },
  ];

  it.each(REPEATS)('already_done: $label', (c) => {
    expect(canTransition(ctx(c.status, c.over), c.action, c.role)).toEqual({ ok: false, reason: 'already_done' });
  });

  it('already_done не выдаётся чужой роли: confirm исполнителем при awaiting_prepayment', () => {
    expect(canTransition(ctx('awaiting_prepayment'), 'confirm', 'seller')).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('assertTransition бросает InvalidTransition с причиной already_done', () => {
    const e = catchTransitionError(() => assertTransition(ctx('awaiting_acceptance'), 'done', 'seller'));
    expect(e.reason).toBe('already_done');
  });
});
