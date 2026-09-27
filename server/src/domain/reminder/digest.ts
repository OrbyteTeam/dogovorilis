// Утренняя сводка исполнителю (daily_digest, ЗАДАЧА_04 B2, SPEC §10.2–10.3).
// Напоминание не по одной сделке, а по исполнителю: «сегодня у вас 3 записи». Строка reminders без deal_id,
// получатель — user_id, однократность в день — dedupe_key `digest:<seller_id>:<YYYY-MM-DD по МСК>`.
// Планирует сводку тик планировщика (planDigests), переносит — смена времени в «Настройках» (rescheduleDigest),
// состав считается заново в момент отправки (daySchedule).
import { inTx } from '../../db/pool.js';
import * as dealsRepo from '../../db/repos/deals.js';
import * as remindersRepo from '../../db/repos/reminders.js';
import type { DayScheduleItem, DealStatus } from '../../types.js';
import { DEFAULT_TZ, partsIn, zonedToUtc } from '../time.js';

/** Какие записи попадают в сводку: согласованные и ждущие предоплаты или приёмки (ЗАДАЧА_04 B2). */
export const DIGEST_STATUSES: readonly DealStatus[] = ['scheduled', 'awaiting_prepayment', 'awaiting_acceptance'];

/** Допустимое время сводки: 06:00–12:00 по МСК с шагом 30 минут (минуты от полуночи). */
export const DIGEST_MIN = 360;
export const DIGEST_MAX = 720;
export const DIGEST_STEP = 30;

export function isValidDigestTime(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= DIGEST_MIN && minutes <= DIGEST_MAX && minutes % DIGEST_STEP === 0;
}

export type Day = { dateKey: string; start: Date; end: Date; year: number; month: number; day: number };

/** Сутки, в которые попадает момент `at`, по календарю пояса: [00:00, 00:00 следующего дня). */
export function dayOf(at: Date, tz: string = DEFAULT_TZ): Day {
  const p = partsIn(at, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    dateKey: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    // Date.UTC внутри zonedToUtc сам переносит «32 сентября» на 2 октября
    start: zonedToUtc(p.year, p.month, p.day, 0, 0, tz),
    end: zonedToUtc(p.year, p.month, p.day + 1, 0, 0, tz),
    year: p.year,
    month: p.month,
    day: p.day,
  };
}

/** Момент сводки в этот день: digest_time минут от полуночи по поясу. */
export function digestDueAt(day: Day, digestTime: number, tz: string = DEFAULT_TZ): Date {
  return zonedToUtc(day.year, day.month, day.day, Math.floor(digestTime / 60), digestTime % 60, tz);
}

export function digestKey(sellerUserId: number, dateKey: string): string {
  return `digest:${sellerUserId}:${dateKey}`;
}

/**
 * Задание тика (SPEC §10.3): сегодняшняя сводка тем, у кого она включена, момент ещё не наступил и есть записи.
 * Один INSERT … ON CONFLICT на тик; возвращает число новых строк.
 */
export async function planDigests(now: Date, tz: string = DEFAULT_TZ): Promise<number> {
  const day = dayOf(now, tz);
  return inTx((c) =>
    remindersRepo.planDigests(c, {
      dayStart: day.start,
      dayEnd: day.end,
      dateKey: day.dateKey,
      now,
      timezone: tz,
      statuses: DIGEST_STATUSES,
    }),
  );
}

export type RescheduleOutcome = 'moved' | 'cancelled' | 'none';

/**
 * Время сводки изменили в «Настройках» (PUT /api/me/profile). Сегодняшняя строка:
 * - сводку выключили → гасится (`digest_off`);
 * - новое время уже прошло → гасится (`digest_passed`): второй раз сегодня не придёт;
 * - новое время впереди → переносится (в том числе снова включённая после «выключить»).
 * Строки ещё нет — ничего не делаем: её запланирует ближайший тик, если на сегодня есть записи.
 */
export async function rescheduleDigest(
  sellerUserId: number,
  digestTime: number | null,
  now: Date,
  tz: string = DEFAULT_TZ,
): Promise<RescheduleOutcome> {
  const day = dayOf(now, tz);
  const key = digestKey(sellerUserId, day.dateKey);
  return inTx(async (c) => {
    if (digestTime === null) return (await remindersRepo.cancelDigest(c, key, 'digest_off')) > 0 ? 'cancelled' : 'none';
    const dueAt = digestDueAt(day, digestTime, tz);
    if (dueAt.getTime() <= now.getTime()) {
      return (await remindersRepo.cancelDigest(c, key, 'digest_passed')) > 0 ? 'cancelled' : 'none';
    }
    return (await remindersRepo.moveDigest(c, key, dueAt)) > 0 ? 'moved' : 'none';
  });
}

/** Состав сводки на сутки, в которые назначена сводка: записи по времени (считается в момент отправки). */
export async function daySchedule(sellerUserId: number, day: Day): Promise<DayScheduleItem[]> {
  return inTx((c) => dealsRepo.listDaySchedule(c, { sellerUserId, from: day.start, to: day.end, statuses: DIGEST_STATUSES }));
}
