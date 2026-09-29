// Кнопки карточки сделки: все коды §13, кроме платёжных (они в payment.ts).
// Обработчик короткий: разобрать payload → определить роль по нажатой карточке → вызвать сервис → отрисовать.
import type { Context } from '@maxhub/max-bot-api';
import { botUsername, cfg } from '../../../config.js';
import { inTx } from '../../../db/pool.js';
import * as inputsRepo from '../../../db/repos/inputs.js';
import * as texts from '../../../texts.js';
import { isTerminal, type CardRole, type DealBundle } from '../../../types.js';
import { addMinutes } from '../../../domain/time.js';
import * as dealService from '../../../domain/deal/service.js';
import { acceptTimeProposal, INPUT_TTL_MINUTES } from '../../../domain/deal/service.js';
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
import {
  cancelReasonKeyboard,
  changeKindKeyboard,
  confirmKeyboard,
  editTermsButton,
  keyboard,
  noCommentKeyboard,
  otherTimeKeyboard,
} from '../keyboards.js';
import { clientName, deliver } from '../notify.js';
import { rateDeal } from '../../../domain/ratings.js';
import { publishNewVersion } from '../outcome.js';
import { syncCards } from '../cards.js';
import { remindClientNow, remindNote } from '../remind.js';
import type { ParsedCallback } from '../callbacks.js';

/** Какой роли принадлежит кнопка, если нажатое сообщение — не карточка (уведомление или напоминание). */
const CODE_ROLE: Record<string, 'seller' | 'client'> = {
  cf: 'client', cr: 'client', dc: 'client', ac: 'client', rm: 'client', pl: 'client', pt: 'client',
  dn: 'seller', fx: 'seller', rc: 'seller', nc: 'seller', ka: 'seller', rs: 'seller', tp: 'seller', rt: 'client',
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

    case 'cf': // `cf:<id>:<v>` — подтверждается версия с кнопки; без неё — версия 1 (карточки до T5, SPEC §13)
      await publishResult(ctx, deps, await dealService.confirm(parsed.publicId, actor, undefined, parsed.arg ? Number(parsed.arg) : 1), viewRole);
      return;

    case 'cr':
      // `cr:t` — «Написать текстом» (прежний ввод, T4); просто `cr` — выбор: календарь или текст (ЗАДАЧА_08 D).
      if (parsed.sub === 't') {
        await askInput(ctx, deps, bundle, viewRole, { userId, kind: 'change_request', prompt: texts.ASK_CHANGE_REQUEST });
      } else {
        await reply(ctx, deps, bundle, { role: viewRole, note: texts.ASK_CHANGE_KIND, keyboard: changeKindKeyboard(parsed.publicId) });
      }
      return;

    case 'tp':
      await acceptTime(ctx, deps, parsed.publicId, actor, viewRole, Number(parsed.arg));
      return;

    case 'rt': // оценка клиента после закрытия (ЗАДАЧА_08 E): `rt:<id>:<n>`, «Без комментария» — `rt:n:<id>`
      await rate(ctx, deps, bundle, viewRole, userId, parsed.sub === 'n' ? null : Number(parsed.arg));
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

/**
 * «✅ Принять {время}» (ЗАДАЧА_08 D, SPEC §7.10): новая версия с этим временем (T5), клиенту N4. Время успели занять —
 * предложение снято, исполнителю объяснение и «Изменить условия», клиенту — «выберите другое». Устарело — E1-ответ.
 */
async function acceptTime(ctx: Context, deps: Deps, publicId: string, actor: dealService.Actor, role: CardRole, proposalId: number): Promise<void> {
  const outcome = await acceptTimeProposal(publicId, actor, proposalId, cfg().APP_TIMEZONE);
  if (outcome.kind === 'accepted') {
    const skipMid = await reply(ctx, deps, outcome.result.bundle, { role, note: texts.TIME_ACCEPTED_ACK });
    await publishNewVersion(deps.max, outcome.result, { skipMid, sellerNote: false });
    return;
  }
  if (outcome.kind === 'taken') {
    const b = outcome.bundle;
    const skipMid = await reply(ctx, deps, b, { role, note: texts.TIME_TAKEN_SELLER, keyboard: keyboard([[editTermsButton(botUsername(), publicId)]]) });
    await syncCards(deps.max, b, skipMid);
    await deliver(deps.max, b, {
      to: 'client',
      text: texts.TIME_TAKEN_CLIENT({ id: publicId, at: outcome.proposal.scheduledAt }),
      keyboard: otherTimeKeyboard(publicId),
    });
    return;
  }
  await reply(ctx, deps, outcome.bundle, { role, note: texts.TIME_STALE });
}

/**
 * Оценка 1–5 (SPEC §7.11): один раз на сделку; после неё — необязательный комментарий (ввод 30 минут) и R2
 * исполнителю. `score = null` — «Без комментария»: снять ожидание и поблагодарить.
 */
async function rate(ctx: Context, deps: Deps, bundle: DealBundle, role: CardRole, userId: number, score: number | null): Promise<void> {
  if (score === null) {
    await inTx((c) => inputsRepo.clearIf(c, { userId, kind: 'rating_comment', dealId: bundle.deal.id }));
    await reply(ctx, deps, bundle, { role, note: texts.RATING_DONE });
    return;
  }
  const outcome = await rateDeal(bundle.deal.publicId, userId, score);
  if (!outcome.created) {
    await reply(ctx, deps, bundle, { role, note: texts.RATING_ALREADY });
    return;
  }
  await inTx((c) =>
    inputsRepo.set(c, { userId, kind: 'rating_comment', dealId: bundle.deal.id, expiresAt: addMinutes(new Date(), INPUT_TTL_MINUTES) }),
  );
  await reply(ctx, deps, bundle, { role, note: texts.RATING_THANKS(score), keyboard: noCommentKeyboard(bundle.deal.publicId) });
  await deliver(deps.max, bundle, { to: 'seller', text: texts.R2({ client: clientName(bundle), id: bundle.deal.publicId, score }) });
}

/** Ручное напоминание клиенту: не чаще раза в 4 часа на сделку, счётчик общий с мини-приложением (SPEC §5.5). */
async function remindClient(ctx: Context, deps: Deps, bundle: DealBundle, role: CardRole): Promise<void> {
  const outcome = await remindClientNow(deps.max, bundle);
  await reply(ctx, deps, bundle, { role, note: remindNote(outcome) });
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
