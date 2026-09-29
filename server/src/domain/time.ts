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

/**
 * Метка пояса у каждого времени, которое видит человек: «(МСК)». Без неё исполнитель из другого пояса читает
 * московское время как своё (аудит 22.09 §4.5). Даты без времени метку не получают.
 */
export function zoneLabel(tz: string = DEFAULT_TZ): string {
  return tz === DEFAULT_TZ ? 'МСК' : tz;
}

/** «вт 12 окт» (с годом, если он не текущий): день недели строчными, месяц сокращённо без точки (DESIGN_BRIEF §2.4). */
function dayLabel(p: Parts, cur: Parts, weekday: boolean): string {
  const year = p.year === cur.year ? '' : ` ${p.year}`;
  const base = `${p.day} ${MONTHS_SHORT[p.month - 1]}${year}`;
  return weekday ? `${WEEKDAYS[p.weekday]} ${base}` : base;
}

function hhmm(p: Parts): string {
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** «вт 12 окт, 14:00 (МСК)»; год добавляется, если он не текущий: «вт 12 окт 2027, 14:00 (МСК)». */
export function formatDateTime(date: Date, tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  const p = partsIn(date, tz);
  return `${dayLabel(p, partsIn(now, tz), true)}, ${hhmm(p)} (${zoneLabel(tz)})`;
}

/** «12 окт, 14:07 (МСК)»: момент без дня недели для строк платежей, версий и отметок сторон. */
export function formatMoment(date: Date, tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  return `${formatDayTime(date, tz, now)} (${zoneLabel(tz)})`;
}

/** «12 окт, 14:07»: то же без пояса, для строк списков (пояс пишется один раз над списком). */
export function formatDayTime(date: Date, tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  const p = partsIn(date, tz);
  return `${dayLabel(p, partsIn(now, tz), false)}, ${hhmm(p)}`;
}

/** «9 ноя» (с годом, если он не текущий): сроки без времени, «Чек: до 9 ноя». */
export function formatDayMonthShort(date: Date, tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  return dayLabel(partsIn(date, tz), partsIn(now, tz), false);
}

/** «вт 29 сен» (с годом, если он не текущий): заголовок дня в утренней сводке. */
export function formatWeekdayDay(date: Date, tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  return dayLabel(partsIn(date, tz), partsIn(now, tz), true);
}

/** «14:00» по поясу приложения. */
export function formatTime(date: Date, tz: string = DEFAULT_TZ): string {
  return hhmm(partsIn(date, tz));
}

/**
 * Дата и время строки списка: «сегодня, 14:00», «завтра, 14:00», иначе «пн 28 сен, 14:00» (DESIGN_BRIEF §2.4).
 * Словами только в списках: список собирается по запросу, а карточка и уведомление остаются в ленте, и через
 * сутки «завтра» в них стало бы неправдой.
 */
export function listDateTime(date: Date, tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  const p = partsIn(date, tz);
  const key = (x: Parts) => x.year * 10_000 + x.month * 100 + x.day;
  const today = partsIn(now, tz);
  const tomorrow = partsIn(new Date(now.getTime() + DAY_MS), tz);
  if (key(p) === key(today)) return `сегодня, ${hhmm(p)}`;
  if (key(p) === key(tomorrow)) return `завтра, ${hhmm(p)}`;
  return `${dayLabel(p, today, true)}, ${hhmm(p)}`;
}

/**
 * Пояс в сообщении пишется один раз (DESIGN_BRIEF §2.4, чек-лист п. 5): у первого времени «(МСК)» остаётся,
 * у остальных убирается. Строки собираются с поясом у каждого времени, а сообщение целиком проходит через эту
 * функцию, поэтому пропустить пояс, если время в сообщении одно, нельзя.
 */
export function zoneOnce(text: string, tz: string = DEFAULT_TZ): string {
  const mark = ` (${zoneLabel(tz)})`;
  const first = text.indexOf(mark);
  if (first < 0) return text;
  const head = text.slice(0, first + mark.length);
  return head + text.slice(first + mark.length).split(mark).join('');
}

/** Полная дата-время для квитанции: «15 окт 2026, 19:02»; год всегда, документ живёт дольше года. */
export function formatDocDateTime(date: Date, tz: string = DEFAULT_TZ): string {
  const p = partsIn(date, tz);
  return `${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}, ${hhmm(p)}`;
}

/** «вт 12 окт 2026, 14:00» для квитанции: день недели и год всегда. */
export function formatDocWhen(date: Date, tz: string = DEFAULT_TZ): string {
  const p = partsIn(date, tz);
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}, ${hhmm(p)}`;
}

/** «9 октября» (полное название месяца) для текстов, где срок стоит внутри фразы. */
export function formatDayMonth(date: Date, tz: string = DEFAULT_TZ): string {
  const p = partsIn(date, tz);
  return `${p.day} ${MONTHS_GEN[p.month - 1]}`;
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
