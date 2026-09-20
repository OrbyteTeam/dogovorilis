// Машина состояний сделки: единственное место, где решается, разрешён ли переход (SPEC §5.2, строки T1–T18).
// Функция чистая — ни БД, ни времени, ни побочных эффектов: вызывающий уже держит строку под `SELECT … FOR UPDATE`,
// а цепочки переходов (T11 → эффекты T14, T14 → T15 при `tax_mode = none`) выполняет domain/deal/service.ts.
// T1 (создание сделки) в таблице отсутствует: у него нет исходного статуса, проверять нечего.
import { InvalidTransition } from '../../errors.js';
import { isTerminal } from '../../types.js';
import type { DealAction, DealStatus, Role, TaxMode } from '../../types.js';

/** Всё, что нужно для решения о переходе. Никаких обращений к БД. */
export type TransitionContext = {
  status: DealStatus;
  /** предоплата и сумма текущей версии, копейки */
  prepaymentKopecks: number;
  totalKopecks: number;
  /** сумма успешных платежей, копейки */
  paidKopecks: number;
  /** налоговый режим исполнителя: влияет на T14 → сразу closed при 'none' */
  taxMode: TaxMode;
  /** клиент уже перешёл по ссылке */
  clientJoined: boolean;
};

export type TransitionVerdict =
  | { ok: true; to: DealStatus }
  | { ok: false; reason: 'forbidden' | 'already_done' | 'client_cancel_locked' };

export type TransitionRule = {
  id: string;              // 'T3', 'T11' и т.д. — номер строки из SPEC §5.2
  from: readonly DealStatus[];
  action: DealAction;
  roles: readonly Role[];
  /** целевой статус; функция, если зависит от сумм/режима */
  to: DealStatus | ((ctx: TransitionContext) => DealStatus);
};

/** Нетерминальные статусы, из которых исполнитель может отменить сделку (T16): `paid` исключён — после полной оплаты только закрытие. */
const SELLER_CANCELLABLE = [
  'awaiting_confirmation',
  'changes_requested',
  'awaiting_prepayment',
  'scheduled',
  'awaiting_acceptance',
  'remarks',
  'awaiting_payment',
] as const satisfies readonly DealStatus[];

/** T18: клиенту отмена запрещена после «Выполнено» — это не общий отказ, а отдельный текст E7. */
const CLIENT_CANCEL_LOCKED = ['awaiting_acceptance', 'remarks', 'awaiting_payment'] as const satisfies readonly DealStatus[];

/** Таблица переходов в декларативном виде — используется тестами и как документация. */
export const TRANSITIONS: readonly TransitionRule[] = [
  // T2: клиент открыл ссылку — статус не меняется, меняются только client_user_id и client_joined_at.
  { id: 'T2', from: ['awaiting_confirmation'], action: 'join', roles: ['client'], to: 'awaiting_confirmation' },
  // T3: «Подтверждаю». Есть предоплата — ждём её, иначе сразу в работу.
  {
    id: 'T3',
    from: ['awaiting_confirmation'],
    action: 'confirm',
    roles: ['client'],
    to: (ctx) => (ctx.prepaymentKopecks > 0 ? 'awaiting_prepayment' : 'scheduled'),
  },
  { id: 'T4', from: ['awaiting_confirmation'], action: 'request_changes', roles: ['client'], to: 'changes_requested' },
  // T5: новая версия условий. §5.2 называет только `changes_requested`, но §7.5 и §7.8 разрешают «Изменить условия»
  // и в `awaiting_confirmation` («после сохранения — T5») — целевой статус там тот же, поэтому оба исходных статуса.
  { id: 'T5', from: ['changes_requested', 'awaiting_confirmation'], action: 'new_version', roles: ['seller'], to: 'awaiting_confirmation' },
  { id: 'T6', from: ['changes_requested'], action: 'keep_as_is', roles: ['seller'], to: 'awaiting_confirmation' },
  { id: 'T7', from: ['awaiting_confirmation'], action: 'decline', roles: ['client'], to: 'declined' },
  { id: 'T8', from: ['awaiting_confirmation', 'changes_requested'], action: 'expire', roles: ['system'], to: 'expired' },
  { id: 'T9', from: ['awaiting_prepayment'], action: 'prepayment_succeeded', roles: ['system'], to: 'scheduled' },
  { id: 'T10', from: ['scheduled'], action: 'done', roles: ['seller'], to: 'awaiting_acceptance' },
  // T11: «Принимаю». Остаток к оплате есть — ждём его, иначе сделка уже оплачена целиком.
  // Даже при taxMode = 'none' целевой статус — 'paid': доведение до 'closed' — отдельный переход T15 в сервисе.
  {
    id: 'T11',
    from: ['awaiting_acceptance'],
    action: 'accept',
    roles: ['client'],
    to: (ctx) => (ctx.totalKopecks - ctx.prepaymentKopecks > 0 ? 'awaiting_payment' : 'paid'),
  },
  { id: 'T12', from: ['awaiting_acceptance'], action: 'remarks', roles: ['client'], to: 'remarks' },
  { id: 'T13', from: ['remarks'], action: 'fixed', roles: ['seller'], to: 'awaiting_acceptance' },
  // T14: остаток оплачен. taxMode здесь сознательно не учитывается — T15 идёт отдельным переходом.
  { id: 'T14', from: ['awaiting_payment'], action: 'final_succeeded', roles: ['system'], to: 'paid' },
  // T15: чек приложен, либо закрытие без чека (исполнителем — по кнопке, системой — когда taxMode = 'none').
  { id: 'T15', from: ['paid'], action: 'attach_receipt', roles: ['seller'], to: 'closed' },
  { id: 'T15', from: ['paid'], action: 'close_without_receipt', roles: ['seller', 'system'], to: 'closed' },
  { id: 'T16', from: SELLER_CANCELLABLE, action: 'cancel', roles: ['seller'], to: 'cancelled' },
  { id: 'T17', from: ['awaiting_prepayment', 'scheduled'], action: 'cancel', roles: ['client'], to: 'cancelled' },
];

function resolveTo(rule: TransitionRule, ctx: TransitionContext): DealStatus {
  return typeof rule.to === 'function' ? rule.to(ctx) : rule.to;
}

/**
 * Идемпотентность (SPEC §5.2, «Конкурентность»): действие уже привело сделку в текущий статус —
 * двойной тап кнопки или повторный вебхук. Роль обязана быть разрешённой: чужая роль — обычный отказ, а не «уже сделано».
 */
function isAlreadyDone(ctx: TransitionContext, action: DealAction, role: Role): boolean {
  return TRANSITIONS.some((r) => r.action === action && r.roles.includes(role) && resolveTo(r, ctx) === ctx.status);
}

function clientCancelLocked(ctx: TransitionContext, action: DealAction, role: Role): boolean {
  return action === 'cancel' && role === 'client' && (CLIENT_CANCEL_LOCKED as readonly DealStatus[]).includes(ctx.status);
}

export function canTransition(ctx: TransitionContext, action: DealAction, role: Role): TransitionVerdict {
  // Из терминальных статусов правил нет вовсе; остаётся отличить повторное нажатие от запрещённого действия.
  if (isTerminal(ctx.status)) {
    return isAlreadyDone(ctx, action, role) ? { ok: false, reason: 'already_done' } : { ok: false, reason: 'forbidden' };
  }

  const rule = TRANSITIONS.find((r) => r.action === action && r.roles.includes(role) && r.from.includes(ctx.status));
  if (rule) return { ok: true, to: resolveTo(rule, ctx) };

  if (clientCancelLocked(ctx, action, role)) return { ok: false, reason: 'client_cancel_locked' };
  if (isAlreadyDone(ctx, action, role)) return { ok: false, reason: 'already_done' };
  return { ok: false, reason: 'forbidden' };
}

/** Бросает InvalidTransition (см. server/src/errors.ts) вместо ok:false. Возвращает целевой статус. */
export function assertTransition(ctx: TransitionContext, action: DealAction, role: Role): DealStatus {
  const verdict = canTransition(ctx, action, role);
  if (!verdict.ok) throw new InvalidTransition(ctx.status, action, role, verdict.reason);
  return verdict.to;
}
