// Время. В БД — UTC (TIMESTAMPTZ), показываем в APP_TIMEZONE (SPEC §6, §10.2).
// Библиотек для дат не добавляем: хватает Intl с timeZone (Europe/Moscow — фиксированный UTC+3 с 2014 г.,
// но сдвиг считаем честно через Intl, чтобы не зависеть от этого факта).

export const DEFAULT_TZ = 'Europe/Moscow';

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * HOUR_MS);
}
export function addMinutes(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * MINUTE_MS);
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    cache.set(tz, f);
  }
  return f;
}

const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Разложение момента времени по календарю указанной зоны. */
export function partsIn(date: Date, tz: string = DEFAULT_TZ): Parts {
  const map: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === '24' ? '0' : map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: Math.max(0, WD_EN.indexOf(map.weekday ?? 'Sun')),
  };
}

/** Смещение зоны относительно UTC в миллисекундах на указанный момент. */
export function tzOffsetMs(date: Date, tz: string = DEFAULT_TZ): number {
  const p = partsIn(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Локальное время зоны → момент UTC. Например (2026, 10, 7, 10, 0) в МСК → 07:00Z. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  tz: string = DEFAULT_TZ,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}

/** «сб, 27 сен, 14:00»; год добавляется, если он не текущий (SPEC §6). */
export function formatDateTime(date: Date, tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  const p = partsIn(date, tz);
  const cur = partsIn(now, tz);
  const year = p.year === cur.year ? '' : ` ${p.year}`;
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${WEEKDAYS[p.weekday]}, ${p.day} ${MONTHS_SHORT[p.month - 1]}${year}, ${hh}:${mm}`;
}

/** «27.09» — короткая дата для строк оплаты и чека. */
export function formatDateShort(date: Date, tz: string = DEFAULT_TZ): string {
  const p = partsIn(date, tz);
  return `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}`;
}

/** «27.09 14:03» — дата и время без дня недели. */
export function formatDateTimeShort(date: Date, tz: string = DEFAULT_TZ): string {
  const p = partsIn(date, tz);
  return `${formatDateShort(date, tz)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** «9 октября» — для текста про дедлайн чека. */
export function formatDayMonth(date: Date, tz: string = DEFAULT_TZ): string {
  const p = partsIn(date, tz);
  return `${p.day} ${MONTHS_GEN[p.month - 1]}`;
}

/** Полная дата-время для квитанции: «27.09.2026 14:03 (МСК)». */
export function formatFull(date: Date, tz: string = DEFAULT_TZ): string {
  const p = partsIn(date, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  const zone = tz === DEFAULT_TZ ? 'МСК' : tz;
  return `${pad(p.day)}.${pad(p.month)}.${p.year} ${pad(p.hour)}:${pad(p.minute)} (${zone})`;
}

/** 9-е число месяца, следующего за оплатой — крайний срок чека НПД (ст. 14 422-ФЗ). */
export function receiptDeadline(paidAt: Date, tz: string = DEFAULT_TZ): Date {
  const p = partsIn(paidAt, tz);
  const month = p.month === 12 ? 1 : p.month + 1;
  const year = p.month === 12 ? p.year + 1 : p.year;
  return zonedToUtc(year, month, 9, 23, 59, tz);
}

/** Напоминание о чеке: 7-е число следующего месяца, 10:00 по APP_TIMEZONE (SPEC §10.2). */
export function receiptReminderAt(paidAt: Date, tz: string = DEFAULT_TZ): Date {
  const p = partsIn(paidAt, tz);
  const month = p.month === 12 ? 1 : p.month + 1;
  const year = p.month === 12 ? p.year + 1 : p.year;
  return zonedToUtc(year, month, 7, 10, 0, tz);
}
