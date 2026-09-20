// Платёжные кнопки. Рейл «перевод» работает полностью (SPEC §9.1), рейл «ссылка» в ЗАДАЧА_01 отвечает E11.
import type { Context } from '@maxhub/max-bot-api';
import { RailUnavailable } from '../../../errors.js';
import * as texts from '../../../texts.js';
import type { CardRole, DealBundle } from '../../../types.js';
import * as dealService from '../../../domain/deal/service.js';
import * as paymentService from '../../../domain/payment/service.js';
import type { Actor } from '../../../domain/deal/service.js';
import { syncCards } from '../cards.js';
import { transferCheckKeyboard, transferKeyboard } from '../keyboards.js';
import { deliver, notifyForEvents } from '../notify.js';
import { renderAndSendReceipt } from '../receipt.js';
import type { ParsedCallback } from '../callbacks.js';
import { actingRole, actorOf, answerWithText, chatIdOf, pressedMid, publishResult, touchUser, type Deps } from './shared.js';

export async function onPaymentCallback(
  ctx: Context,
  deps: Deps,
  parsed: Extract<ParsedCallback, { kind: 'deal' }>,
): Promise<void> {
  const userId = ctx.user?.user_id;
  if (!userId) return;
  await touchUser(ctx, chatIdOf(ctx));

  const bundle = await dealService.getBundle(parsed.publicId);
  // tr:g и tr:n нажимает исполнитель, остальное — клиент.
  const fallback: 'seller' | 'client' = parsed.sub === 'g' || parsed.sub === 'n' ? 'seller' : 'client';
  const { role, cardRole } = await actingRole(bundle.deal.id, userId, pressedMid(ctx), fallback);
  const actor = actorOf(userId, role);
  const viewRole: CardRole = cardRole ?? (role === 'client' && bundle.deal.demo ? 'client_demo' : role);

  switch (parsed.code) {
    case 'pl': // оплата по ссылке — провайдер не подключён (ЗАДАЧА_01)
    case 'pc':
    case 'pe':
    case 'nl':
      try {
        await paymentService.createLinkPayment(parsed.publicId, actor);
      } catch (e) {
        if (e instanceof RailUnavailable) {
          await answerWithText(ctx, deps, texts.E11);
          return;
        }
        throw e;
      }
      return;

    case 'pt':
      await offerTransfer(ctx, deps, parsed.publicId, actor);
      return;

    case 'tr':
      await onTransferStep(ctx, deps, parsed, actor, viewRole);
      return;

    default:
      await answerWithText(ctx, deps, texts.E1);
  }
}

/** Клиент выбрал перевод: показываем реквизиты (P1) и кнопку «Я перевёл(а)». */
async function offerTransfer(ctx: Context, deps: Deps, publicId: string, actor: Actor): Promise<void> {
  const { ctx: pay, profile } = await paymentService.createTransferPayment(publicId, actor);
  await answerWithText(
    ctx,
    deps,
    `${texts.P1({ sumKopecks: pay.payment.amountKopecks, payoutDetails: profile.payoutDetails ?? '' })}\n\n${texts.testRailNotice('manual')}`,
    transferKeyboard(publicId, pay.payment.id),
  );
  const fresh = await dealService.getBundle(publicId);
  await syncCards(deps.max, fresh);
}

async function onTransferStep(
  ctx: Context,
  deps: Deps,
  parsed: Extract<ParsedCallback, { kind: 'deal' }>,
  actor: Actor,
  viewRole: CardRole,
): Promise<void> {
  const paymentId = Number(parsed.arg);
  if (!Number.isFinite(paymentId)) {
    await answerWithText(ctx, deps, texts.E1);
    return;
  }
  const publicId = parsed.publicId;

  switch (parsed.sub) {
    case 'c': {
      // Клиент: «Я перевёл(а)» → исполнителю приходит P2 с кнопками подтверждения.
      const { ctx: pay, tooSoon } = await paymentService.claim({ publicId, paymentId, actor });
      if (tooSoon) {
        await answerWithText(ctx, deps, texts.E13);
        return;
      }
      const bundle = await dealService.getBundle(publicId);
      await answerWithText(ctx, deps, 'Сообщили исполнителю о переводе. Ждём подтверждения.');
      await syncCards(deps.max, bundle);
      const clientName = bundle.deal.demo ? 'демо-клиент' : (bundle.client ? `${bundle.client.firstName}` : 'клиент');
      await deliver(deps.max, bundle, {
        to: 'seller',
        text: texts.P2({ client: clientName, sumKopecks: pay.payment.amountKopecks, id: publicId }),
        keyboard: transferCheckKeyboard(publicId, pay.payment.id),
      });
      return;
    }

    case 'g': {
      // Исполнитель: «Получил(а)» → платёж succeeded → переход сделки T9 или T14.
      const { alreadySucceeded, ctx: pay } = await paymentService.markReceived({ publicId, paymentId, actor });
      if (alreadySucceeded) {
        await answerWithText(ctx, deps, texts.ALREADY_DONE);
        return;
      }
      const transition = await dealService.applyPaymentSucceeded({
        dealId: pay.deal.id,
        paymentId: pay.payment.id,
        kind: pay.payment.kind,
      });
      await publishResult(ctx, deps, transition, viewRole);
      await closeIfNoReceiptNeeded(deps, transition.bundle);
      return;
    }

    case 'n': {
      // Исполнитель: «Не вижу перевода» → платёж снова pending, клиенту уходит P3.
      const pay = await paymentService.markNotReceived({ publicId, paymentId, actor });
      const bundle = await dealService.getBundle(publicId);
      await answerWithText(ctx, deps, 'Отметили, что перевод не виден. Клиент получил подсказку.');
      await syncCards(deps.max, bundle);
      await deliver(deps.max, bundle, {
        to: 'client',
        text: texts.P3({ sumKopecks: pay.payment.amountKopecks }),
        keyboard: transferKeyboard(publicId, pay.payment.id),
      });
      return;
    }

    case 'x': {
      // Клиент отказался от выбранного рейла: сделка остаётся, платёж отменён локально.
      await paymentService.cancelPayment({ publicId, paymentId, actor });
      const bundle = await dealService.getBundle(publicId);
      await answerWithText(ctx, deps, 'Способ оплаты отменён. Можно выбрать другой.');
      await syncCards(deps.max, bundle);
      return;
    }

    default:
      await answerWithText(ctx, deps, texts.E1);
  }
}

/** Сделка оплачена полностью и чек не требуется (tax_mode='none') — закрываем и отправляем квитанцию (T15). */
export async function closeIfNoReceiptNeeded(deps: Deps, bundle: DealBundle): Promise<void> {
  if (bundle.deal.status !== 'paid') return;
  if (dealService.taxModeOf(bundle) !== 'none') return;
  const closed = await dealService.closeAutomatically(bundle.deal.id);
  await syncCards(deps.max, closed.bundle);
  await notifyForEvents(deps.max, closed.bundle, closed.events);
  await renderAndSendReceipt(deps.max, closed.bundle);
}
