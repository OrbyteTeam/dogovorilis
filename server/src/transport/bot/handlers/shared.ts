// Общее для всех обработчиков: кто нажал, в какой роли, как ответить и как разложить ошибку в текст.
// Обработчик обязан быть коротким: распарсить → вызвать сервис → отрисовать.
import type { Context } from '@maxhub/max-bot-api';
import { cfg } from '../../../config.js';
import { inTx } from '../../../db/pool.js';
import * as cardsRepo from '../../../db/repos/cards.js';
import * as usersRepo from '../../../db/repos/users.js';
import { AppError, ForbiddenError, InvalidTransition } from '../../../errors.js';
import type { AttachmentRequest, MaxGateway } from '../../../integrations/max/gateway.js';
import { log } from '../../../logger.js';
import * as texts from '../../../texts.js';
import type { CardMessage, CardRole, DealBundle, User } from '../../../types.js';
import * as dealService from '../../../domain/deal/service.js';
import type { Actor, ServiceResult } from '../../../domain/deal/service.js';
import { parseCallback } from '../callbacks.js';
import { renderCard, sendCard } from '../cards.js';
import { menuKeyboard } from '../keyboards.js';
import { publishOutcome } from '../outcome.js';

export type Deps = { max: MaxGateway };

/** Пользователь из события + обновление chat_id диалога (без него мы не сможем ему писать). */
export async function touchUser(ctx: Context, chatId: number | null): Promise<User> {
  const u = ctx.user;
  if (!u) throw new Error('в событии нет пользователя');
  return inTx(async (c) => {
    const user = await usersRepo.upsertFromMax(c, {
      maxUserId: u.user_id,
      firstName: u.first_name ?? '',
      lastName: u.last_name ?? null,
      username: u.username ?? null,
    });
    if (chatId && user.dialogChatId !== chatId) {
      await usersRepo.setDialogChatId(c, u.user_id, chatId);
      return { ...user, dialogChatId: chatId };
    }
    return user;
  });
}

/** chat_id для ответа: в message_callback он лежит в update.message.recipient (CONTRACTS §1.5). */
export function chatIdOf(ctx: Context): number | null {
  try {
    return ctx.chatId ?? null;
  } catch {
    return null;
  }
}

/**
 * Роль действующего лица. Определяется по карточке, в которой нажали кнопку: в демо-режиме
 * исполнитель и клиент — один пользователь, и только сообщение отличает «клиентское» действие
 * от «исполнительского» (SPEC §12).
 */
export async function actingRole(
  dealId: number,
  userId: number,
  pressedMid: string | null,
  fallback: 'seller' | 'client',
): Promise<{ role: 'seller' | 'client'; cardRole: CardRole | null }> {
  if (pressedMid) {
    const cards = await inTx((c) => cardsRepo.byDeal(c, dealId));
    const pressed = cards.find((card) => card.mid === pressedMid);
    if (pressed) {
      return { role: pressed.role === 'seller' ? 'seller' : 'client', cardRole: pressed.role };
    }
  }
  return { role: fallback, cardRole: null };
}

export function actorOf(userId: number, role: 'seller' | 'client'): Actor {
  return { userId, role };
}

export function pressedMid(ctx: Context): string | null {
  return ctx.update.update_type === 'message_callback' ? (ctx.update.message?.body.mid ?? null) : null;
}

/**
 * Какую карточку этой сделки нажали. null — нажали не на карточке: уведомление, меню, список /deals,
 * пересланное чужое сообщение. От этого зависит форма ответа (SPEC §6.4).
 */
export async function pressedCard(ctx: Context, dealId: number): Promise<CardMessage | null> {
  if (ctx.update.update_type !== 'message_callback') return null;
  const mid = pressedMid(ctx);
  if (!mid) return null;
  const cards = await inTx((c) => cardsRepo.byDeal(c, dealId));
  return cards.find((card) => card.mid === mid) ?? null;
}

/**
 * Ответ на нажатие перерисованной карточкой. POST /answers ПРАВИТ нажатое сообщение (MAX_API §1 п. 12),
 * поэтому ответ на кнопку карточки обязан сам быть карточкой: всё, что мы хотим сказать, — заметкой
 * над ней (`note`), иначе реакция либо затрёт кнопки, либо её тут же затрёт syncCards.
 */
export async function answerWithCard(
  ctx: Context,
  deps: Deps,
  bundle: DealBundle,
  role: CardRole,
  o: { note?: string; keyboard?: AttachmentRequest } = {},
): Promise<void> {
  const { text, attachments } = renderCard(bundle, role, o);
  await deps.max.answer(ctx.callback!.callback_id, text, attachments);
}

export async function answerWithText(ctx: Context, deps: Deps, text: string, keyboard?: AttachmentRequest): Promise<void> {
  await deps.max.answer(ctx.callback!.callback_id, text, keyboard ? [keyboard] : undefined);
}

/**
 * Единое правило ответа на нажатие (SPEC §6.4): нажали на карточке — отвечаем карточкой (с заметкой
 * и, для подтверждений, со своей клавиатурой); нажали вне карточки — текстом `text` (по умолчанию — та же
 * заметка). Возвращает mid нажатой карточки, чтобы syncCards её не перезаписал.
 */
export async function reply(
  ctx: Context,
  deps: Deps,
  bundle: DealBundle,
  o: { role: CardRole; note?: string; text?: string; keyboard?: AttachmentRequest },
): Promise<string | undefined> {
  if (ctx.update.update_type !== 'message_callback') return undefined;
  const card = await pressedCard(ctx, bundle.deal.id);
  if (card) {
    await answerWithCard(ctx, deps, bundle, card.role, { note: o.note, keyboard: o.keyboard });
    return card.mid;
  }
  await answerWithText(ctx, deps, o.text ?? o.note ?? 'Готово.', o.keyboard);
  return undefined;
}

/**
 * Довести результат перехода до обеих сторон: обновить нажатую карточку ответом, остальные — правкой,
 * затем уведомления и, если сделка закрылась, квитанция PDF (outcome.publishOutcome).
 * Порядок важен: пользователь сначала видит реакцию на своё нажатие.
 */
export async function publishResult(
  ctx: Context,
  deps: Deps,
  result: ServiceResult,
  cardRole: CardRole,
  note?: string,
): Promise<void> {
  const skip = await reply(ctx, deps, result.bundle, {
    role: cardRole,
    note: result.alreadyDone ? texts.ALREADY_DONE : note,
    text: result.alreadyDone ? texts.ALREADY_DONE : (note ?? shortAck(result)),
  });
  await publishOutcome(deps.max, result, skip);
}

function shortAck(result: ServiceResult): string {
  return result.statusChanged ? 'Готово — карточка обновлена.' : 'Готово.';
}

/**
 * Отправить карточку роли, если её ещё нет; иначе обновить существующую.
 * Возвращает `true`, если в чате появилось НОВОЕ сообщение: правка на месте пользователю
 * не видна, и вызывающий должен сам решить, чем отчитаться о нажатии.
 */
export async function ensureCard(
  deps: Deps,
  bundle: DealBundle,
  role: CardRole,
  userId: number,
  chatId: number | null,
): Promise<boolean> {
  const cards = await inTx((c) => cardsRepo.byDeal(c, bundle.deal.id));
  const existing = cards.find((card) => card.role === role && card.userId === userId);
  if (!existing) {
    const mid = await sendCard(deps.max, bundle, role, { userId, chatId });
    return mid !== null;
  }
  const { text, attachments } = renderCard(bundle, role);
  const ok = await deps.max.edit(existing.mid, text, attachments as AttachmentRequest[]);
  if (!ok && chatId) {
    const mid = await deps.max.send({ chatId }, text, attachments as AttachmentRequest[]);
    await inTx((c) => cardsRepo.updateMid(c, existing.id, mid));
    return true;
  }
  return false;
}

/** Ошибка → текст для пользователя (SPEC §6.7). Любая неизвестная ошибка — E10, процесс не падает. */
export function errorText(e: unknown): string {
  if (e instanceof InvalidTransition) {
    if (e.reason === 'client_cancel_locked') return texts.E7;
    if (e.reason === 'already_done') return texts.ALREADY_DONE;
    return texts.E1;
  }
  if (e instanceof ForbiddenError) {
    if (e.message === 'other_client') return texts.E3;
    if (e.message === 'self_is_seller') return texts.E1;
    return texts.E1;
  }
  if (e instanceof AppError) {
    switch (e.code) {
      case 'rail_unavailable':
        return texts.E11;
      case 'payout_details_empty':
        return texts.E12;
      case 'claim_too_soon':
        return texts.E13;
      case 'provider_failed':
        return texts.E9;
      case 'link_in_progress':
        return texts.LINK_IN_PROGRESS;
      case 'deal_not_found':
        return texts.E2;
      case 'demo_deal':
        return texts.E4;
      case 'input_too_long':
        return texts.E5;
      case 'input_not_a_file':
        return texts.E6;
      case 'input_expired':
        return texts.E8;
      case 'validation':
        return e.message;
      case 'trial_limit':
        return texts.TOO_MANY_TRIALS;
      default:
        return texts.E10;
    }
  }
  return texts.E10;
}

/** Ответ на ошибку внутри обработчика кнопки. Сценарий не должен оказываться в тупике. */
export async function answerError(ctx: Context, deps: Deps, e: unknown): Promise<void> {
  const text = errorText(e);
  log.warn({ err: (e as Error).message, update: ctx.update.update_type }, 'обработчик ответил ошибкой');
  if (ctx.update.update_type === 'message_callback') {
    await answerCallbackProblem(ctx, deps, text);
  } else {
    const chatId = chatIdOf(ctx);
    if (chatId) await deps.max.send({ chatId }, text).catch(() => undefined);
  }
}

/**
 * Ошибка в ответ на кнопку. Если нажали на карточке, текст ошибки встаёт заметкой над свежей карточкой:
 * иначе ответ затёр бы карточку текстом без кнопок (E1/E9/E11…), и из сделки было бы не выйти.
 * Любая проблема на этом пути — откат к простому тексту; ответ пользователю важнее формы.
 */
export async function answerCallbackProblem(ctx: Context, deps: Deps, text: string, fallback?: AttachmentRequest): Promise<void> {
  try {
    const parsed = parseCallback(ctx.callback?.payload);
    if (parsed?.kind === 'deal') {
      const bundle = await dealService.getBundle(parsed.publicId);
      const card = await pressedCard(ctx, bundle.deal.id);
      if (card) {
        await answerWithCard(ctx, deps, bundle, card.role, { note: text });
        return;
      }
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'ошибку не удалось показать над карточкой — отвечаем текстом');
  }
  // Кнопки меню (демо, сделка-пример, помощь) живут в сообщении с меню: не оставляем человека без него.
  const menuPress = parseCallback(ctx.callback?.payload)?.kind !== 'deal';
  const keyboard = fallback ?? (menuPress ? menu() : undefined);
  await deps.max.answer(ctx.callback!.callback_id, text, keyboard ? [keyboard] : undefined).catch(() => undefined);
}

export function menu(): AttachmentRequest {
  const c = cfg();
  return menuKeyboard({ botUsername: c.MAX_BOT_USERNAME || 'bot', demoMode: c.DEMO_MODE });
}
