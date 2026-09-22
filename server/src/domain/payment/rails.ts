// Рейл «ссылка» (SPEC §9.1 п. 1–4, §9.2, §10.3). Здесь живёт вся логика ссылочного платежа:
// создание у провайдера, единая идемпотентная реакция на его статус и истечение срока.
//
// Слои: этот модуль — единственный, кто вызывает integrations/yookassa.
// Переход сделки (T9/T14) делает domain/deal/service.ts — здесь только деньги.
import { cfg } from '../../config.js';
import { inTx, type DbClient } from '../../db/pool.js';
import * as dealsRepo from '../../db/repos/deals.js';
import * as eventsRepo from '../../db/repos/events.js';
import * as paymentsRepo from '../../db/repos/payments.js';
import * as usersRepo from '../../db/repos/users.js';
import * as versionsRepo from '../../db/repos/versions.js';
import {
  ForbiddenError,
  IntegrationError,
  InvalidTransition,
  LinkInProgressError,
  NotFoundError,
  RailUnavailable,
} from '../../errors.js';
import {
  createYooKassaClient,
  MIN_AMOUNT_KOPECKS,
  type YooKassaClient,
  type YooKassaPayment,
} from '../../integrations/yookassa/client.js';
import { log } from '../../logger.js';
import type { Deal, DealVersion, Payment, PaymentKind, SellerProfile } from '../../types.js';
import * as dealService from '../deal/service.js';
import { actorRoleFor, type Actor, type ServiceResult } from '../deal/service.js';
import { newIdempotenceKey } from '../ids.js';
import { HOUR_MS } from '../time.js';
import { expectedPayment, type PaymentContext } from './service.js';

/** Срок жизни confirmation_url у ЮKassa для карты — 1 час (CONTRACTS §2.3 «Срок оплаты»). */
export const LINK_TTL_MS = HOUR_MS;

/** Заголовок в описании платежа: SPEC §9.2 — «Сделка #<id>: <title до 100 симв.>». */
export const TITLE_IN_DESCRIPTION_MAX = 100;

/**
 * Сколько ждём ответа провайдера на создание ссылки, прежде чем счесть попытку сбойной.
 * Таймаут клиента ЮKassa — 10 с плюс один повтор (SPEC §9.2), то есть живой запрос укладывается в ~21 с;
 * 30 с — с запасом. Старше и без confirmation_url — процесс упал между шагами, слот можно освобождать.
 */
export const LINK_CREATION_GRACE_MS = 30_000;

/** Ссылочный платёж занял слот, но ответа провайдера (confirmation_url) ещё нет и ждать его ещё разумно. */
export function isLinkInProgress(p: Payment, now: Date): boolean {
  return (
    p.rail === 'link' &&
    p.status === 'pending' &&
    p.confirmationUrl === null &&
    now.getTime() - p.createdAt.getTime() < LINK_CREATION_GRACE_MS
  );
}

/**
 * Результат применения статуса провайдера. `changed` отличает первое применение от повтора:
 * вебхук, опрос и кнопка «Проверить оплату» приходят к одной и той же функции (SPEC §9.1 п. 3).
 */
export type ApplyResult = {
  payment: Payment;
  changed: boolean;
  /** Переход сделки, если он произошёл именно сейчас (T9 или T14). */
  transition: ServiceResult | null;
};

/** Нормализованный ответ провайдера — чтобы Т-Банк подключался тем же путём (ЗАДАЧА_03). */
export type ProviderOutcome = {
  status: 'pending' | 'succeeded' | 'canceled';
  /** Статус провайдера как есть: 'succeeded', 'waiting_for_capture', 'CONFIRMED' … */
  providerStatus: string;
  /** cancellation_details.reason — показывается в карточке (SPEC §9.2). */
  cancellationReason: string | null;
  raw: unknown;
};

// ─────────────────────────── провайдер ───────────────────────────

let client: YooKassaClient | null = null;

/** Ленивая инициализация: конфиг читается после setConfig(), а модуль импортируется раньше. */
export function yookassa(): YooKassaClient {
  const c = cfg();
  if (!client) {
    client = createYooKassaClient({ credentials: { shopId: c.YOOKASSA_SHOP_ID, secretKey: c.YOOKASSA_SECRET_KEY } });
  }
  return client;
}

/** Подмена клиента в тестах (без сети) и сброс между кейсами. */
export function setYooKassaClient(c: YooKassaClient | null): void {
  client = c;
}

/** Ответ ЮKassa → нормализованный исход. Маппинг дословно по SPEC §9.2. */
export function outcomeOf(p: YooKassaPayment): ProviderOutcome {
  const status = p.status === 'succeeded' ? 'succeeded' : p.status === 'canceled' ? 'canceled' : 'pending';
  return {
    status,
    providerStatus: p.status,
    cancellationReason: p.cancellation_details?.reason ?? null,
    raw: p,
  };
}

// ─────────────────────────── доступность рейла ───────────────────────────

/** SPEC §9.1: кнопка «Оплатить по ссылке» видна, если провайдер подключён, рейл включён и сумма ≥ минимума. */
export function linkRailAvailable(profile: SellerProfile | null, amountKopecks: number): boolean {
  if (cfg().PAYMENT_PROVIDER === 'none') return false;
  if (profile?.linkEnabled === false) return false;
  return amountKopecks >= MIN_AMOUNT_KOPECKS;
}

// ─────────────────────────── создание ссылки ───────────────────────────

/**
 * Клиент нажал «💳 Оплатить по ссылке».
 *
 * Идемпотентность: живой ссылочный платёж этого вида переиспользуется, пока не истёк.
 * Смена рейла (§9.1): живой перевод локально отменяется и создаётся ссылочный платёж.
 * `renew = true` (кнопка «🆕 Новая ссылка») принудительно закрывает старый и делает новый ключ.
 */
export async function createLinkPayment(
  publicId: string,
  actor: Actor,
  opts: { renew?: boolean } = {},
  now = new Date(),
): Promise<{ ctx: PaymentContext; created: boolean }> {
  if (cfg().PAYMENT_PROVIDER === 'none') {
    throw new RailUnavailable('link', 'провайдер оплаты по ссылке не подключён (PAYMENT_PROVIDER=none)');
  }

  // Шаг 1 (в транзакции): решить, нужен ли новый платёж, и если да — занять слот «живого» платежа.
  const prepared = await inTx(async (c) => {
    const { deal, version } = await lockDeal(c, publicId, actor);
    const expected = expectedPayment(deal, version);
    if (!expected) throw new InvalidTransition(deal.status, 'prepayment_succeeded', actor.role, 'forbidden');

    const profile = await usersRepo.getProfile(c, deal.sellerUserId);
    if (!linkRailAvailable(profile, expected.amountKopecks)) {
      throw new RailUnavailable('link', 'оплата по ссылке выключена исполнителем или сумма меньше минимума провайдера');
    }

    const live = await paymentsRepo.live(c, deal.id, expected.kind);
    if (live) {
      // Оплачено — второй платёж того же вида создавать нечего.
      if (live.status === 'succeeded') return { step: 'reuse', deal, version, payment: live } as const;
      // Первый тап ещё ждёт ответа провайдера (платёж уже занял слот, а ссылки пока нет). Второй платёж
      // у провайдера здесь не создаём: две ссылки на одну сумму — это риск двойной оплаты. Строка сделки
      // заблокирована, поэтому параллельные тапы проходят эту проверку строго по очереди.
      if (isLinkInProgress(live, now)) throw new LinkInProgressError();
      // Ссылка ещё жива и клиент не просил новую — отдаём ту же (идемпотентность двойного нажатия).
      const usable =
        live.rail === 'link' &&
        live.status === 'pending' &&
        live.confirmationUrl !== null &&
        (live.expiresAt === null || live.expiresAt.getTime() > now.getTime());
      if (usable && !opts.renew) return { step: 'reuse', deal, version, payment: live } as const;
    }

    if (live) {
      // Старая ссылка истекла / клиент передумал / нажал «Новая ссылка» / создание зависло дольше
      // LINK_CREATION_GRACE_MS (процесс упал между шагами): у провайдера она догорит сама.
      await paymentsRepo.update(c, live.id, {
        status: live.expiresAt && live.expiresAt.getTime() <= now.getTime() ? 'expired' : 'canceled',
        canceledAt: now,
      });
      await eventsRepo.append(c, {
        dealId: deal.id,
        type: 'payment.canceled',
        actorUserId: actor.userId,
        actorRole: actorRoleFor(deal, actor),
        payload: {
          payment_id: live.id,
          reason: live.rail !== 'link' ? 'rail_switch' : live.confirmationUrl === null ? 'link_creation_stale' : 'link_renewed',
        },
      });
    }

    const payment = await paymentsRepo.create(c, {
      dealId: deal.id,
      kind: expected.kind,
      rail: 'link',
      provider: 'yookassa',
      amountKopecks: expected.amountKopecks,
      idempotenceKey: newIdempotenceKey(),
      expiresAt: new Date(now.getTime() + LINK_TTL_MS),
    });
    await eventsRepo.append(c, {
      dealId: deal.id,
      type: 'payment.created',
      actorUserId: actor.userId,
      actorRole: actorRoleFor(deal, actor),
      payload: { payment_id: payment.id, kind: expected.kind, rail: 'link', amount: expected.amountKopecks },
    });
    return { step: 'fresh', deal, version, payment } as const;
  });

  if (prepared.step === 'reuse') {
    return { ctx: { deal: prepared.deal, version: prepared.version, payment: prepared.payment }, created: false };
  }

  // Шаг 2 (вне транзакции): поход к провайдеру. Держать транзакцию открытой на 10 секунд сетевого
  // ожидания нельзя — она блокирует строку сделки для всех остальных обработчиков.
  const { deal, version, payment: fresh } = prepared;
  try {
    const created = await yookassa().createPayment({
      amountKopecks: fresh.amountKopecks,
      description: `Сделка #${deal.publicId}: ${version.title.slice(0, TITLE_IN_DESCRIPTION_MAX)}`,
      returnUrl: `${cfg().PUBLIC_BASE_URL.replace(/\/+$/, '')}/pay/return?d=${deal.publicId}`,
      metadata: { deal: deal.publicId, payment: String(fresh.id), kind: fresh.kind },
      idempotenceKey: fresh.idempotenceKey,
    });

    const url = created.confirmation?.confirmation_url ?? null;
    if (!url) {
      throw new IntegrationError('yookassa', 'createPayment', null, null, 'в ответе нет confirmation_url');
    }
    const payment = await inTx((c) =>
      paymentsRepo.update(c, fresh.id, {
        providerPaymentId: created.id,
        providerStatus: created.status,
        confirmationUrl: url,
        raw: created,
      }),
    );
    return { ctx: { deal, version, payment }, created: true };
  } catch (e) {
    // SPEC §14 п. 8: провайдер недоступен → платёж отменяется локально, кнопка снова доступна.
    await inTx((c) => paymentsRepo.update(c, fresh.id, { status: 'canceled', canceledAt: new Date() })).catch(() =>
      undefined,
    );
    if (e instanceof IntegrationError) {
      log.warn(
        { provider: e.provider, op: e.op, status: e.status, code: e.providerCode, deal: deal.publicId },
        'ЮKassa: не удалось создать платёж',
      );
      throw e;
    }
    throw e;
  }
}

// ─────────────────────────── применение статуса ───────────────────────────

/**
 * Единая точка для всех трёх путей подтверждения (SPEC §9.1 п. 3): вебхук, опрос планировщика,
 * кнопка «Проверить оплату». Идемпотентна: повторный `succeeded` не делает второго перехода.
 */
export async function applyProviderStatus(paymentId: number, outcome: ProviderOutcome, now = new Date()): Promise<ApplyResult> {
  const step = await inTx(async (c) => {
    const payment = await paymentsRepo.lockById(c, paymentId);
    if (!payment) throw new NotFoundError(`платёж ${paymentId}`);

    // Терминальные статусы не переигрываются ни в какую сторону.
    if (payment.status === 'succeeded' || payment.status === 'canceled' || payment.status === 'expired') {
      return { payment, changed: false, succeeded: false } as const;
    }

    if (outcome.status === 'pending') {
      // Статус не поменялся, но отметка опроса нужна: по updated_at планировщик держит паузу в 60 с.
      // updatedAt ставим явно тем же «сейчас», по которому считается выборка (§10.3).
      const touched = await paymentsRepo.update(c, payment.id, {
        providerStatus: outcome.providerStatus,
        raw: outcome.raw,
        updatedAt: now,
      });
      return { payment: touched, changed: false, succeeded: false } as const;
    }

    if (outcome.status === 'succeeded') {
      const updated = await paymentsRepo.update(c, payment.id, {
        status: 'succeeded',
        providerStatus: outcome.providerStatus,
        succeededAt: now,
        raw: outcome.raw,
      });
      return { payment: updated, changed: true, succeeded: true } as const;
    }

    const updated = await paymentsRepo.update(c, payment.id, {
      status: 'canceled',
      providerStatus: outcome.providerStatus,
      cancellationReason: outcome.cancellationReason,
      canceledAt: now,
      raw: outcome.raw,
    });
    await eventsRepo.append(c, {
      dealId: payment.dealId,
      type: 'payment.canceled',
      actorUserId: null,
      actorRole: 'system',
      payload: { payment_id: payment.id, reason: outcome.cancellationReason ?? outcome.providerStatus },
    });
    return { payment: updated, changed: true, succeeded: false } as const;
  });

  if (!step.succeeded) return { payment: step.payment, changed: step.changed, transition: null };

  // Переход сделки — своей транзакцией (runTransition берёт сделку под FOR UPDATE сам).
  const transition = await dealService.applyPaymentSucceeded(
    { dealId: step.payment.dealId, paymentId: step.payment.id, kind: step.payment.kind },
    now,
  );
  log.info(
    { deal: transition.bundle.deal.publicId, payment: step.payment.id, kind: step.payment.kind, status: transition.bundle.deal.status },
    'платёж по ссылке подтверждён',
  );
  return { payment: step.payment, changed: true, transition };
}

/**
 * Спросить провайдера напрямую и применить ответ. Используется кнопкой «🔄 Проверить оплату»
 * и планировщиком. Платёж без provider_payment_id (создание не дошло) считается отменённым.
 */
export async function refreshFromProvider(paymentId: number, now = new Date()): Promise<ApplyResult> {
  const payment = await inTx((c) => paymentsRepo.byId(c, paymentId));
  if (!payment) throw new NotFoundError(`платёж ${paymentId}`);
  if (!payment.providerPaymentId) {
    return { payment, changed: false, transition: null };
  }
  const fresh = await yookassa().getPayment(payment.providerPaymentId);
  return applyProviderStatus(paymentId, outcomeOf(fresh), now);
}

/** Срок ссылки вышел, оплаты не было (SPEC §10.3, §14 п. 7): статус `expired`, в карточке — «Новая ссылка». */
export async function expirePayment(paymentId: number, now = new Date()): Promise<Payment | null> {
  return inTx(async (c) => {
    const payment = await paymentsRepo.lockById(c, paymentId);
    if (!payment || payment.status !== 'pending') return null;
    const updated = await paymentsRepo.update(c, payment.id, {
      status: 'expired',
      canceledAt: now,
      cancellationReason: 'expired_on_confirmation',
    });
    await eventsRepo.append(c, {
      dealId: payment.dealId,
      type: 'payment.canceled',
      actorUserId: null,
      actorRole: 'system',
      payload: { payment_id: payment.id, reason: 'link_expired' },
    });
    return updated;
  });
}

/** Платёж истёк, если срок вышел и оплаты не пришло. */
export function isExpired(payment: Payment, now = new Date()): boolean {
  return payment.status === 'pending' && payment.expiresAt !== null && payment.expiresAt.getTime() <= now.getTime();
}

// ─────────────────────────── вспомогательное ───────────────────────────

async function lockDeal(c: DbClient, publicId: string, actor: Actor): Promise<{ deal: Deal; version: DealVersion }> {
  const deal = await dealsRepo.lockByPublicId(c, publicId);
  if (!deal) throw new NotFoundError(`сделка ${publicId}`);
  const isSeller = deal.sellerUserId === actor.userId && actor.role === 'seller';
  const isClient = deal.clientUserId === actor.userId && actor.role === 'client';
  if (!isSeller && !isClient) throw new ForbiddenError(`пользователь не ${actor.role} сделки ${publicId}`);
  const version = await versionsRepo.byVersion(c, deal.id, deal.currentVersion);
  if (!version) throw new Error(`нет версии ${deal.currentVersion}`);
  return { deal, version };
}

export type { PaymentKind };
