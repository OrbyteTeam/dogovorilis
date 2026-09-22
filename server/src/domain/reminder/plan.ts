// Планирование напоминаний. Чистая функция: по состоянию сделки отдаёт набор, который надо материализовать.
// Принцип «пересоздаём при каждом переходе» — SPEC §10.1; набор и сроки — §10.2.
// Запись в БД делает domain/deal/service.ts через db/repos/reminders.planMany.
import type { Deal, DealVersion, ReminderKind, TaxMode } from '../../types.js';
import { DAY_MS, HOUR_MS, addHours, addMinutes, partsIn, receiptReminderAt } from '../time.js';

export type PlannedReminder = {
  kind: ReminderKind;
  recipientRole: 'seller' | 'client';
  dueAt: Date;
  dedupeKey: string;
};

/**
 * Демо-сделку (SPEC §12) один человек проходит за минуты, а напоминания рассчитаны на сутки — в демо их не было бы
 * видно никогда. Поэтому два напоминания, которые ждут человека посреди сценария (приёмка — клиенту, чек — исполнителю),
 * в демо приходят через 2 минуты и с пометкой «🧪 в демо — ускорено» (texts.reminderText). Остальные сроки не трогаем:
 * они привязаны к дате визита или к 72 ч на подтверждение, и ускорять их — значит закрывать демо-сделку раньше, чем её пройдут.
 */
export const DEMO_REMINDER_DELAY_MINUTES = 2;
/** Напоминание вернуть предоплату по отменённой сделке — через 48 ч без отметки «Вернул(а)» (ЗАДАЧА_03 H1). */
export const REFUND_REMINDER_HOURS = 48;
const DEMO_ACCELERATED: readonly ReminderKind[] = ['acceptance_due', 'receipt_due'];

export function isDemoAccelerated(kind: ReminderKind): boolean {
  return DEMO_ACCELERATED.includes(kind);
}

/**
 * dedupe_key. SPEC §10.1 задаёт `<deal_id>:<kind>:<status_changed_at ISO>`, но `event_tomorrow` уходит
 * обеим сторонам — два напоминания одного вида в одном статусе. Поэтому в ключ добавлена роль получателя,
 * иначе уникальный индекс терял бы одно из двух (зафиксировано в docs/ДОПУЩЕНИЯ.md).
 */
function dedupeKey(dealId: number, kind: ReminderKind, role: 'seller' | 'client', statusChangedAt: Date): string {
  return `${dealId}:${kind}:${role}:${statusChangedAt.toISOString()}`;
}

/** Набор напоминаний для текущего статуса сделки. Прошедшие сроки не планируем — отправлять их поздно. */
export function planReminders(input: {
  deal: Pick<
    Deal,
    'id' | 'status' | 'statusChangedAt' | 'clientUserId' | 'expiresAt' | 'paidAt' | 'demo' | 'cancelRefundExpected' | 'refundSentAt' | 'refundReceivedAt'
  >;
  version: Pick<DealVersion, 'scheduledAt' | 'prepaymentKopecks' | 'totalKopecks' | 'cancelRule'>;
  taxMode: TaxMode;
  now: Date;
  timezone?: string;
}): PlannedReminder[] {
  const { deal, version, taxMode, now } = input;
  const tz = input.timezone;
  const base = deal.statusChangedAt;
  const out: PlannedReminder[] = [];

  /** Срок «через N часов после смены статуса»; у демо-сделки ускоренные виды — через 2 минуты. */
  const after = (kind: ReminderKind, hours: number): Date =>
    deal.demo && isDemoAccelerated(kind) ? addMinutes(base, DEMO_REMINDER_DELAY_MINUTES) : addHours(base, hours);

  const add = (kind: ReminderKind, role: 'seller' | 'client', dueAt: Date) => {
    // Срок в прошлом относительно «сейчас» не планируем: планировщик отправил бы его тем же тиком,
    // а смысл напоминания («через сутки») уже потерян. Исключение — confirmation_expired: он обязан
    // сработать даже если 72 ч уже прошли (иначе сделка зависнет), поэтому добавляется отдельно.
    if (dueAt.getTime() <= now.getTime()) return;
    out.push({ kind, recipientRole: role, dueAt, dedupeKey: dedupeKey(deal.id, kind, role, base) });
  };

  switch (deal.status) {
    case 'awaiting_confirmation': {
      if (!deal.clientUserId) add('client_not_opened', 'seller', addHours(base, 24));
      const expires = deal.expiresAt ?? addHours(base, 72);
      // Единственное напоминание, которое планируем даже с прошедшим сроком: оно выполняет T8.
      out.push({
        kind: 'confirmation_expired',
        recipientRole: 'seller',
        dueAt: expires,
        dedupeKey: dedupeKey(deal.id, 'confirmation_expired', 'seller', base),
      });
      break;
    }

    case 'changes_requested': {
      const expires = deal.expiresAt ?? addHours(base, 72);
      out.push({
        kind: 'confirmation_expired',
        recipientRole: 'seller',
        dueAt: expires,
        dedupeKey: dedupeKey(deal.id, 'confirmation_expired', 'seller', base),
      });
      break;
    }

    case 'awaiting_prepayment':
      add('prepayment_due', 'client', addHours(base, 24));
      add('prepayment_overdue', 'seller', addHours(base, 48));
      break;

    case 'scheduled':
      if (version.scheduledAt) {
        add('event_tomorrow', 'seller', new Date(version.scheduledAt.getTime() - DAY_MS));
        add('event_tomorrow', 'client', new Date(version.scheduledAt.getTime() - DAY_MS));
        add('event_passed', 'seller', new Date(version.scheduledAt.getTime() + 2 * HOUR_MS));
      }
      break;

    case 'awaiting_acceptance':
      add('acceptance_due', 'client', after('acceptance_due', 24));
      break;

    case 'awaiting_payment':
      add('payment_due', 'client', addHours(base, 24));
      add('payment_overdue', 'seller', addHours(base, 72));
      break;

    case 'paid': {
      if (taxMode === 'none') break; // чек не нужен — напоминать не о чем
      add('receipt_due', 'seller', after('receipt_due', 24));
      if (taxMode === 'npd') {
        const paidAt = deal.paidAt ?? base;
        const deadlineReminder = receiptReminderAt(paidAt, tz);
        // «если paid_at в текущем месяце» (SPEC §10.2): напоминание 7-го числа СЛЕДУЮЩЕГО месяца
        // имеет смысл, только если оно ещё в будущем.
        const p = partsIn(paidAt, tz);
        const nowP = partsIn(now, tz);
        if (p.year === nowP.year && p.month === nowP.month) add('receipt_deadline', 'seller', deadlineReminder);
      }
      break;
    }

    // Отменённая сделка, где предоплату надо вернуть: через 48 ч без отметки «Вернул(а)» напомнить исполнителю
    // (SPEC §5.3, ЗАДАЧА_03 H1). Клиент уже подтвердил получение — напоминать не о чем.
    case 'cancelled':
      if (deal.cancelRefundExpected === true && !deal.refundSentAt && !deal.refundReceivedAt) {
        add('refund_due', 'seller', addHours(base, REFUND_REMINDER_HOURS));
      }
      break;

    // Остальные терминальные статусы (declined, expired, closed) и remarks напоминаний не имеют:
    // в remarks мяч на стороне исполнителя, и SPEC §10.2 для него строки не задаёт.
    default:
      break;
  }

  return out;
}

/** Виды напоминаний, которые не отправляются, а выполняют системный переход. */
export function isSystemAction(kind: ReminderKind): boolean {
  return kind === 'confirmation_expired';
}
