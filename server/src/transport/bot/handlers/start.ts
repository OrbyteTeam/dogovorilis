// /start и вход клиента по диплинку (SPEC §6.2, §6.3).
// Источника события два: bot_started с payload и message_created с текстом «/start d_<id>» —
// документация не описывает, какое приходит существующему собеседнику, поэтому обрабатываем оба (§6.3).
import type { Bot, Context } from '@maxhub/max-bot-api';
import { cfg } from '../../../config.js';
import { inTx } from '../../../db/pool.js';
import * as usersRepo from '../../../db/repos/users.js';
import { ForbiddenError, NotFoundError } from '../../../errors.js';
import { log } from '../../../logger.js';
import * as texts from '../../../texts.js';
import { isTerminal } from '../../../types.js';
import { parseDealPayload } from '../../../domain/ids.js';
import * as dealService from '../../../domain/deal/service.js';
import { syncCards } from '../cards.js';
import { ensureCard } from './shared.js';
import { answerError, chatIdOf, menu, touchUser, type Deps } from './shared.js';
import { notifyForEvents } from '../notify.js';

export function registerStart(bot: Bot, deps: Deps): void {
  bot.on('bot_started', async (ctx) => {
    const chatId = ctx.update.chat_id;
    await handleStart(ctx, deps, ctx.startPayload ?? null, chatId);
  });

  // Строковый триггер ловит только точное совпадение, «/start d_Ab12…» им не поймать (CONTRACTS §1.4).
  bot.command(/^start(?:\s+(.+))?$/, async (ctx) => {
    await handleStart(ctx, deps, ctx.match?.[1]?.trim() ?? null, chatIdOf(ctx));
  });

  // Диалог очищен или бот остановлен — писать этому пользователю больше нельзя до следующего /start.
  bot.on(['bot_stopped', 'dialog_cleared', 'dialog_removed'], async (ctx) => {
    const userId = ctx.user?.user_id;
    if (!userId) return;
    await inTx((c) => usersRepo.setDialogChatId(c, userId, null));
    log.info({ user: userId, event: ctx.update.update_type }, 'диалог закрыт: уведомления приостановлены');
  });
}

async function handleStart(ctx: Context, deps: Deps, payload: string | null, chatId: number | null): Promise<void> {
  try {
    const user = await touchUser(ctx, chatId);
    const publicId = parseDealPayload(payload);
    log.info({ user: user.maxUserId, payload, deeplink: publicId, source: ctx.update.update_type }, 'старт');

    if (!publicId) {
      if (!chatId) return;
      await deps.max.send({ chatId }, texts.S1, [menu()]);
      return;
    }
    await joinByLink(ctx, deps, publicId, user.maxUserId, chatId);
  } catch (e) {
    await answerError(ctx, deps, e);
  }
}

/** Порядок проверок и тексты — строго по SPEC §6.3. */
async function joinByLink(
  ctx: Context,
  deps: Deps,
  publicId: string,
  userId: number,
  chatId: number | null,
): Promise<void> {
  let bundle;
  try {
    bundle = await dealService.getBundle(publicId);
  } catch (e) {
    if (e instanceof NotFoundError) {
      if (chatId) await deps.max.send({ chatId }, texts.E2, [menu()]);
      return;
    }
    throw e;
  }

  const deal = bundle.deal;

  // 2. Исполнитель открыл свою же ссылку — показываем его карточку (а в демо ещё и клиентскую).
  // Если карточки уже есть, ensureCard правит их НА МЕСТЕ — в чате не появляется ничего нового,
  // и человек, нажавший ссылку, остаётся без ответа. Поэтому в этом случае отвечаем строкой S4
  // (найдено живым прогоном 21.09: проверяющий открывает ссылку сам, а не шлёт её второму аккаунту).
  if (deal.sellerUserId === userId) {
    const sentSeller = await ensureCard(deps, bundle, 'seller', userId, chatId);
    const sentClient = deal.demo ? await ensureCard(deps, bundle, 'client_demo', userId, chatId) : false;
    if (!sentSeller && !sentClient && chatId) {
      await deps.max.send({ chatId }, texts.S4(publicId, deal.demo));
    }
    return;
  }

  // 3. Демо-сделка: посторонний присоединиться не может.
  // Проверяется РАНЬШЕ, чем «занята другим клиентом», хотя §6.3 перечисляет их в обратном порядке:
  // в демо клиент — это сам исполнитель, поэтому буквальный порядок дал бы E3 вместо требуемого §12 текста E4.
  if (deal.demo) {
    if (chatId) await deps.max.send({ chatId }, texts.E4, [menu()]);
    return;
  }

  // 4. По ссылке уже подтверждает другой клиент.
  if (deal.clientUserId && deal.clientUserId !== userId) {
    if (chatId) await deps.max.send({ chatId }, texts.E3, [menu()]);
    return;
  }

  // 5. Сделка уже завершена — карточка без кнопок и пояснение.
  if (isTerminal(deal.status)) {
    await ensureCard(deps, bundle, 'client', userId, chatId);
    if (chatId) await deps.max.send({ chatId }, texts.DEAL_FINISHED_LINE);
    return;
  }

  // 6. T2: привязываем клиента, здороваемся (S2) и отправляем клиентскую карточку.
  try {
    const result = await dealService.joinClient({ publicId, userId });
    const sellerName =
      result.bundle.sellerProfile?.displayName ??
      [result.bundle.seller.firstName, result.bundle.seller.lastName].filter(Boolean).join(' ');
    if (chatId && !result.alreadyDone) await deps.max.send({ chatId }, texts.S2(sellerName));
    await ensureCard(deps, result.bundle, 'client', userId, chatId);
    if (!result.alreadyDone) {
      // Карточка исполнителя должна показать «Клиент: <имя>» сразу, не дожидаясь его действий (§6.5).
      await syncCards(deps.max, result.bundle);
      await notifyForEvents(deps.max, result.bundle, result.events);
    }
  } catch (e) {
    if (e instanceof ForbiddenError && e.message === 'other_client') {
      if (chatId) await deps.max.send({ chatId }, texts.E3, [menu()]);
      return;
    }
    throw e;
  }
}

export const startPayloadHint = () => `https://max.ru/${cfg().MAX_BOT_USERNAME || 'bot'}?start=d_<id>`;
