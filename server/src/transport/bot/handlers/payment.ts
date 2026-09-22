// Платёжные кнопки. Оба рейла работают: «перевод» подтверждают стороны (SPEC §9.1 «[модель]»),
// «ссылка» идёт через ЮKassa (§9.2 «[тест]»). Ошибки провайдера превращаются в E9 в shared.answerError.
import type { Context } from '@maxhub/max-bot-api';
import * as texts from '../../../texts.js';
import type { CardRole, DealBundle } from '../../../types.js';
import * as dealService from '../../../domain/deal/service.js';
import * as paymentService from '../../../domain/payment/service.js';
import * as rails from '../../../domain/payment/rails.js';
import type { Actor } from '../../../domain/deal/service.js';
import { syncCards } from '../cards.js';
import { transferCheckKeyboard, transferKeyboard } from '../keyboards.js';
import { deliver } from '../notify.js';
import { notifyPaymentEvents } from '../outcome.js';
import type { ParsedCallback } from '../callbacks.js';
import { actingRole, actorOf, chatIdOf, pressedMid, publishResult, reply, touchUser, type Deps } from './shared.js';

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
    case 'pl':
    case 'nl':
      await offerLink(ctx, deps, parsed.publicId, actor, viewRole, { renew: parsed.code === 'nl' });
      return;

    case 'pc':
      await checkLink(ctx, deps, parsed, viewRole);
      return;

    case 'pe': // эмуляция оплаты — только DEMO-терминал Т-Банка (SPEC §9.3); терминал не подключён
      await reply(ctx, deps, bundle, { role: viewRole, note: texts.E11 });
      return;

    case 'pt':
      await offerTransfer(ctx, deps, parsed.publicId, actor, viewRole);
      return;

    case 'tr':
      await onTransferStep(ctx, deps, parsed, actor, viewRole);
      return;

    default:
      await reply(ctx, deps, bundle, { role: viewRole, note: texts.E1 });
  }
}

/** Ответить на нажатие свежей карточкой с заметкой и перерисовать остальные карточки сделки. */
async function answerAndSync(ctx: Context, deps: Deps, publicId: string, role: CardRole, note?: string): Promise<DealBundle> {
  const fresh = await dealService.getBundle(publicId);
  const skip = await reply(ctx, deps, fresh, { role, note });
  await syncCards(deps.max, fresh, skip);
  return fresh;
}

/**
 * Клиент выбрал оплату по ссылке (или запросил новую). Карточка получает строку со сроком и
 * кнопки [Перейти к оплате] [🔄 Проверить оплату] — их рисует cardKeyboard по живому платежу (SPEC §9.1 п. 2).
 */
async function offerLink(ctx: Context, deps: Deps, publicId: string, actor: Actor, role: CardRole, o: { renew: boolean }): Promise<void> {
  const { ctx: pay } = await rails.createLinkPayment(publicId, actor, { renew: o.renew });
  const note = texts.linkIssued({ sumKopecks: pay.payment.amountKopecks, expiresAt: pay.payment.expiresAt, provider: pay.payment.provider });
  await answerAndSync(ctx, deps, publicId, role, note);
}

/**
 * «🔄 Проверить оплату» — синхронный GET статуса у провайдера (SPEC §9.1 п. 3).
 * Нужен и как страховка там, где вебхук не доходит (локальный запуск без HTTPS).
 */
async function checkLink(
  ctx: Context,
  deps: Deps,
  parsed: Extract<ParsedCallback, { kind: 'deal' }>,
  viewRole: CardRole,
): Promise<void> {
  const paymentId = Number(parsed.arg);
  if (!Number.isFinite(paymentId)) {
    await answerAndSync(ctx, deps, parsed.publicId, viewRole, texts.E1);
    return;
  }
  const applied = await rails.refreshFromProvider(paymentId);
  if (applied.transition) {
    // Оплата подтверждена сейчас — или раньше, а сделку довели только теперь (F4); закрытие при tax_mode=none
    // и квитанция — там же (F5).
    await publishResult(ctx, deps, applied.transition, viewRole);
  } else {
    // Оплаты ещё нет: карточка остаётся с «Перейти к оплате» / «Проверить» (или «Новая ссылка»), текст — заметкой.
    const note = applied.events.length ? undefined : texts.paymentStillPending(applied.payment.status);
    await answerAndSync(ctx, deps, parsed.publicId, viewRole, note);
  }
  await notifyPaymentEvents(deps.max, applied);
}

/** Клиент выбрал перевод: реквизиты и «Я перевёл(а)» рисует сама карточка (SPEC §6.4). */
async function offerTransfer(ctx: Context, deps: Deps, publicId: string, actor: Actor, role: CardRole): Promise<void> {
  await paymentService.createTransferPayment(publicId, actor);
  await answerAndSync(ctx, deps, publicId, role);
}

async function onTransferStep(
  ctx: Context,
  deps: Deps,
  parsed: Extract<ParsedCallback, { kind: 'deal' }>,
  actor: Actor,
  viewRole: CardRole,
): Promise<void> {
  const paymentId = Number(parsed.arg);
  const publicId = parsed.publicId;
  if (!Number.isFinite(paymentId)) {
    await answerAndSync(ctx, deps, publicId, viewRole, texts.E1);
    return;
  }

  switch (parsed.sub) {
    case 'c': {
      // Клиент: «Я перевёл(а)» → карточка исполнителя получает «Получил(а)/Не вижу», плюс уведомление P2.
      const { ctx: pay, tooSoon } = await paymentService.claim({ publicId, paymentId, actor });
      if (tooSoon) {
        await answerAndSync(ctx, deps, publicId, viewRole, texts.E13);
        return;
      }
      const bundle = await answerAndSync(ctx, deps, publicId, viewRole, texts.TRANSFER_CLAIMED);
      const clientName = bundle.deal.demo ? 'демо-клиент' : (bundle.client ? `${bundle.client.firstName}` : 'клиент');
      await deliver(deps.max, bundle, {
        to: 'seller',
        text: texts.P2({ client: clientName, sumKopecks: pay.payment.amountKopecks, id: publicId }),
        keyboard: transferCheckKeyboard(publicId, pay.payment.id),
      });
      return;
    }

    case 'g': {
      // Исполнитель: «Получил(а)» → платёж succeeded → переход сделки T9 или T14 (+ T15 при tax_mode=none).
      // Переход применяется и к уже succeeded платежу: идемпотентно, а если прошлый раз процесс упал
      // между транзакциями — сделка сдвинется сейчас (F4). Повтор без изменений — «уже сделано».
      const { ctx: pay } = await paymentService.markReceived({ publicId, paymentId, actor });
      const transition = await dealService.applyPaymentSucceeded({ dealId: pay.deal.id, paymentId: pay.payment.id, kind: pay.payment.kind });
      await publishResult(ctx, deps, transition, viewRole);
      return;
    }

    case 'n': {
      // Исполнитель: «Не вижу перевода» → платёж снова pending, клиенту уходит P3.
      const pay = await paymentService.markNotReceived({ publicId, paymentId, actor });
      const bundle = await answerAndSync(ctx, deps, publicId, viewRole, texts.TRANSFER_NOT_SEEN_ACK);
      await deliver(deps.max, bundle, {
        to: 'client',
        text: texts.P3({ sumKopecks: pay.payment.amountKopecks }),
        keyboard: transferKeyboard(publicId, pay.payment.id),
      });
      return;
    }

    case 'x': {
      // Клиент отказался от выбранного рейла: сделка остаётся, платёж отменён локально, карточка снова даёт выбор.
      await paymentService.cancelPayment({ publicId, paymentId, actor });
      await answerAndSync(ctx, deps, publicId, viewRole, texts.RAIL_CANCELLED);
      return;
    }

    default:
      await answerAndSync(ctx, deps, publicId, viewRole, texts.E1);
  }
}
