// Задание `payments-poll` (SPEC §10.3): опрос ссылочных платежей в статусе pending.
//
// Зачем оно, если есть вебхук: вебхук ЮKassa требует публичный HTTPS и порт 443 (CONTRACTS §2.5),
// а локально бот работает по long polling без домена — там уведомление не доходит в принципе.
// Опрос делает сценарий проходимым и локально, и на сервере, если вебхук потерялся.
//
// Ограничения из §10.3: не чаще раза в 60 с на платёж (метка — payments.updated_at, её двигает
// applyProviderStatus даже при неизменившемся статусе), истёкшие → `expired` + перерисовка карточки.
// Провайдер — источник истины (ЗАДАЧА_03 F2): прежде чем признать ссылку истёкшей, спрашиваем его
// последний раз, и `expired` ставим, только если оплаты не было.
//
// Заодно здесь самовосстановление (F4): платёж уже succeeded, а сделка не сдвинулась, потому что
// процесс упал между транзакциями. Работает при любом провайдере — рейл «перевод» тоже им подвержен.
import { cfg } from '../../config.js';
import { inTx } from '../../db/pool.js';
import * as paymentsRepo from '../../db/repos/payments.js';
import { IntegrationError } from '../../errors.js';
import type { MaxGateway } from '../../integrations/max/gateway.js';
import { log } from '../../logger.js';
import * as dealService from '../../domain/deal/service.js';
import * as paymentService from '../../domain/payment/service.js';
import * as rails from '../../domain/payment/rails.js';
import { syncCards } from '../../transport/bot/cards.js';
import { publishOutcome, publishPaymentUpdate } from '../../transport/bot/outcome.js';

/** Сколько платежей опрашиваем за тик: провайдеру хватает, а тик остаётся быстрым (SPEC §17). */
export const BATCH = 20;

export async function pollLinkPayments(max: MaxGateway | null, now = new Date()): Promise<void> {
  await healStuck(max, now);
  if (cfg().PAYMENT_PROVIDER === 'none') return;

  const due = await inTx((c) => paymentsRepo.dueForPolling(c, now, BATCH));
  if (!due.length) return;

  for (const payment of due) {
    try {
      if (rails.isExpired(payment, now)) {
        // Срок по нашим часам вышел — но клиент мог заплатить в последнюю минуту (F2).
        const { applied, expired } = await rails.expireUnlessPaid(payment.id, now);
        if (expired) {
          log.info({ payment: payment.id, deal: payment.dealId }, 'ссылка на оплату истекла');
          if (max) await syncCards(max, await dealService.getBundleById(payment.dealId));
        } else if (max) {
          await publishPaymentUpdate(max, applied);
        }
        continue;
      }

      const applied = await rails.refreshFromProvider(payment.id, now);
      if (max) await publishPaymentUpdate(max, applied);
    } catch (e) {
      // Провайдер лежит — это не повод ронять тик: следующий заход повторит (и не объявит ссылку истёкшей вслепую).
      if (e instanceof IntegrationError) {
        log.warn({ provider: e.provider, op: e.op, status: e.status, payment: payment.id }, 'опрос платежа не удался');
      } else {
        log.warn({ err: (e as Error).message, payment: payment.id }, 'опрос платежа не удался');
      }
    }
  }
}

/** F4: довести сделки, чей платёж уже succeeded, а переход не случился; довести до сторон как обычный переход. */
async function healStuck(max: MaxGateway | null, now: Date): Promise<void> {
  try {
    const healed = await paymentService.healStuckPayments(now);
    if (max) for (const result of healed) await publishOutcome(max, result);
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'самовосстановление платежей не удалось');
  }
}
