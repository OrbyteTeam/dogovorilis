// Задание `payments-poll` (SPEC §10.3): опрос ссылочных платежей в статусе pending.
//
// Зачем оно, если есть вебхук: вебхук ЮKassa требует публичный HTTPS и порт 443 (CONTRACTS §2.5),
// а локально бот работает по long polling без домена — там уведомление не доходит в принципе.
// Опрос делает сценарий проходимым и локально, и на сервере, если вебхук потерялся.
//
// Ограничения из §10.3: не чаще раза в 60 с на платёж (метка — payments.updated_at, её двигает
// applyProviderStatus даже при неизменившемся статусе), истёкшие → `expired` + перерисовка карточки.
import { cfg } from '../../config.js';
import { inTx } from '../../db/pool.js';
import * as paymentsRepo from '../../db/repos/payments.js';
import { IntegrationError } from '../../errors.js';
import type { MaxGateway } from '../../integrations/max/gateway.js';
import { log } from '../../logger.js';
import * as dealService from '../../domain/deal/service.js';
import * as rails from '../../domain/payment/rails.js';
import { syncCards } from '../../transport/bot/cards.js';
import { notifyForEvents } from '../../transport/bot/notify.js';

/** Сколько платежей опрашиваем за тик: провайдеру хватает, а тик остаётся быстрым (SPEC §17). */
export const BATCH = 20;

export async function pollLinkPayments(max: MaxGateway | null, now = new Date()): Promise<void> {
  if (cfg().PAYMENT_PROVIDER === 'none') return;

  const due = await inTx((c) => paymentsRepo.dueForPolling(c, now, BATCH));
  if (!due.length) return;

  for (const payment of due) {
    try {
      // Истёкшие не опрашиваем — у провайдера они уже мертвы, а клиенту нужна новая ссылка.
      if (rails.isExpired(payment, now)) {
        const expired = await rails.expirePayment(payment.id, now);
        if (expired && max) await syncCards(max, await dealService.getBundleById(payment.dealId));
        log.info({ payment: payment.id, deal: payment.dealId }, 'ссылка на оплату истекла');
        continue;
      }

      const result = await rails.refreshFromProvider(payment.id, now);
      if (!max) continue;
      if (result.transition) {
        await syncCards(max, result.transition.bundle);
        await notifyForEvents(max, result.transition.bundle, result.transition.events);
      } else if (result.changed) {
        await syncCards(max, await dealService.getBundleById(payment.dealId));
      }
    } catch (e) {
      // Провайдер лежит — это не повод ронять тик: следующий заход повторит.
      if (e instanceof IntegrationError) {
        log.warn({ provider: e.provider, op: e.op, status: e.status, payment: payment.id }, 'опрос платежа не удался');
      } else {
        log.warn({ err: (e as Error).message, payment: payment.id }, 'опрос платежа не удался');
      }
    }
  }
}
