// Расписание «Моих сделок»: дни по Москве, лента сегодня −7 … +21, группировка записей — ЗАДАЧА_04 C, docs/SPEC.md §7.4.
// Все календарные вычисления — по МСК через Intl (`Europe/Moscow`), а не по поясу устройства: так же считает бот.
import type { DealListItem, DealStatus } from './types';

const TZ = 'Europe/Moscow';

/** Лента дней: неделя назад и три недели вперёд от сегодняшнего дня. */
export const DAYS_BACK = 7;
export const DAYS_AHEAD = 21;

/** Не состоялось и слот свободен — в расписании не показываем, в «Списке» они есть (фильтр «Закрытые»). */
const NOT_HAPPENING: readonly DealStatus[] = ['cancelled', 'declined', 'expired'];
/** Терминальные статусы — как TERMINAL_STATUSES на сервере (фильтры «Активные» / «Закрытые»). */
export const TERMINAL: readonly DealStatus[] = ['declined', 'expired', 'closed', 'cancelled'];
export const AWAITING_PAYMENT: readonly DealStatus[] = ['awaiting_prepayment', 'awaiting_payment'];

const KEY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const TIME_FORMAT = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WEEKDAY_TITLE = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAY_LONG = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTH_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Календарный день по Москве: «2026-09-28». */
export function dayKey(date: Date): string {
  const parts = KEY_FORMAT.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function dayKeyOf(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dayKey(date);
}

/** Время по Москве «14:00». */
export function timeOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : TIME_FORMAT.format(date);
}

/** Полдень UTC этого календарного дня: арифметика дней без поясов и переходов на летнее время. */
function keyToUtcNoon(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function utcNoonToKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(key: string, days: number): string {
  const date = keyToUtcNoon(key);
  date.setUTCDate(date.getUTCDate() + days);
  return utcNoonToKey(date);
}

export interface Day {
  key: string;
  /** «пн» */
  weekday: string;
  /** 28 */
  day: number;
  isToday: boolean;
  isWeekend: boolean;
}

/** Дни ленты от `todayKey − back` до `todayKey + ahead`; по умолчанию — лента «Моих сделок». */
export function buildDays(todayKey: string, back: number = DAYS_BACK, ahead: number = DAYS_AHEAD): Day[] {
  const days: Day[] = [];
  for (let i = -back; i <= ahead; i += 1) {
    const key = addDays(todayKey, i);
    const date = keyToUtcNoon(key);
    const wd = date.getUTCDay();
    days.push({ key, weekday: WEEKDAY_SHORT[wd], day: date.getUTCDate(), isToday: i === 0, isWeekend: wd === 0 || wd === 6 });
  }
  return days;
}

/** Заголовок выбранного дня: «Сегодня, понедельник, 28 сентября». */
export function dayTitle(key: string, todayKey: string): string {
  const date = keyToUtcNoon(key);
  const base = `${WEEKDAY_LONG[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTH_GENITIVE[date.getUTCMonth()]}`;
  if (key === todayKey) return `Сегодня, ${base}`;
  if (key === addDays(todayKey, 1)) return `Завтра, ${base}`;
  if (key === addDays(todayKey, -1)) return `Вчера, ${base}`;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Подпись для доступности: «пн, 28 сентября, 2 записи». */
export function dayAriaLabel(key: string, count: number): string {
  const date = keyToUtcNoon(key);
  const base = `${WEEKDAY_LONG[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTH_GENITIVE[date.getUTCMonth()]}`;
  return count > 0 ? `${base}, ${pluralRecords(count)}` : base;
}

/** Короткий день: «чт, 1 окт» — подпись кнопки «Предложить чт, 1 окт, 19:00» (ЗАДАЧА_08 D). */
export function dayShort(key: string): string {
  const date = keyToUtcNoon(key);
  return `${WEEKDAY_SHORT[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}`;
}

/** Дата и время строки списка: «Пн 28 сен, 14:00». */
export function shortDateTime(iso: string): string {
  const key = dayKeyOf(iso);
  if (!key) return '';
  const date = keyToUtcNoon(key);
  const weekday = WEEKDAY_TITLE[(date.getUTCDay() + 6) % 7];
  return `${weekday} ${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}, ${timeOf(iso)}`;
}

export function pluralRecords(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} запись`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} записи`;
  return `${n} записей`;
}

export function isTerminal(status: DealStatus): boolean {
  return TERMINAL.includes(status);
}

function byTime(a: DealListItem, b: DealListItem): number {
  return (a.scheduled_at ?? '').localeCompare(b.scheduled_at ?? '');
}

export interface Schedule {
  /** Записи по дням ленты, внутри дня — по времени. */
  byDay: Map<string, DealListItem[]>;
  /** Действующие сделки без даты — отдельный блок под расписанием дня. */
  undated: DealListItem[];
  /** Записей дальше ленты (позже +21 дня) — только подсказка «смотрите «Список»». */
  laterCount: number;
}

export function buildSchedule(items: DealListItem[], todayKey: string): Schedule {
  const first = addDays(todayKey, -DAYS_BACK);
  const last = addDays(todayKey, DAYS_AHEAD);
  const byDay = new Map<string, DealListItem[]>();
  const undated: DealListItem[] = [];
  let laterCount = 0;

  for (const item of items) {
    if (NOT_HAPPENING.includes(item.status)) continue;
    const key = dayKeyOf(item.scheduled_at);
    if (!key) {
      if (!isTerminal(item.status)) undated.push(item);
      continue;
    }
    if (key > last) {
      laterCount += 1;
      continue;
    }
    if (key < first) continue;
    const list = byDay.get(key) ?? [];
    list.push(item);
    byDay.set(key, list);
  }
  byDay.forEach((list) => list.sort(byTime));
  return { byDay, undated, laterCount };
}

/** День по умолчанию: сегодня, если в нём есть записи; иначе ближайший будущий день с записью; иначе сегодня. */
export function defaultDay(schedule: Schedule, todayKey: string): string {
  if ((schedule.byDay.get(todayKey)?.length ?? 0) > 0) return todayKey;
  for (let i = 1; i <= DAYS_AHEAD; i += 1) {
    const key = addDays(todayKey, i);
    if ((schedule.byDay.get(key)?.length ?? 0) > 0) return key;
  }
  return todayKey;
}
