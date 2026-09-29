// Занятость исполнителя из БД (ЗАДАЧА_08 D, SPEC §7.10): визиты в «занятых» статусах и удержания принятых предложений.
// Расчёт пересечений — чистые функции busy.ts; здесь только выборка и окно.
import type { DbClient, Queryable } from '../../db/pool.js';
import * as proposalsRepo from '../../db/repos/proposals.js';
import { DAY_MS, partsIn } from '../time.js';
import { HORIZON_DAYS, isFree, mergeIntervals, onGrid, visitInterval, type Interval } from './busy.js';

/** Занятые интервалы исполнителя в окне [from, to), кроме сделки `excludeDealId`; слитые. */
export async function sellerBusy(q: Queryable, a: { sellerUserId: number; excludeDealId: number; from: Date; to: Date }): Promise<Interval[]> {
  const visits = await proposalsRepo.busyForSeller(q, a);
  return mergeIntervals(visits.map((v) => visitInterval(v.start, v.durationMin)));
}

/** Окно пикера: от «сейчас» на HORIZON_DAYS + 1 день вперёд (последний день целиком). */
export function pickerWindow(now: Date): { from: Date; to: Date } {
  return { from: now, to: new Date(now.getTime() + (HORIZON_DAYS + 1) * DAY_MS) };
}

/** Минуты от полуночи по часовому поясу показа — для проверки «на сетке» (08:00–21:30, шаг 30). */
export function minutesOfDay(date: Date, tz: string): number {
  const p = partsIn(date, tz);
  return p.hour * 60 + p.minute;
}

export type SlotCheck = 'ok' | 'off_grid' | 'busy';

/** Можно ли предложить или принять это время для визита длительностью `durationMin` (под блокировкой вызывающего). */
export async function checkSlot(
  c: DbClient,
  a: { sellerUserId: number; dealId: number; start: Date; durationMin: number | null; now: Date; tz: string },
): Promise<SlotCheck> {
  if (!onGrid(a.start, minutesOfDay(a.start, a.tz), a.now)) return 'off_grid';
  const want = visitInterval(a.start, a.durationMin);
  const busy = await sellerBusy(c, { sellerUserId: a.sellerUserId, excludeDealId: a.dealId, from: want.start, to: want.end });
  return isFree(a.start, a.durationMin, busy) ? 'ok' : 'busy';
}
