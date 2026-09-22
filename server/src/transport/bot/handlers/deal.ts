// Кнопки карточки сделки: все коды §13, кроме платёжных (они в payment.ts).
// Обработчик короткий: разобрать payload → определить роль по нажатой карточке → вызвать сервис → отрисовать.
import type { Context } from '@maxhub/max-bot-api';
import { cfg } from '../../../config.js';
import { inTx } from '../../../db/pool.js';
import * as inputsRepo from '../../../db/repos/inputs.js';
import * as texts from '../../../texts.js';
import { isTerminal, remaining, type CardRole, type DealBundle } from '../../../types.js';
import { addMinutes } from '../../../domain/time.js';
import * as dealService from '../../../domain/deal/service.js';
import { INPUT_TTL_MINUTES } from '../../../domain/deal/service.js';
import { renderAndSendReceipt } from '../receipt.js';
import { log } from '../../../logger.js';
import { showCardBelow } from '../cards.js';
import {
  actingRole,
  actorOf,
  answerWithCard,
  chatIdOf,
  ensureCard,
  pressedCard,
  pressedMid,
  publishResult,
  reply,
  touchUser,
  type Deps,
} from './shared.js';
import { cancelReasonKeyboard, confirmKeyboard } from '../keyboards.js';
import { notifyManualReminder } from '../notify.js';
import type { ParsedCallback } from '../callbacks.js';

/** Какой роли принадлежит кнопка, если нажатое сообщение — не карточка (уведомление или напоминание). */
const CODE_ROLE: Record<string, 'seller' | 'client'> = {
  cf: 'client', cr: 'client', dc: 'client', ac: 'client', rm: 'client', pl: 'client', pt: 'client',
  dn: 'seller', fx: 'seller', rc: 'seller', nc: 'seller', ka: 'seller', rs: 'seller',
};

export async function onDealCallback(ctx: Context, deps: Deps, parsed: Extract<ParsedCallback, { kind: 'deal' }>): Promise<void> {
  const userId = ctx.user?.user_id;
  if (!userId) return;
  const chatId = chatIdOf(ctx);
  await touchUser(ctx, chatId);

  const bundle = await dealService.getBundle(parsed.publicId);
  dealService.ensureParticipant(bundle.deal, userId); // посторонний дальше не проходит (G1)
  const byCode = parsed.code === 'rf' ? (parsed.sub === 's' ? 'seller' : 'client') : CODE_ROLE[parsed.code];
  const fallback = byCode ?? (bundle.deal.sellerUserId === userId ? 'seller' : 'client');
  const { role, cardRole } = await actingRole(bundle.deal.id, userId, pressedMid(ctx), fallback);
  const actor = actorOf(userId, role);
  const viewRole: CardRole = cardRole ?? (role === 'client' && bundle.deal.demo ? 'client_demo' : role);

  switch (parsed.code) {
    case 'op': // «Открыть» / «Назад» / «Не отменять» — показать актуальную карточку
      await openCard(ctx, deps, bundle, viewRole, userId, chatId);
      return;

    case 'cf':
      await publishResult(ctx, deps, await dealService.confirm(parsed.publicId, actor), viewRole);
      return;

    case 'cr':
      await askInput(ctx, deps, bundle, viewRole, { userId, kind: 'change_request', prompt: texts.ASK_CHANGE_REQUEST });
      return;

    case 'dc':
      if (parsed.sub === 'y') {
        await publishResult(ctx, deps, await dealService.decline(parsed.publicId, actor), viewRole);
      } else {
        await reply(ctx, deps, bundle, { role: viewRole, note: texts.CONFIRM_DECLINE(parsed.publicId), keyboard: confirmKeyboard('dc', parsed.publicId, texts.BTN.declineYes) });
      }
      return;

    case 'ka':
      await publishResult(ctx, deps, await dealService.keepAsIs(parsed.publicId, actor), viewRole);
      return;

    case 'dn':
      await publishResult(ctx, deps, await dealService.markDone(parsed.publicId, actor), viewRole);
      return;

    case 'ac': // остатка нет и tax_mode=none — домен сразу закрывает сделку, квитанцию шлёт publishResult (T15)
      await publishResult(ctx, deps, await dealService.accept(parsed.publicId, actor), viewRole);
      return;

    case 'rm':
      await askInput(ctx, deps, bundle, viewRole, { userId, kind: 'remarks', prompt: texts.ASK_REMARKS });
      return;

    case 'fx':
      await publishResult(ctx, deps, await dealService.markFixed(parsed.publicId, actor), viewRole);
      return;

    case 'rc':
      await askInput(ctx, deps, bundle, viewRole, { userId, kind: 'receipt', prompt: texts.ASK_RECEIPT });
      return;

    case 'nc':
      if (parsed.sub === 'y') {
        await publishResult(ctx, deps, await dealService.closeWithoutReceipt(parsed.publicId, actor), viewRole);
      } else {
        await reply(ctx, deps, bundle, {
          role: viewRole,
          note: texts.CONFIRM_CLOSE_WITHOUT_RECEIPT(parsed.publicId),
          keyboard: confirmKeyboard('nc', parsed.publicId, texts.BTN.closeWithoutReceiptYes),
        });
      }
      return;

    case 'cn':
      if (parsed.sub === 'y') {
        const reason = parsed.arg === 'none' || !parsed.arg ? null : parsed.arg;
        const result = await dealService.cancel(parsed.publicId, actor, reason);
        // Снимаем ожидание причины отмены: кнопкой «Без причины» сделка уже отменена, и если оставить
        // запись в user_inputs, следующая же реплика исполнителя уедет в обработчик причины отмены,
        // тот попробует отменить отменённое и ответит E1 на безобидный текст (поймано живым прогоном).
        await inTx((c) => inputsRepo.clear(c, userId));
        await publishResult(ctx, deps, result, viewRole);
      } else {
        await askCancel(ctx, deps, bundle, viewRole, role, userId);
      }
      return;

    case 'rs':
      await remindClient(ctx, deps, bundle, viewRole);
      return;

    case 'dm':
      await openAsClient(ctx, deps, parsed.publicId, userId, chatId);
      return;

    case 'pdf':
      await sendReceiptOnDemand(ctx, deps, bundle, viewRole, userId);
      return;

    case 'rf': {
      // «Вернул(а)» / «Возврат получил(а)» у отменённой сделки (SPEC §5.3, ЗАДАЧА_03 H1).
      const result = await dealService.confirmRefund(parsed.publicId, actor);
      await publishResult(ctx, deps, result, viewRole, role === 'seller' ? texts.REFUND_SENT_ACK : texts.REFUND_RECEIVED_ACK);
      return;
    }

    default:
      await reply(ctx, deps, bundle, { role: viewRole, note: texts.E1 });
      return;
  }
}

/**
 * «Отменить» — вопрос поверх карточки. В нём сразу сказано, что станет с предоплатой (§5.3):
 * узнавать о потере денег после подтверждения — нечестно. Исполнителю предлагаем указать причину
 * (она уйдёт второй стороне в N15).
 */
async function askCancel(ctx: Context, deps: Deps, bundle: DealBundle, viewRole: CardRole, role: 'seller' | 'client', userId: number): Promise<void> {
  const id = bundle.deal.publicId;
  const consequence = texts.CANCEL_CONSEQUENCE({
    by: role,
    prepaymentKopecks: bundle.version.prepaymentKopecks,
    expected: dealService.refundIfCancelled(bundle, role),
  });
  const question = [texts.CONFIRM_CANCEL(id), consequence].filter(Boolean).join('\n');
  if (role === 'seller') {
    await inTx((c) =>
      inputsRepo.set(c, { userId, kind: 'cancel_reason', dealId: bundle.deal.id, expiresAt: addMinutes(new Date(), INPUT_TTL_MINUTES) }),
    );
    await reply(ctx, deps, bundle, { role: viewRole, note: `${question}\n\n${texts.ASK_CANCEL_REASON}`, keyboard: cancelReasonKeyboard(id) });
    return;
  }
  await reply(ctx, deps, bundle, { role: viewRole, note: question, keyboard: confirmKeyboard('cn', id, texts.BTN.cancelYes) });
}

/** Запрос текста или файла: ждём 30 минут, помним в user_inputs (переживает рестарт, §14 п. 13). */
async function askInput(
  ctx: Context,
  deps: Deps,
  bundle: DealBundle,
  role: CardRole,
  a: { userId: number; kind: 'change_request' | 'remarks' | 'receipt'; prompt: string },
): Promise<void> {
  await inTx((c) =>
    inputsRepo.set(c, { userId: a.userId, kind: a.kind, dealId: bundle.deal.id, expiresAt: addMinutes(new Date(), INPUT_TTL_MINUTES) }),
  );
  await reply(ctx, deps, bundle, { role, note: a.prompt });
}

/**
 * «Открыть», а также «Назад» и «Не отменять» из подтверждений. Ожидание причины отмены по этой сделке
 * снимаем: иначе любая следующая реплика передумавшего исполнителя отменила бы сделку.
 * Нажали на самой карточке — перерисовываем её на месте; нажали в уведомлении или в списке /deals —
 * сообщение с кнопкой не трогаем, а карточку показываем внизу чата, где человек её и ждёт.
 */
async function openCard(ctx: Context, deps: Deps, bundle: DealBundle, viewRole: CardRole, userId: number, chatId: number | null): Promise<void> {
  await inTx((c) => inputsRepo.clearIf(c, { userId, kind: 'cancel_reason', dealId: bundle.deal.id }));
  const card = await pressedCard(ctx, bundle.deal.id);
  if (card) {
    await answerWithCard(ctx, deps, bundle, card.role);
    return;
  }
  await deps.max.answer(ctx.callback!.callback_id).catch((e: Error) => log.warn({ err: e.message }, 'max: пустой ответ на «Открыть» отклонён'));
  const roles: CardRole[] = bundle.deal.demo && bundle.deal.sellerUserId === userId ? ['seller', 'client_demo'] : [viewRole];
  for (const role of roles) await showCardBelow(deps.max, bundle, role, { userId, chatId });
}

/** Ручное напоминание клиенту: не чаще раза в 4 часа на сделку (SPEC §5.5). */
const MANUAL_REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const lastManualReminder = new Map<number, number>();

async function remindClient(ctx: Context, deps: Deps, bundle: DealBundle, role: CardRole): Promise<void> {
  const last = lastManualReminder.get(bundle.deal.id) ?? 0;
  if (Date.now() - last < MANUAL_REMINDER_COOLDOWN_MS) {
    await reply(ctx, deps, bundle, { role, note: texts.REMIND_COOLDOWN });
    return;
  }
  const context = texts.statusText(bundle.deal.status, 'client', {
    prepaymentKopecks: bundle.version.prepaymentKopecks,
    remainingKopecks: remaining(bundle.version),
    scheduledAt: bundle.version.scheduledAt,
  });
  const sent = await notifyManualReminder(deps.max, bundle, context);
  if (sent) lastManualReminder.set(bundle.deal.id, Date.now());
  await reply(ctx, deps, bundle, { role, note: sent ? texts.REMIND_SENT : texts.REMIND_NO_CHAT });
}

/** Демо-режим: исполнитель проходит клиентскую сторону в своём же чате (SPEC §12). */
async function openAsClient(ctx: Context, deps: Deps, publicId: string, userId: number, chatId: number | null): Promise<void> {
  if (!cfg().DEMO_MODE) {
    await deps.max.answer(ctx.callback!.callback_id, texts.E1);
    return;
  }
  const result = await dealService.openAsClient({ publicId, sellerUserId: userId });
  await reply(ctx, deps, result.bundle, { role: 'seller' });
  await ensureCard(deps, result.bundle, 'client_demo', userId, chatId);
}

/** Квитанция по запросу кнопкой (доступна в терминальных статусах, SPEC §5.5). */
async function sendReceiptOnDemand(ctx: Context, deps: Deps, bundle: DealBundle, role: CardRole, userId: number): Promise<void> {
  if (!isTerminal(bundle.deal.status)) {
    await reply(ctx, deps, bundle, { role, note: texts.RECEIPT_NOT_YET });
    return;
  }
  // Кнопка «Квитанция PDF» живёт на карточке закрытой сделки: ответ обязан вернуть её же,
  // иначе кнопка пропала бы навсегда — закрытые сделки в /deals не показываются.
  await reply(ctx, deps, bundle, { role, note: texts.RECEIPT_PREPARING });
  await renderAndSendReceipt(deps.max, bundle, { onDemandFor: userId });
}
