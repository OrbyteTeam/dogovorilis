// Ожидаемый ввод текста и файла (SPEC §6.6). Состояние — в таблице user_inputs, а не в памяти процесса:
// перезапуск во время ожидания не ломает сценарий (§14 п. 13).
import type { Bot, Context } from '@maxhub/max-bot-api';
import type { Attachment } from '@maxhub/max-bot-api/types';
import { inTx } from '../../../db/pool.js';
import * as inputsRepo from '../../../db/repos/inputs.js';
import * as dealsRepo from '../../../db/repos/deals.js';
import { log } from '../../../logger.js';
import * as texts from '../../../texts.js';
import type { CardRole } from '../../../types.js';
import * as dealService from '../../../domain/deal/service.js';
import { publishOutcome } from '../outcome.js';
import { clientName, deliver } from '../notify.js';
import { commentRating, RATING_COMMENT_MAX } from '../../../domain/ratings.js';
import { actingRole, actorOf, answerError, chatIdOf, menu, touchUser, type Deps } from './shared.js';

const MAX_TEXT_LENGTH = 500;
const MAX_REASON_LENGTH = 300;
const MAX_RECEIPT_BYTES = 20 * 1024 * 1024; // §6.6: ≤ 20 МБ
const RECEIPT_EXT = /\.(pdf|jpe?g|png)$/i;

/**
 * ДОЛЖЕН регистрироваться ДО любого bot.command: SDK 0.3.1 падает на message_created с body.text === null
 * («Cannot read properties of null (reading 'startsWith')» в фильтре команд), а именно так приходит
 * сообщение с одним вложением — то есть чек фотографией. Проверено на 0.3.1, в CONTRACTS §1.14 не описано.
 * Такие сообщения командам не нужны, поэтому перехватываем их здесь и дальше по цепочке не пускаем.
 */
export function registerTextlessGuard(bot: Bot, deps: Deps): void {
  bot.on('message_created', async (ctx, next) => {
    if (typeof ctx.message?.body.text === 'string') return next();
    try {
      await handleMessage(ctx, deps);
    } catch (e) {
      await answerError(ctx, deps, e);
    }
  });
}

/** Регистрируется ПОСЛЕ команд: сюда попадает текст, который не является командой. */
export function registerInput(bot: Bot, deps: Deps): void {
  bot.on('message_created', async (ctx) => {
    try {
      const text = ctx.message?.body.text ?? null;
      if (text && text.trimStart().startsWith('/')) return; // команды уже обработаны выше
      await handleMessage(ctx, deps);
    } catch (e) {
      await answerError(ctx, deps, e);
    }
  });
}

async function handleMessage(ctx: Context, deps: Deps): Promise<void> {
  const userId = ctx.user?.user_id;
  const chatId = chatIdOf(ctx);
  if (!userId || !chatId) return;
  await touchUser(ctx, chatId);

  const pending = await inTx((c) => inputsRepo.get(c, userId));
  if (!pending) {
    // Любое сообщение вне ожидания ввода — S3 и меню (§6.6).
    await deps.max.send({ chatId }, texts.S3, [menu()]);
    return;
  }
  if (pending.expiresAt.getTime() <= Date.now()) {
    await inTx((c) => inputsRepo.clear(c, userId));
    await deps.max.send({ chatId }, texts.E8, [menu()]);
    return;
  }

  const deal = pending.dealId ? await inTx((c) => dealsRepo.byId(c, pending.dealId!)) : null;
  if (!deal) {
    await inTx((c) => inputsRepo.clear(c, userId));
    await deps.max.send({ chatId }, texts.E2, [menu()]);
    return;
  }

  const clientKinds = ['change_request', 'remarks', 'rating_comment'];
  const { role, cardRole } = await actingRole(deal.id, userId, null, clientKinds.includes(pending.kind) ? 'client' : 'seller');
  const actor = actorOf(userId, role);
  const viewRole: CardRole = cardRole ?? (role === 'client' && deal.demo ? 'client_demo' : role);

  switch (pending.kind) {
    case 'change_request':
    case 'remarks': {
      const text = (ctx.message?.body.text ?? '').trim();
      if (!text) {
        await deps.max.send({ chatId }, texts.INPUT_NEED_TEXT);
        return;
      }
      if (text.length > MAX_TEXT_LENGTH) {
        await deps.max.send({ chatId }, texts.E5);
        return;
      }
      await inTx((c) => inputsRepo.clear(c, userId));
      const result =
        pending.kind === 'change_request'
          ? await dealService.requestChanges(deal.publicId, actor, text)
          : await dealService.remarks(deal.publicId, actor, text);
      await deps.max.send({ chatId }, pending.kind === 'change_request' ? texts.CHANGE_REQUEST_SENT : texts.REMARKS_SENT);
      await publishOutcome(deps.max, result);
      return;
    }

    case 'cancel_reason': {
      const text = (ctx.message?.body.text ?? '').trim();
      if (text.length > MAX_REASON_LENGTH) {
        await deps.max.send({ chatId }, texts.E5);
        return;
      }
      await inTx((c) => inputsRepo.clear(c, userId));
      const result = await dealService.cancel(deal.publicId, actor, text || null);
      await deps.max.send({ chatId }, texts.CANCELLED_ACK(deal.publicId));
      await publishOutcome(deps.max, result);
      return;
    }

    case 'rating_comment': {
      // Комментарий к оценке (ЗАДАЧА_08 E, SPEC §7.11): один раз, до 500 символов, исполнителю — R3.
      const text = (ctx.message?.body.text ?? '').trim();
      if (!text) {
        await deps.max.send({ chatId }, 'Нужен текст одним сообщением.');
        return;
      }
      if (text.length > RATING_COMMENT_MAX) {
        await deps.max.send({ chatId }, texts.RATING_COMMENT_TOO_LONG);
        return;
      }
      await inTx((c) => inputsRepo.clear(c, userId));
      const saved = await commentRating(deal.id, userId, text);
      await deps.max.send({ chatId }, saved ? texts.RATING_COMMENT_SAVED : texts.RATING_ALREADY);
      if (saved) {
        const bundle = await dealService.getBundleById(deal.id);
        await deliver(deps.max, bundle, { to: 'seller', text: texts.R3({ client: clientName(bundle), id: deal.publicId, comment: text }) });
      }
      return;
    }

    case 'receipt': {
      const attachment = pickReceipt(ctx.message?.body.attachments ?? null);
      if (!attachment) {
        await deps.max.send({ chatId }, texts.E6);
        return;
      }
      await inTx((c) => inputsRepo.clear(c, userId));
      const result = await dealService.attachReceipt({
        publicId: deal.publicId,
        actor,
        attachmentType: attachment.type,
        maxToken: attachment.token,
        maxUrl: attachment.url,
        fileName: attachment.fileName,
      });
      await deps.max.send({ chatId }, texts.RECEIPT_ACCEPTED);
      await publishOutcome(deps.max, result); // карточки, N14 и квитанция PDF (T15)
      log.info({ deal: deal.publicId, role: viewRole }, 'чек приложен, сделка закрыта');
      return;
    }

    default:
      await inTx((c) => inputsRepo.clear(c, userId));
      await deps.max.send({ chatId }, texts.S3, [menu()]);
  }
}

type ReceiptAttachment = { type: 'image' | 'file'; token: string; url: string | null; fileName: string | null };

/** Подходит фото или файл pdf/jpg/png до 20 МБ (§6.6). Остальные вложения — E6. */
export function pickReceipt(attachments: Attachment[] | null): ReceiptAttachment | null {
  if (!attachments?.length) return null;
  for (const a of attachments) {
    if (a.type === 'image') {
      return { type: 'image', token: a.payload.token, url: a.payload.url ?? null, fileName: null };
    }
    if (a.type === 'file') {
      const name = a.filename ?? '';
      if (name && !RECEIPT_EXT.test(name)) continue;
      if (typeof a.size === 'number' && a.size > MAX_RECEIPT_BYTES) continue;
      return { type: 'file', token: a.payload.token, url: a.payload.url ?? null, fileName: name || null };
    }
  }
  return null;
}
