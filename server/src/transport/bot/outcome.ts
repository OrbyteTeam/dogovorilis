// Доведение результата домена до обеих сторон: карточки, уведомления N1–N16, квитанция PDF.
// Один путь на все источники — кнопка, ввод текста, вебхук провайдера, опрос планировщика, — чтобы
// закрытие сделки (T15) везде заканчивалось квитанцией, а не только там, где об этом вспомнили (ЗАДАЧА_03 F5).
import type { MaxGateway } from '../../integrations/max/gateway.js';
import * as dealService from '../../domain/deal/service.js';
import type { ServiceResult } from '../../domain/deal/service.js';
import type { ApplyResult } from '../../domain/payment/rails.js';
import { dealLink } from '../../config.js';
import { log } from '../../logger.js';
import * as texts from '../../texts.js';
import type { DealBundle } from '../../types.js';
import { displayName, sendCard, syncCards } from './cards.js';
import { openKeyboard, ratingKeyboard } from './keyboards.js';
import { deliver, notifyForEvents } from './notify.js';
import { renderAndSendReceipt } from './receipt.js';

/** Сделка закрылась именно этим результатом (T15): пора отправлять квитанцию. */
export function justClosed(result: ServiceResult): boolean {
  return !result.alreadyDone && result.events.some((e) => e.type === 'deal.closed');
}

/**
 * Карточки (кроме уже обновлённой ответом на нажатие — `skipMid`), затем уведомления, затем квитанция.
 * Повтор (alreadyDone) только перерисовывает карточки: уведомлений и квитанции второй раз не будет.
 */
export async function publishOutcome(max: MaxGateway, result: ServiceResult, skipMid?: string): Promise<void> {
  await syncCards(max, result.bundle, skipMid);
  if (result.alreadyDone) return;
  await notifyForEvents(max, result.bundle, result.events);
  if (justClosed(result)) {
    await renderAndSendReceipt(max, result.bundle);
    await askRating(max, result.bundle);
  }
}

/**
 * R1 (ЗАДАЧА_08 E, SPEC §7.11): после закрытия клиенту — одна просьба оценить, после квитанции. Сбой отправки
 * сделку не трогает: оценка необязательна. У сделки без клиента оценивать некому.
 */
export async function askRating(max: MaxGateway, bundle: DealBundle): Promise<void> {
  if (!bundle.deal.clientUserId) return;
  try {
    await deliver(max, bundle, {
      to: 'client',
      text: texts.R1({ id: bundle.deal.publicId, title: bundle.version.title }),
      keyboard: ratingKeyboard(bundle.deal.publicId),
    });
  } catch (e) {
    log.warn({ deal: bundle.deal.publicId, err: (e as Error).message }, 'просьба оценить не доставлена');
  }
}

/**
 * Статус платежа применён не нажатием кнопки (вебхук, опрос): переход — как любой другой результат,
 * отмена провайдером — перерисовка карточек, поздняя оплата по отменённой сделке — «верните деньги» обеим.
 */
export async function publishPaymentUpdate(max: MaxGateway, applied: ApplyResult): Promise<void> {
  if (applied.transition) {
    await publishOutcome(max, applied.transition);
  } else if (applied.changed) {
    await syncCards(max, await dealService.getBundleById(applied.payment.dealId));
  }
  await notifyPaymentEvents(max, applied);
}

/** Уведомления по событиям самого платежа (не перехода): сейчас это только поздняя оплата с возвратом. */
export async function notifyPaymentEvents(max: MaxGateway, applied: ApplyResult): Promise<void> {
  if (!applied.events.length) return;
  const bundle = applied.transition?.bundle ?? (await dealService.getBundleById(applied.payment.dealId));
  await notifyForEvents(max, bundle, applied.events);
}

/**
 * T5 из мини-приложения (PUT /api/deals/:id): обе карточки перерисованы (у клиента снова «Подтверждаю» с новой
 * версией), клиенту N4 с перечнем изменений, исполнителю в чат — дошла ли версия до клиента (N4a).
 * Сбой доставки версию не отменяет: она уже записана, повтор запроса вернул бы 409 no_changes.
 */
export async function publishNewVersion(
  max: MaxGateway,
  result: ServiceResult,
  /** Принятие времени кнопкой (ЗАДАЧА_08 D): нажатая карточка уже перерисована ответом, исполнитель уже знает итог. */
  o: { skipMid?: string; sellerNote?: boolean } = {},
): Promise<{ clientNotified: boolean }> {
  const { bundle } = result;
  try {
    await syncCards(max, bundle, o.skipMid);
    const delivered = await notifyForEvents(max, bundle, result.events);
    const clientNotified = delivered.some((d) => d.to === 'client' && d.delivered);
    if (o.sellerNote === false) return { clientNotified };
    const client = clientNotified ? 'notified' : bundle.deal.clientUserId === null ? 'no_client' : 'not_delivered';
    const text = texts.TERMS_UPDATED({ id: bundle.deal.publicId, version: bundle.deal.currentVersion, client });
    await deliver(max, bundle, { to: 'seller', text, keyboard: openKeyboard(bundle.deal.publicId) });
    return { clientNotified };
  } catch (e) {
    log.warn({ deal: bundle.deal.publicId, err: (e as Error).message }, 'новая версия записана, но не доставлена сторонам');
    return { clientNotified: false };
  }
}

/**
 * «🔁 Повторить» с тем же клиентом (ЗАДАЧА_04 F): клиент уже привязан — приветствие и его карточка уходят ему в
 * диалог сразу, без ссылки; исполнителю — что карточка отправлена. Не дошло — исполнителю ссылка, которая
 * откроет карточку у этого клиента (повторный вход привязанного клиента идемпотентен, SPEC §6.3).
 */
export async function sendRepeatToClient(max: MaxGateway, bundle: DealBundle): Promise<boolean> {
  const client = bundle.client;
  if (!client?.dialogChatId) return false;
  const name = displayName(client.firstName, client.lastName);
  const sellerName = bundle.sellerProfile?.displayName || displayName(bundle.seller.firstName, bundle.seller.lastName);
  let sent = false;
  try {
    await max.send({ chatId: client.dialogChatId }, texts.S2_REPEAT(sellerName));
    sent = (await sendCard(max, bundle, 'client', { userId: client.maxUserId, chatId: client.dialogChatId })) !== null;
  } catch (e) {
    log.warn({ deal: bundle.deal.publicId, err: (e as Error).message }, 'карточка повторной сделки не доставлена клиенту');
  }
  const text = sent ? texts.REPEAT_CARD_SENT(name) : texts.REPEAT_CARD_FAILED(name, dealLink(bundle.deal.publicId));
  await deliver(max, bundle, { to: 'seller', text });
  return sent;
}
