// Планировщик: один setInterval на 30 с, задания из SPEC §10. Защита от наложения — флаг «выполняется».
// Напоминания уходят нужной стороне с кнопкой «Открыть» (карточка сделки). confirmation_expired не отправляется,
// а выполняет переход T8. Режим sendReminders=false оставлен для тестов и отладки: напоминание только логируется.
// В режиме webhook здесь же живёт сторож подписки MAX (раз в 5 минут, transport/bot/webhook.ts).
// Утренняя сводка (daily_digest) — напоминание без сделки: тик её планирует и отправляет своей веткой (SPEC §10.3).
import { botUsername, cfg } from '../config.js';
import { inTx } from '../db/pool.js';
import * as inputsRepo from '../db/repos/inputs.js';
import * as remindersRepo from '../db/repos/reminders.js';
import * as usersRepo from '../db/repos/users.js';
import type { MaxGateway } from '../integrations/max/gateway.js';
import { log } from '../logger.js';
import * as texts from '../texts.js';
import { remaining, type DealBundle, type Reminder } from '../types.js';
import * as dealService from '../domain/deal/service.js';
import * as digest from '../domain/reminder/digest.js';
import { isDemoAccelerated, isSystemAction } from '../domain/reminder/plan.js';
import { receiptDeadline } from '../domain/time.js';
import { displayName, syncCards } from '../transport/bot/cards.js';
import { digestKeyboard, reminderKeyboard } from '../transport/bot/keyboards.js';
import { clientName, deliver, notifyForEvents } from '../transport/bot/notify.js';
import type { SubscriptionKeeper } from '../transport/bot/webhook.js';
import { pollLinkPayments } from './jobs/payments-poll.js';

export const TICK_MS = 30_000;
/** Сколько держать истёкшее ожидание ввода ради ответа E8 (SPEC §6.6). */
export const INPUT_KEEP_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;
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
  // Сводку планируем до отправки: у кого сегодня есть записи, а момент сводки ещё впереди (SPEC §10.3).
  await digest
    .planDigests(now, timezone())
    .catch((e) => log.error({ err: (e as Error).message }, 'планировщик: планирование сводки упало'));
  await runDueReminders(opts, now);
  // Страховка на случай, когда вебхук провайдера не доходит (локальный запуск без HTTPS) — SPEC §10.3.
  await pollLinkPayments(opts.max, now).catch((e) => log.error({ err: (e as Error).message }, 'планировщик: опрос платежей упал'));
  // Истёкшее ожидание ввода удаляем не сразу, а через сутки: пока запись есть, вернувшийся человек получит E8
  // «Время ожидания истекло. Нажмите кнопку ещё раз», а не S3 «понимаю только кнопки» (найдено прогоном 23.09).
  await inTx((c) => inputsRepo.deleteExpired(c, new Date(now.getTime() - INPUT_KEEP_AFTER_EXPIRY_MS)));
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
  // Сводка — напоминание не по сделке: проверки «статус сделки уже не тот» у неё нет, своя ветка.
  if (reminder.dealId === null || reminder.kind === 'daily_digest') {
    await handleDigest(reminder, opts, now);
    return;
  }
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

  // «Через 30 минут», когда срок уже наступил (сервер лежал), — поздно и бессмысленно (ЗАДАЧА_04 B1).
  const at = bundle.version.scheduledAt;
  if (reminder.kind === 'event_soon' && (!at || at.getTime() <= now.getTime())) {
    await inTx((c) => remindersRepo.markCancelled(c, reminder.id, 'too_late'));
    return;
  }

  const text = reminderMessage(reminder, bundle);

  if (!opts.sendReminders) {
    log.info(
      { deal: bundle.deal.publicId, kind: reminder.kind, to: reminder.recipientRole, dueAt: reminder.dueAt },
      'напоминание не отправлено: отправка выключена',
    );
    await inTx((c) => remindersRepo.markCancelled(c, reminder.id, 'sending_disabled'));
    return;
  }

  if (!opts.max) throw new Error('нет шлюза MAX для отправки напоминания');
  // «Открыть сделку» присылает свежую карточку: в ней ровно те кнопки, что нужны сейчас; у напоминаний о чеке
  // сразу «Приложить чек», у «через 30 минут» кнопки нет (DESIGN_BRIEF §4).
  // Ошибка отправки пробрасывается: runDueReminders повторит на следующем тике (3 попытки, SPEC §10.1).
  const sent = await deliver(
    opts.max,
    bundle,
    { to: reminder.recipientRole, text, keyboard: reminderKeyboard(reminder.kind, bundle.deal.publicId) },
    { rethrow: true },
  );
  if (sent) await inTx((c) => remindersRepo.markSent(c, reminder.id));
  else await inTx((c) => remindersRepo.markCancelled(c, reminder.id, 'no_chat'));
  log.info({ deal: bundle.deal.publicId, kind: reminder.kind, to: reminder.recipientRole, sent }, 'напоминание обработано');
}

/** Текст напоминания по сделке: у «через 30 минут» свои данные (имена сторон, предоплата), у остальных — общие. */
function reminderMessage(reminder: Reminder, bundle: DealBundle): string {
  const kind = reminder.kind;
  const { deal, version } = bundle;
  if (kind === 'event_soon') {
    return texts.eventSoon({
      to: reminder.recipientRole,
      title: version.title,
      clientName: clientName(bundle),
      sellerName: bundle.sellerProfile?.displayName || displayName(bundle.seller.firstName, bundle.seller.lastName),
      prepayment: version.prepaymentKopecks === 0 ? 'none' : deal.status === 'awaiting_prepayment' ? 'awaiting' : 'received',
      prepaymentKopecks: version.prepaymentKopecks,
    });
  }
  if (kind === 'daily_digest') throw new Error('сводка — не напоминание по сделке');
  return texts.reminderText(kind, {
    id: deal.publicId,
    title: version.title,
    sumKopecks: kind === 'payment_due' || kind === 'payment_overdue' ? remaining(version) : version.prepaymentKopecks,
    scheduledAt: version.scheduledAt,
    // Срок чека: 9-е число следующего месяца (ст. 14 422-ФЗ), а не дата оплаты: в тексте «срок до 9 ноя».
    deadline: deal.paidAt ? receiptDeadline(deal.paidAt, timezone()) : null,
    accelerated: deal.demo && isDemoAccelerated(kind),
  });
}

/**
 * Утренняя сводка (ЗАДАЧА_04 B2). Состав считается заново: что отменили или перенесли после планирования,
 * в сводку не попадёт; пустой день — не шлём (`empty`). Сводка за вчерашний день после простоя сервера
 * смысла не имеет (`too_late`); выключенная в «Настройках» — гасится (`digest_off`).
 */
async function handleDigest(reminder: Reminder, opts: SchedulerOptions, now: Date): Promise<void> {
  const cancel = (reason: string) => inTx((c) => remindersRepo.markCancelled(c, reminder.id, reason));
  const userId = reminder.userId;
  if (!userId) return cancel('no_user');
  const tz = timezone();
  const day = digest.dayOf(reminder.dueAt, tz);
  if (digest.dayOf(now, tz).dateKey !== day.dateKey) return cancel('too_late');

  const { user, profile } = await inTx(async (c) => ({ user: await usersRepo.byId(c, userId), profile: await usersRepo.getProfile(c, userId) }));
  if (!profile || profile.digestTime === null) return cancel('digest_off');
  const items = await digest.daySchedule(userId, day);
  if (!items.length) return cancel('empty');
  if (!opts.sendReminders) return cancel('sending_disabled');
  if (!user?.dialogChatId) return cancel('no_chat');
  if (!opts.max) throw new Error('нет шлюза MAX для отправки сводки');

  // Ошибка отправки пробрасывается — повтор на следующем тике, как у остальных напоминаний.
  const text = texts.dailyDigest({ day: day.start, lines: items, now });
  await opts.max.send({ chatId: user.dialogChatId }, text, [digestKeyboard(botUsername())]);
  await inTx((c) => remindersRepo.markSent(c, reminder.id));
  log.info({ user: userId, items: items.length }, 'утренняя сводка отправлена');
}

/** Сутки сводки и её срок считаются в поясе приложения (МСК), как и все остальные напоминания (SPEC §10.2). */
function timezone(): string {
  return cfg().APP_TIMEZONE;
}

/** dedupe_key хранит статус-таймстамп, для которого напоминание создавалось (SPEC §10.1). */
function dedupeMatchesStatus(reminder: Reminder, statusChangedAt: Date): boolean {
  const iso = reminder.dedupeKey.split(':').slice(3).join(':');
  if (!iso) return true;
  return iso === statusChangedAt.toISOString();
}
