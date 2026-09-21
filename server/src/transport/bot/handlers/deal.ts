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
import { ensureCard } from './shared.js';
import {
  actingRole,
  actorOf,
  answerWithCard,
  answerWithText,
  chatIdOf,
  pressedMid,
  publishResult,
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
  const fallback = CODE_ROLE[parsed.code] ?? (bundle.deal.sellerUserId === userId ? 'seller' : 'client');
  const { role, cardRole } = await actingRole(bundle.deal.id, userId, pressedMid(ctx), fallback);
  const actor = actorOf(userId, role);
  const viewRole: CardRole = cardRole ?? (role === 'client' && bundle.deal.demo ? 'client_demo' : role);

  switch (parsed.code) {
    case 'op': // «Открыть» — просто показать актуальную карточку
      await ensureCard(deps, bundle, viewRole, userId, chatId);
      await answerWithText(ctx, deps, `Карточка #${bundle.deal.publicId} обновлена.`);
      return;

    case 'cf':
      await publishResult(ctx, deps, await dealService.confirm(parsed.publicId, actor), viewRole);
      return;

    case 'cr':
      await askInput(ctx, deps, { userId, dealId: bundle.deal.id, kind: 'change_request', prompt: texts.ASK_CHANGE_REQUEST });
      return;

    case 'dc':
      if (parsed.sub === 'y') {
        await publishResult(ctx, deps, await dealService.decline(parsed.publicId, actor), viewRole);
      } else {
        await answerWithText(ctx, deps, texts.CONFIRM_DECLINE(parsed.publicId), confirmKeyboard('dc', parsed.publicId, texts.BTN.declineYes));
      }
      return;

    case 'ka':
      await publishResult(ctx, deps, await dealService.keepAsIs(parsed.publicId, actor), viewRole);
      return;

    case 'dn':
      await publishResult(ctx, deps, await dealService.markDone(parsed.publicId, actor), viewRole);
      return;

    case 'ac': {
      const result = await dealService.accept(parsed.publicId, actor);
      await publishResult(ctx, deps, result, viewRole);
      // Остатка не было — сделка сразу оплачена; при tax_mode=none закрываем её и отправляем квитанцию (T15).
      await finishIfFullyPaid(deps, result.bundle);
      return;
    }

    case 'rm':
      await askInput(ctx, deps, { userId, dealId: bundle.deal.id, kind: 'remarks', prompt: texts.ASK_REMARKS });
      return;

    case 'fx':
      await publishResult(ctx, deps, await dealService.markFixed(parsed.publicId, actor), viewRole);
      return;

    case 'rc':
      await askInput(ctx, deps, { userId, dealId: bundle.deal.id, kind: 'receipt', prompt: texts.ASK_RECEIPT });
      return;

    case 'nc':
      if (parsed.sub === 'y') {
        const result = await dealService.closeWithoutReceipt(parsed.publicId, actor);
        await publishResult(ctx, deps, result, viewRole);
        if (!result.alreadyDone) await renderAndSendReceipt(deps.max, result.bundle);
      } else {
        await answerWithText(
          ctx,
          deps,
          texts.CONFIRM_CLOSE_WITHOUT_RECEIPT(parsed.publicId),
          confirmKeyboard('nc', parsed.publicId, texts.BTN.closeWithoutReceiptYes),
        );
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
      } else if (role === 'seller') {
        // Исполнителю предлагаем указать причину (она уйдёт второй стороне в N15).
        await inTx((c) =>
          inputsRepo.set(c, { userId, kind: 'cancel_reason', dealId: bundle.deal.id, expiresAt: addMinutes(new Date(), INPUT_TTL_MINUTES) }),
        );
        await answerWithText(ctx, deps, `${texts.CONFIRM_CANCEL(parsed.publicId)}\n\n${texts.ASK_CANCEL_REASON}`, cancelReasonKeyboard(parsed.publicId));
      } else {
        await answerWithText(ctx, deps, texts.CONFIRM_CANCEL(parsed.publicId), confirmKeyboard('cn', parsed.publicId, texts.BTN.cancelYes));
      }
      return;

    case 'rs':
      await remindClient(ctx, deps, bundle);
      return;

    case 'dm':
      await openAsClient(ctx, deps, parsed.publicId, userId, chatId);
      return;

    case 'pdf':
      await sendReceiptOnDemand(ctx, deps, bundle);
      return;

    default:
      await answerWithText(ctx, deps, texts.E1);
      return;
  }
}

/** Запрос текста или файла: ждём 30 минут, помним в user_inputs (переживает рестарт, §14 п. 13). */
async function askInput(
  ctx: Context,
  deps: Deps,
  a: { userId: number; dealId: number; kind: 'change_request' | 'remarks' | 'receipt'; prompt: string },
): Promise<void> {
  await inTx((c) =>
    inputsRepo.set(c, { userId: a.userId, kind: a.kind, dealId: a.dealId, expiresAt: addMinutes(new Date(), INPUT_TTL_MINUTES) }),
  );
  await answerWithText(ctx, deps, a.prompt);
}

/** Ручное напоминание клиенту: не чаще раза в 4 часа на сделку (SPEC §5.5). */
const MANUAL_REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const lastManualReminder = new Map<number, number>();

async function remindClient(ctx: Context, deps: Deps, bundle: DealBundle): Promise<void> {
  const last = lastManualReminder.get(bundle.deal.id) ?? 0;
  if (Date.now() - last < MANUAL_REMINDER_COOLDOWN_MS) {
    await answerWithText(ctx, deps, 'Напоминание уже отправлено — следующее можно через 4 часа.');
    return;
  }
  const context = texts.statusText(bundle.deal.status, 'client', {
    prepaymentKopecks: bundle.version.prepaymentKopecks,
    remainingKopecks: remaining(bundle.version),
    scheduledAt: bundle.version.scheduledAt,
  });
  const sent = await notifyManualReminder(deps.max, bundle, context);
  if (sent) lastManualReminder.set(bundle.deal.id, Date.now());
  await answerWithText(ctx, deps, sent ? 'Напоминание отправлено клиенту.' : 'Клиент ещё не открывал бота — напоминание отправить некуда.');
}

/** Демо-режим: исполнитель проходит клиентскую сторону в своём же чате (SPEC §12). */
async function openAsClient(ctx: Context, deps: Deps, publicId: string, userId: number, chatId: number | null): Promise<void> {
  if (!cfg().DEMO_MODE) {
    await answerWithText(ctx, deps, texts.E1);
    return;
  }
  const result = await dealService.openAsClient({ publicId, sellerUserId: userId });
  await answerWithCard(ctx, deps, result.bundle, 'seller');
  await ensureCard(deps, result.bundle, 'client_demo', userId, chatId);
}

/** Квитанция по запросу кнопкой (доступна в терминальных статусах, SPEC §5.5). */
async function sendReceiptOnDemand(ctx: Context, deps: Deps, bundle: DealBundle): Promise<void> {
  if (!isTerminal(bundle.deal.status)) {
    await answerWithText(ctx, deps, 'Квитанция формируется после закрытия или отмены сделки.');
    return;
  }
  await answerWithText(ctx, deps, 'Готовлю квитанцию…');
  await renderAndSendReceipt(deps.max, bundle);
}

/**
 * Полностью оплаченная сделка: при tax_mode='none' чек не нужен — закрываем сразу (SPEC §5.2 T14 → T15)
 * и отправляем квитанцию обеим сторонам.
 */
export async function finishIfFullyPaid(deps: Deps, bundle: DealBundle): Promise<void> {
  if (bundle.deal.status !== 'paid') return;
  if (dealService.taxModeOf(bundle) !== 'none') return;
  const closed = await dealService.closeAutomatically(bundle.deal.id);
  const { syncCards } = await import('../cards.js');
  await syncCards(deps.max, closed.bundle);
  const { notifyForEvents } = await import('../notify.js');
  await notifyForEvents(deps.max, closed.bundle, closed.events);
  await renderAndSendReceipt(deps.max, closed.bundle);
}

