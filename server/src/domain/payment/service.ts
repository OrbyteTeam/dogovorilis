// Платежи. Рейл «перевод» — настоящий (стороны подтверждают факт перевода, SPEC §9.1 «[модель]»).
// Рейл «ссылка» — в соседнем rails.ts (ЮKassa, SPEC §9.2). Общее для обоих — здесь:
// expectedPayment (какой платёж уместен в текущем статусе) и PaymentContext.
import { ForbiddenError, InvalidTransition, NotFoundError, RailUnavailable } from '../../errors.js';
import { inTx, type DbClient } from '../../db/pool.js';
import * as dealsRepo from '../../db/repos/deals.js';
import * as eventsRepo from '../../db/repos/events.js';
import * as paymentsRepo from '../../db/repos/payments.js';
import * as usersRepo from '../../db/repos/users.js';
import * as versionsRepo from '../../db/repos/versions.js';
import { log } from '../../logger.js';
import type { Deal, DealVersion, Payment, PaymentKind, SellerProfile } from '../../types.js';
import { newIdempotenceKey } from '../ids.js';
import { MINUTE_MS } from '../time.js';
import type { Actor } from '../deal/service.js';
import { actorRoleFor } from '../deal/service.js';

/** Повторное «Я перевёл(а)» — не чаще раза в 10 минут (SPEC §9.1 п. 5, текст E13). */
export const CLAIM_COOLDOWN_MS = 10 * MINUTE_MS;

export type PaymentContext = { deal: Deal; version: DealVersion; payment: Payment };

/** Какой платёж уместен в текущем статусе сделки и на какую сумму. */
export function expectedPayment(deal: Deal, version: DealVersion): { kind: PaymentKind; amountKopecks: number } | null {
  if (deal.status === 'awaiting_prepayment') return { kind: 'prepayment', amountKopecks: version.prepaymentKopecks };
  if (deal.status === 'awaiting_payment')
    return { kind: 'final', amountKopecks: version.totalKopecks - version.prepaymentKopecks };
  return null;
}

// Рейл «ссылка» живёт в соседнем модуле rails.ts: там же клиент провайдера и applyProviderStatus.
// Здесь он не переэкспортируется, чтобы не появилось кольцо импортов (rails → service за expectedPayment).

/**
 * Клиент выбрал перевод по реквизитам. Идемпотентно: если живой платёж этого вида уже есть переводом —
 * возвращаем его; если он был ссылочным и ещё не оплачен — помечаем canceled и создаём перевод (смена рейла, §9.1).
 */
export async function createTransferPayment(
  publicId: string,
  actor: Actor,
  now = new Date(),
): Promise<{ ctx: PaymentContext; profile: SellerProfile; created: boolean }> {
  return inTx(async (c) => {
    const { deal, version } = await lockDeal(c, publicId, actor);
    const expected = expectedPayment(deal, version);
    if (!expected) throw new InvalidTransition(deal.status, 'prepayment_succeeded', actor.role, 'forbidden');

    const profile = await usersRepo.getProfile(c, deal.sellerUserId);
    if (!profile?.transferEnabled || !profile.payoutDetails?.trim()) {
      throw new RailUnavailable('transfer', 'исполнитель не указал реквизиты для перевода');
    }

    const live = await paymentsRepo.live(c, deal.id, expected.kind);
    if (live?.status === 'succeeded') {
      return { ctx: { deal, version, payment: live }, profile, created: false };
    }
    if (live && live.rail === 'transfer') {
      return { ctx: { deal, version, payment: live }, profile, created: false };
    }
    if (live) {
      // Ссылочный платёж жив, но клиент передумал: локально отменяем, у провайдера ссылка истечёт сама.
      await paymentsRepo.update(c, live.id, { status: 'canceled', canceledAt: now });
      await eventsRepo.append(c, {
        dealId: deal.id,
        type: 'payment.canceled',
        actorUserId: actor.userId,
        actorRole: actorRoleFor(deal, actor),
        payload: { payment_id: live.id, reason: 'rail_switch' },
      });
    }

    const payment = await paymentsRepo.create(c, {
      dealId: deal.id,
      kind: expected.kind,
      rail: 'transfer',
      provider: 'manual',
      amountKopecks: expected.amountKopecks,
      idempotenceKey: newIdempotenceKey(),
    });
    await eventsRepo.append(c, {
      dealId: deal.id,
      type: 'payment.created',
      actorUserId: actor.userId,
      actorRole: actorRoleFor(deal, actor),
      payload: { payment_id: payment.id, kind: expected.kind, rail: 'transfer', amount: expected.amountKopecks },
    });
    log.info({ deal: deal.publicId, payment: payment.id, kind: expected.kind }, 'создан платёж переводом');
    return { ctx: { deal, version, payment }, profile, created: true };
  });
}

/** Клиент: «Я перевёл(а)» → claimed. Частые повторы отбиваются по claimed_at (E13). */
export async function claim(
  args: { publicId: string; paymentId: number; actor: Actor },
  now = new Date(),
): Promise<{ ctx: PaymentContext; tooSoon: boolean }> {
  return inTx(async (c) => {
    const { deal, version } = await lockDeal(c, args.publicId, args.actor);
    const payment = await lockPayment(c, deal.id, args.paymentId);

    if (payment.status === 'succeeded') return { ctx: { deal, version, payment }, tooSoon: false };
    if (payment.status === 'claimed' && payment.claimedAt && now.getTime() - payment.claimedAt.getTime() < CLAIM_COOLDOWN_MS) {
      return { ctx: { deal, version, payment }, tooSoon: true };
    }

    const updated = await paymentsRepo.update(c, payment.id, { status: 'claimed', claimedAt: now });
    await eventsRepo.append(c, {
      dealId: deal.id,
      type: 'payment.claimed',
      actorUserId: args.actor.userId,
      actorRole: actorRoleFor(deal, args.actor),
      payload: { payment_id: payment.id },
    });
    return { ctx: { deal, version, payment: updated }, tooSoon: false };
  });
}

/**
 * Исполнитель: «Получил(а)» → succeeded. Сам переход сделки (T9/T14) делает domain/deal/service.ts:
  * здесь только деньги, чтобы у каждого слоя была одна ответственность.
 */
export async function markReceived(
  args: { publicId: string; paymentId: number; actor: Actor },
  now = new Date(),
): Promise<{ ctx: PaymentContext; alreadySucceeded: boolean }> {
  return inTx(async (c) => {
    const { deal, version } = await lockDeal(c, args.publicId, args.actor);
    if (args.actor.role !== 'seller') throw new ForbiddenError('подтвердить поступление может только исполнитель');
    const payment = await lockPayment(c, deal.id, args.paymentId);
    if (payment.status === 'succeeded') return { ctx: { deal, version, payment }, alreadySucceeded: true };

    const updated = await paymentsRepo.update(c, payment.id, { status: 'succeeded', succeededAt: now });
    return { ctx: { deal, version, payment: updated }, alreadySucceeded: false };
  });
}

/** Исполнитель: «Не вижу перевода» → платёж возвращается в pending, клиент получает P3. */
export async function markNotReceived(
  args: { publicId: string; paymentId: number; actor: Actor },
): Promise<PaymentContext> {
  return inTx(async (c) => {
    const { deal, version } = await lockDeal(c, args.publicId, args.actor);
    if (args.actor.role !== 'seller') throw new ForbiddenError('только исполнитель');
    const payment = await lockPayment(c, deal.id, args.paymentId);
    const updated =
      payment.status === 'claimed'
        ? await paymentsRepo.update(c, payment.id, { status: 'pending', claimedAt: null })
        : payment;
    await eventsRepo.append(c, {
      dealId: deal.id,
      type: 'payment.not_received',
      actorUserId: args.actor.userId,
      actorRole: actorRoleFor(deal, args.actor),
      payload: { payment_id: payment.id },
    });
    return { deal, version, payment: updated };
  });
}

/** Клиент отказался от выбранного рейла (кнопка «Отмена» под реквизитами). Сделку это не отменяет. */
export async function cancelPayment(
  args: { publicId: string; paymentId: number; actor: Actor },
  now = new Date(),
): Promise<PaymentContext> {
  return inTx(async (c) => {
    const { deal, version } = await lockDeal(c, args.publicId, args.actor);
    const payment = await lockPayment(c, deal.id, args.paymentId);
    if (payment.status === 'succeeded') return { deal, version, payment };
    const updated = await paymentsRepo.update(c, payment.id, { status: 'canceled', canceledAt: now });
    await eventsRepo.append(c, {
      dealId: deal.id,
      type: 'payment.canceled',
      actorUserId: args.actor.userId,
      actorRole: actorRoleFor(deal, args.actor),
      payload: { payment_id: payment.id, reason: 'client_cancelled_rail' },
    });
    return { deal, version, payment: updated };
  });
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

async function lockPayment(c: DbClient, dealId: number, paymentId: number): Promise<Payment> {
  const payment = await paymentsRepo.lockById(c, paymentId);
  if (!payment || payment.dealId !== dealId) throw new NotFoundError(`платёж ${paymentId}`);
  return payment;
}
