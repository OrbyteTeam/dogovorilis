// Типизированные ошибки. Пользовательские тексты — только в texts.ts (SPEC §6.7),
// здесь — машинные коды, по которым транспорт выбирает текст.
import type { DealAction, DealStatus, Role } from './types.js';

/** Код, по которому транспорт выбирает текст ошибки из texts.ts. */
export type AppErrorCode =
  | 'invalid_transition'   // E1
  | 'client_cancel_locked' // E7
  | 'rail_unavailable'     // E11
  | 'payout_details_empty' // E12
  | 'claim_too_soon'       // E13
  | 'provider_failed'      // E9
  | 'link_in_progress'     // «Ссылка формируется» — двойной тап «Оплатить по ссылке»
  | 'input_expired'        // E8
  | 'input_too_long'       // E5
  | 'input_not_a_file'     // E6
  | 'deal_not_found'       // E2
  | 'other_client'         // E3
  | 'demo_deal'            // E4
  | 'init_data_invalid'   // 401 из мини-приложения
  | 'phone_hash_invalid'
  | 'forbidden'
  | 'validation'
  | 'rate_limited'
  | 'trial_limit'          // «Слишком много пробных сделок» (сделка-пример и демо из чата)
  | 'internal';            // E10

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Запрещённый переход (SPEC §5.2, «всё остальное»): в ответ — E1 и перерисованная карточка. */
export class InvalidTransition extends AppError {
  constructor(
    readonly status: DealStatus,
    readonly action: DealAction,
    readonly role: Role,
    readonly reason: 'forbidden' | 'already_done' | 'client_cancel_locked' | 'not_participant' = 'forbidden',
  ) {
    super(
      reason === 'client_cancel_locked' ? 'client_cancel_locked' : 'invalid_transition',
      `переход запрещён: ${status} + ${action} (${role}), причина ${reason}`,
      { status, action, role, reason },
    );
    this.name = 'InvalidTransition';
  }
}

/** Рейл «ссылка» недоступен: провайдер не подключён (ЗАДАЧА_01) или выключен исполнителем. */
export class RailUnavailable extends AppError {
  constructor(readonly rail: 'link' | 'transfer', reason: string) {
    super(rail === 'link' ? 'rail_unavailable' : 'payout_details_empty', `рейл ${rail} недоступен: ${reason}`, { rail, reason });
    this.name = 'RailUnavailable';
  }
}

/**
 * Ссылка на оплату этого вида уже создаётся у провайдера: первый тап «Оплатить по ссылке» ещё ждёт ответа.
 * Второй платёж создавать нельзя — у провайдера появились бы две ссылки на одну сумму (ЗАДАЧА_03 F3).
 */
export class LinkInProgressError extends AppError {
  constructor() {
    super('link_in_progress', 'ссылка на оплату ещё создаётся у провайдера');
    this.name = 'LinkInProgressError';
  }
}

/** Ошибка внешней интеграции (SPEC §6.7 E9). */
export class IntegrationError extends AppError {
  constructor(
    readonly provider: string,
    readonly op: string,
    readonly status: number | null,
    readonly providerCode: string | null,
    message: string,
  ) {
    super('provider_failed', `${provider}.${op}: ${message}`, { provider, op, status, code: providerCode });
    this.name = 'IntegrationError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, readonly field?: string) {
    super('validation', message, { field });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super('deal_not_found', `не найдено: ${what}`);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'нет доступа') {
    super('forbidden', message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Нажатие кнопки чужой сделки: пользователь не исполнитель и не клиент (ЗАДАЧА_03 G1). Отдельный класс,
 * потому что ответ на него особый: только текст «Это не ваша сделка», без карточки и без её кнопок.
 */
export class NotYourDealError extends ForbiddenError {
  constructor() {
    super('not_your_deal');
    this.name = 'NotYourDealError';
  }
}

/** Невалидный или устаревший initData мини-приложения (SPEC §9.4) → HTTP 401. */
export class UnauthorizedError extends AppError {
  constructor(message: string, code: 'init_data_invalid' | 'phone_hash_invalid' = 'init_data_invalid') {
    super(code, message);
    this.name = 'UnauthorizedError';
  }
}

/** Больше TRIAL_LIMIT_PER_HOUR пробных сделок (пример или демо) за час от одного пользователя. */
export class TrialLimitError extends AppError {
  constructor(readonly trial: 'example' | 'demo') {
    super('trial_limit', `лимит пробных сделок «${trial}» за час исчерпан`);
    this.name = 'TrialLimitError';
  }
}
