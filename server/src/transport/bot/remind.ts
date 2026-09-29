// Ручное «Напомнить клиенту» (SPEC §5.5, N16): не чаще раза в 4 часа на сделку. Один счётчик на кнопку в чате
// и на действие в мини-приложении (ЗАДАЧА_08 B) — иначе второй путь обходил бы паузу.
import type { MaxGateway } from '../../integrations/max/gateway.js';
import * as texts from '../../texts.js';
import { remaining, type DealBundle } from '../../types.js';
import { notifyManualReminder } from './notify.js';

const MANUAL_REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const lastManualReminder = new Map<number, number>();

export type RemindOutcome = 'sent' | 'cooldown' | 'no_chat';

export async function remindClientNow(max: MaxGateway, bundle: DealBundle, now = Date.now()): Promise<RemindOutcome> {
  const last = lastManualReminder.get(bundle.deal.id) ?? 0;
  if (now - last < MANUAL_REMINDER_COOLDOWN_MS) return 'cooldown';
  const context = texts.statusText(bundle.deal.status, 'client', {
    prepaymentKopecks: bundle.version.prepaymentKopecks,
    remainingKopecks: remaining(bundle.version),
    scheduledAt: bundle.version.scheduledAt,
  });
  const sent = await notifyManualReminder(max, bundle, context);
  if (!sent) return 'no_chat';
  lastManualReminder.set(bundle.deal.id, now);
  return 'sent';
}

/** Ответ стороне, нажавшей «Напомнить»: тот же текст в чате и тостом в мини-приложении. */
export function remindNote(outcome: RemindOutcome): string {
  if (outcome === 'sent') return texts.REMIND_SENT;
  if (outcome === 'cooldown') return texts.REMIND_COOLDOWN;
  return texts.REMIND_NO_CHAT;
}
