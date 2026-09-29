// «Другое время» (`#/deals/:id/time`) — чистая логика экрана: дни и слоты по МСК, доступность слота, подписи —
// docs/SPEC.md §7.10, контракт ЗАДАЧА_08 D. Модуль без React и без window: его покрывают unit-тесты
// webapp/test/time-slots.test.ts.
//
// Москва живёт по UTC+3 без перехода на летнее время, поэтому начало слота — полночь дня по МСК плюс минуты сетки
// (moscowInputToIso). Интервалы полуоткрытые [начало, конец), как на сервере (domain/schedule/busy.ts): визит
// 10:00–11:00 не мешает визиту с 11:00. Сервер проверяет всё то же самое ещё раз при отправке.
import { formatMinutes, moscowInputToIso } from './format';
import { buildDays, dayKey, dayKeyOf, dayShort, timeOf, type Day } from './schedule';
import type { BusyResponse } from './types';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Значения сервера по умолчанию: поле ответа пустое или испорчено — сетка всё равно строится (SPEC §7.8). */
const DEFAULTS = { duration: 60, step: 30, first: 8 * 60, last: 21 * 60 + 30, horizon: 30, lead: 30 } as const;

/**
 * Состояние слота:
 * - `free` — можно выбрать;
 * - `busy` — визит [слот, слот + длительность) пересекается с занятостью исполнителя: подпись «занято»;
 * - `off` — раньше чем через `min_lead_min` от «сейчас» или дальше горизонта: недоступен без подписи;
 * - `current` — текущее время сделки: подпись «сейчас», недоступен (то же время предлагать незачем, сервер ответит 400).
 */
export type SlotState = 'free' | 'busy' | 'off' | 'current';

export interface Slot {
  /** Начало слота, ISO UTC — уходит в `POST /time-proposals`. */
  iso: string;
  /** «19:00» по МСК. */
  time: string;
  state: SlotState;
}

/** «08:00» → 480 минут от полуночи; не разобрано — null. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Пересекаются ли полуоткрытые интервалы [aStart, aEnd) и [bStart, bEnd): общий край — не пересечение. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Дни выбора: `horizon_days` дней, начиная с сегодняшнего по МСК (`now` — время сервера). */
export function pickerDays(now: Date, horizonDays: number): Day[] {
  const horizon = Math.floor(positive(horizonDays, DEFAULTS.horizon));
  return buildDays(dayKey(now), 0, horizon - 1);
}

/**
 * Слоты дня `key` (МСК) с `first_slot` по `last_slot` шагом `step_min` и доступность каждого. Порядок проверок:
 * текущее время сделки → окно «не раньше now + min_lead_min и не дальше горизонта» → пересечение с занятостью.
 */
export function daySlots(key: string, grid: BusyResponse, now: Date): Slot[] {
  const step = positive(grid.step_min, DEFAULTS.step);
  const first = parseClock(grid.first_slot) ?? DEFAULTS.first;
  const last = parseClock(grid.last_slot) ?? DEFAULTS.last;
  const durationMs = positive(grid.duration_min, DEFAULTS.duration) * MINUTE_MS;
  const lead = Number.isFinite(grid.min_lead_min) && grid.min_lead_min >= 0 ? grid.min_lead_min : DEFAULTS.lead;
  const earliest = now.getTime() + lead * MINUTE_MS;
  const latest = now.getTime() + positive(grid.horizon_days, DEFAULTS.horizon) * DAY_MS;
  const current = grid.current ? Date.parse(grid.current) : Number.NaN;
  const busy = grid.busy
    .map((b) => [Date.parse(b.start), Date.parse(b.end)] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);

  const slots: Slot[] = [];
  for (let minutes = first; minutes <= last; minutes += step) {
    const iso = moscowInputToIso(`${key}T${formatMinutes(minutes)}`);
    if (!iso) continue;
    const start = Date.parse(iso);
    let state: SlotState;
    if (start === current) state = 'current';
    else if (start < earliest || start > latest) state = 'off';
    else if (busy.some(([from, to]) => overlaps(start, start + durationMs, from, to))) state = 'busy';
    else state = 'free';
    slots.push({ iso, time: formatMinutes(minutes), state });
  }
  return slots;
}

export function freeCount(slots: readonly Slot[]): number {
  return slots.filter((slot) => slot.state === 'free').length;
}

/**
 * День, открытый сразу: день текущего времени сделки, если в нём есть свободное время (клиент чаще сдвигает час,
 * чем день); иначе ближайший день со свободным временем; иначе сегодня.
 */
export function defaultPickerDay(days: readonly Day[], freeOf: (key: string) => number, currentIso: string | null): string {
  const currentKey = dayKeyOf(currentIso);
  if (currentKey && days.some((d) => d.key === currentKey) && freeOf(currentKey) > 0) return currentKey;
  return days.find((d) => freeOf(d.key) > 0)?.key ?? days[0]?.key ?? '';
}

/** Кнопка отправки: «Предложить чт, 1 окт, 19:00» (контракт ЗАДАЧА_08 D). */
export function proposeLabel(iso: string): string {
  const key = dayKeyOf(iso);
  return key ? `Предложить ${dayShort(key)}, ${timeOf(iso)}` : 'Предложить время';
}
