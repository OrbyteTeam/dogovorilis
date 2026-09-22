// Доведение результата домена до обеих сторон: карточки, уведомления N1–N16, квитанция PDF.
// Один путь на все источники — кнопка, ввод текста, вебхук провайдера, опрос планировщика, — чтобы
// закрытие сделки (T15) везде заканчивалось квитанцией, а не только там, где об этом вспомнили (ЗАДАЧА_03 F5).
import type { MaxGateway } from '../../integrations/max/gateway.js';
import * as dealService from '../../domain/deal/service.js';
import type { ServiceResult } from '../../domain/deal/service.js';
import type { ApplyResult } from '../../domain/payment/rails.js';
import { syncCards } from './cards.js';
import { notifyForEvents } from './notify.js';
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
  if (justClosed(result)) await renderAndSendReceipt(max, result.bundle);
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
