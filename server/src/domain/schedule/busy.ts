// Занятость исполнителя для выбора времени клиентом (ЗАДАЧА_08 D, SPEC §7.10). Чистые функции, без БД и часов:
// интервалы полуоткрытые [начало, конец), поэтому визит 10:00–11:00 не мешает визиту с 11:00.
// Рабочих часов и перерывов нет сознательно — это территория систем записи (YCLIENTS); следующий шаг — SCALING.

export const DEFAULT_DURATION_MIN = 60;
export const SLOT_STEP_MIN = 30;
/** Сетка пикера по МСК: первый слот 08:00, последний начинается в 21:30 (ДОПУЩЕНИЯ, ЗАДАЧА_08 D). */
export const DAY_FIRST_SLOT_MIN = 8 * 60;
export const DAY_LAST_SLOT_MIN = 21 * 60 + 30;
/** Выбрать можно на 30 дней вперёд и не раньше чем через 30 минут (то же правило, что у формы сделки, SPEC §7.2). */
export const HORIZON_DAYS = 30;
export const MIN_LEAD_MIN = 30;

/** Статусы, в которых время исполнителя занято (ЗАДАЧА_08 D): договорились и ещё не закончили. */
export const BUSY_STATUSES = ['scheduled', 'awaiting_prepayment', 'awaiting_acceptance'] as const;

export type Interval = { start: Date; end: Date };

/** Интервал визита: длительность сделки или 60 минут, если сделка не из услуги. */
export function visitInterval(start: Date, durationMin: number | null | undefined): Interval {
  const minutes = durationMin && durationMin > 0 ? durationMin : DEFAULT_DURATION_MIN;
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** Свободен ли визит длительностью `durationMin` с начала `start` при занятых интервалах `busy`. */
export function isFree(start: Date, durationMin: number | null | undefined, busy: readonly Interval[]): boolean {
  const want = visitInterval(start, durationMin);
  return !busy.some((b) => overlaps(want, b));
}

/** Слияние пересекающихся и соседних интервалов — ответ API компактнее и не раскрывает, сколько визитов стоит подряд. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out.at(-1);
    if (last && cur.start.getTime() <= last.end.getTime()) {
      if (cur.end.getTime() > last.end.getTime()) last.end = new Date(cur.end.getTime());
    } else {
      out.push({ start: new Date(cur.start.getTime()), end: new Date(cur.end.getTime()) });
    }
  }
  return out;
}

/**
 * Время подходит для предложения: на сетке (минуты кратны шагу, внутри 08:00–21:30 по МСК), не раньше чем через
 * 30 минут и не дальше 30 дней. `minutesOfDayMsk` — минуты от полуночи по МСК (считает вызывающий, domain/time.ts).
 */
export function onGrid(start: Date, minutesOfDayMsk: number, now: Date): boolean {
  if (minutesOfDayMsk % SLOT_STEP_MIN !== 0) return false;
  if (minutesOfDayMsk < DAY_FIRST_SLOT_MIN || minutesOfDayMsk > DAY_LAST_SLOT_MIN) return false;
  if (start.getTime() < now.getTime() + MIN_LEAD_MIN * 60_000) return false;
  return start.getTime() <= now.getTime() + HORIZON_DAYS * 86_400_000;
}
