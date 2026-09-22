// Планировщик: один setInterval на 30 с, задания из SPEC §10. Защита от наложения — флаг «выполняется».
// Напоминания уходят нужной стороне с кнопкой «Открыть» (карточка сделки). confirmation_expired не отправляется,
// а выполняет переход T8. Режим sendReminders=false оставлен для тестов и отладки: напоминание только логируется.
// В режиме webhook здесь же живёт сторож подписки MAX (раз в 5 минут, transport/bot/webhook.ts).
import { inTx } from '../db/pool.js';
import * as inputsRepo from '../db/repos/inputs.js';
import * as remindersRepo from '../db/repos/reminders.js';
import type { MaxGateway } from '../integrations/max/gateway.js';
import { log } from '../logger.js';
import * as texts from '../texts.js';
import { remaining, type Reminder } from '../types.js';
import * as dealService from '../domain/deal/service.js';
import { isDemoAccelerated, isSystemAction } from '../domain/reminder/plan.js';
import { syncCards } from '../transport/bot/cards.js';
import { openKeyboard } from '../transport/bot/keyboards.js';
import { deliver, notifyForEvents } from '../transport/bot/notify.js';
import type { SubscriptionKeeper } from '../transport/bot/webhook.js';
import { pollLinkPayments } from './jobs/payments-poll.js';

export const TICK_MS = 30_000;
const BATCH = 50;
const MAX_ATTEMPTS = 3;

export type SchedulerOptions = {
  max: MaxGateway | null;
  /** true — напоминания отправляются (боевой режим); false — только логируются и гасятся (`sending_disabled`). */
  sendReminders: boolean;
  /** Сторож подписки MAX — только в режиме webhook (transport/bot/webhook.ts). Сам решает, пора ли проверять. */
  subscription?: Pick<SubscriptionKeeper, 'check'> | null;
};

export function startScheduler(opts: SchedulerOptions): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      log.debug('планировщик: предыдущий тик ещё идёт, пропускаем');
      return;
    }
    running = true;
    void tick(opts)
      .catch((e) => log.error({ err: (e as Error).message }, 'планировщик: тик упал'))
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  timer.unref?.();
  log.info({ tickMs: TICK_MS, sendReminders: opts.sendReminders }, 'планировщик запущен');
  return { stop: () => clearInterval(timer) };
}

export async function tick(opts: SchedulerOptions, now = new Date()): Promise<void> {
  const started = Date.now();
  // Первым и отдельно от БД: если база легла, подписка MAX всё равно должна вернуться. Раз в 5 минут, не каждый тик.
  if (opts.subscription) {
    await opts.subscription.check(now).catch((e) => log.warn({ err: (e as Error).message }, 'планировщик: сторож подписки упал'));
  }
  await runDueReminders(opts, now);
  // Страховка на случай, когда вебхук провайдера не доходит (локальный запуск без HTTPS) — SPEC §10.3.
  await pollLinkPayments(opts.max, now).catch((e) => log.error({ err: (e as Error).message }, 'планировщик: опрос платежей упал'));
  await inTx((c) => inputsRepo.deleteExpired(c, now));
  const ms = Date.now() - started;
  if (ms > 5000) log.warn({ ms }, 'планировщик: тик дольше 5 с');
}

async function runDueReminders(opts: SchedulerOptions, now: Date): Promise<void> {
  const due = await inTx((c) => remindersRepo.claimDue(c, now, BATCH));
  if (!due.length) return;
  log.info({ count: due.length }, 'планировщик: напоминания к отправке');

  for (const reminder of due) {
    try {
      await handleReminder(reminder, opts, now);
    } catch (e) {
      const attempts = await inTx((c) => remindersRepo.markRetry(c, reminder.id, (e as Error).message));
      if (attempts >= MAX_ATTEMPTS) await inTx((c) => remindersRepo.markFailed(c, reminder.id, (e as Error).message));
      log.warn({ reminder: reminder.id, kind: reminder.kind, attempts, err: (e as Error).message }, 'напоминание не обработано');
    }
  }
}

async function handleReminder(reminder: Reminder, opts: SchedulerOptions, now: Date): Promise<void> {
  const bundle = await dealService.getBundleById(reminder.dealId);

  // Статус сделки уже другой — напоминание потеряло смысл (SPEC §10.1).
  if (!dedupeMatchesStatus(reminder, bundle.deal.statusChangedAt)) {
    await inTx((c) => remindersRepo.markCancelled(c, reminder.id, 'state_changed'));
    return;
  }

  if (isSystemAction(reminder.kind)) {
    // T8: срок подтверждения истёк.
    const result = await dealService.expire(bundle.deal.id, now);
    await inTx((c) => remindersRepo.markSent(c, reminder.id));
    if (opts.max && !result.alreadyDone) {
      await syncCards(opts.max, result.bundle);
      await notifyForEvents(opts.max, result.bundle, result.events);
    }
    log.info({ deal: bundle.deal.publicId }, 'срок подтверждения истёк, сделка закрыта (T8)');
    return;
  }

  const text = texts.reminderText(reminder.kind, {
    id: bundle.deal.publicId,
    title: bundle.version.title,
    sumKopecks: reminder.kind === 'payment_due' || reminder.kind === 'payment_overdue' ? remaining(bundle.version) : bundle.version.prepaymentKopecks,
    scheduledAt: bundle.version.scheduledAt,
    deadline: bundle.deal.paidAt,
    accelerated: bundle.deal.demo && isDemoAccelerated(reminder.kind),
  });

  if (!opts.sendReminders) {
    log.info(
      { deal: bundle.deal.publicId, kind: reminder.kind, to: reminder.recipientRole, dueAt: reminder.dueAt },
      'напоминание не отправлено: отправка выключена',
    );
    await inTx((c) => remindersRepo.markCancelled(c, reminder.id, 'sending_disabled'));
    return;
  }

  if (!opts.max) throw new Error('нет шлюза MAX для отправки напоминания');
  // «Открыть» присылает свежую карточку: в ней ровно те кнопки, что нужны сейчас (оплатить, принять, приложить чек).
  // Ошибка отправки пробрасывается — runDueReminders повторит на следующем тике (3 попытки, SPEC §10.1).
  const sent = await deliver(
    opts.max,
    bundle,
    { to: reminder.recipientRole, text, keyboard: openKeyboard(bundle.deal.publicId) },
    { rethrow: true },
  );
  if (sent) await inTx((c) => remindersRepo.markSent(c, reminder.id));
  else await inTx((c) => remindersRepo.markCancelled(c, reminder.id, 'no_chat'));
  log.info({ deal: bundle.deal.publicId, kind: reminder.kind, to: reminder.recipientRole, sent }, 'напоминание обработано');
}

/** dedupe_key хранит статус-таймстамп, для которого напоминание создавалось (SPEC §10.1). */
function dedupeMatchesStatus(reminder: Reminder, statusChangedAt: Date): boolean {
  const iso = reminder.dedupeKey.split(':').slice(3).join(':');
  if (!iso) return true;
  return iso === statusChangedAt.toISOString();
}
