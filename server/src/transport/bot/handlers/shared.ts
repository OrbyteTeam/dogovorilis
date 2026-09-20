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
import type { CardRole, DealBundle, User } from '../../../types.js';
import type { Actor, ServiceResult } from '../../../domain/deal/service.js';
import { renderCard, sendCard, syncCards } from '../cards.js';
import { menuKeyboard } from '../keyboards.js';
import { notifyForEvents } from '../notify.js';

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
 * Ответ на нажатие: обновляем то же сообщение (POST /answers) — «живая карточка» (MAX_API §1 п. 12).
 * `note` — строка перед карточкой: так пользователь видит и реакцию на нажатие, и актуальное состояние
 * (SPEC §5.2 «ответ „уже сделано“» вместе с требованием E1 перерисовать карточку).
 */
export async function answerWithCard(
  ctx: Context,
  deps: Deps,
  bundle: DealBundle,
  role: CardRole,
  note?: string,
): Promise<void> {
  const { text, attachments } = renderCard(bundle, role);
  await deps.max.answer(ctx.callback!.callback_id, note ? `${note}\n\n${text}` : text, attachments as AttachmentRequest[]);
}

export async function answerWithText(ctx: Context, deps: Deps, text: string, keyboard?: AttachmentRequest): Promise<void> {
  await deps.max.answer(ctx.callback!.callback_id, text, keyboard ? [keyboard] : undefined);
}

/**
 * Довести результат перехода до обеих сторон: обновить нажатую карточку ответом, остальные — правкой,
 * затем отправить уведомления. Порядок важен: пользователь сначала видит реакцию на своё нажатие.
 */
export async function publishResult(
  ctx: Context,
  deps: Deps,
  result: ServiceResult,
  cardRole: CardRole,
): Promise<void> {
  const mid = pressedMid(ctx);
  const isCardPressed = mid ? await isCardMid(result.bundle.deal.id, mid) : false;

  if (ctx.update.update_type === 'message_callback') {
    if (isCardPressed) await answerWithCard(ctx, deps, result.bundle, cardRole, result.alreadyDone ? texts.ALREADY_DONE : undefined);
    else await answerWithText(ctx, deps, result.alreadyDone ? texts.ALREADY_DONE : shortAck(result));
  }
  await syncCards(deps.max, result.bundle, isCardPressed ? (mid ?? undefined) : undefined);
  if (!result.alreadyDone) await notifyForEvents(deps.max, result.bundle, result.events);
}

function shortAck(result: ServiceResult): string {
  return result.statusChanged ? 'Готово — карточка обновлена.' : 'Готово.';
}

async function isCardMid(dealId: number, mid: string): Promise<boolean> {
  const cards = await inTx((c) => cardsRepo.byDeal(c, dealId));
  return cards.some((card) => card.mid === mid);
}

/** Отправить карточку роли, если её ещё нет; иначе обновить существующую. */
export async function ensureCard(deps: Deps, bundle: DealBundle, role: CardRole, userId: number, chatId: number | null): Promise<void> {
  const cards = await inTx((c) => cardsRepo.byDeal(c, bundle.deal.id));
  const existing = cards.find((card) => card.role === role && card.userId === userId);
  if (!existing) {
    await sendCard(deps.max, bundle, role, { userId, chatId });
    return;
  }
  const { text, attachments } = renderCard(bundle, role);
  const ok = await deps.max.edit(existing.mid, text, attachments as AttachmentRequest[]);
  if (!ok && chatId) {
    const mid = await deps.max.send({ chatId }, text, attachments as AttachmentRequest[]);
    await inTx((c) => cardsRepo.updateMid(c, existing.id, mid));
  }
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
    await deps.max.answer(ctx.callback!.callback_id, text).catch(() => undefined);
  } else {
    const chatId = chatIdOf(ctx);
    if (chatId) await deps.max.send({ chatId }, text).catch(() => undefined);
  }
}

export function menu(): AttachmentRequest {
  const c = cfg();
  return menuKeyboard({ botUsername: c.MAX_BOT_USERNAME || 'bot', demoMode: c.DEMO_MODE });
}
