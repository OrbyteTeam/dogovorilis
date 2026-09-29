// «Другое время» (ЗАДАЧА_08 D, SPEC §7.10): дни и слоты по МСК, доступность слота, подписи.
import { describe, expect, it } from 'vitest';

import {
  daySlots,
  defaultPickerDay,
  freeCount,
  overlaps,
  parseClock,
  pickerDays,
  proposeLabel,
  type Slot,
} from '../src/time-slots';
import type { BusyResponse } from '../src/types';

/** Четверг, 1 октября 2026 по МСК. */
const DAY = '2026-10-01';
/** Момент по МСК: «2026-10-01», «10:00» → ISO UTC (МСК = UTC+3). */
const msk = (key: string, time: string) => {
  const [h, m] = time.split(':').map(Number);
  const [y, mo, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 3, m)).toISOString();
};

function grid(over: Partial<BusyResponse> = {}): BusyResponse {
  return {
    duration_min: 60,
    step_min: 30,
    first_slot: '08:00',
    last_slot: '21:30',
    horizon_days: 30,
    min_lead_min: 30,
    now: msk('2026-09-29', '12:00'),
    current: null,
    busy: [],
    ...over,
  };
}

const stateAt = (slots: Slot[], time: string) => slots.find((s) => s.time === time)?.state;
const now = (key: string, time: string) => new Date(msk(key, time));

describe('разбор и пересечения', () => {
  it('время сетки «чч:мм» — минуты от полуночи', () => {
    expect(parseClock('08:00')).toBe(480);
    expect(parseClock('21:30')).toBe(1290);
    expect(parseClock('8:30')).toBe(510);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('abc')).toBeNull();
  });

  it('интервалы полуоткрытые: общий край — не пересечение', () => {
    expect(overlaps(10, 11, 11, 12)).toBe(false);
    expect(overlaps(11, 12, 10, 11)).toBe(false);
    expect(overlaps(10, 12, 11, 13)).toBe(true);
    expect(overlaps(10, 13, 11, 12)).toBe(true);
  });
});

describe('дни', () => {
  it('30 дней с сегодняшнего по МСК, первый — сегодня', () => {
    const days = pickerDays(now('2026-09-29', '12:00'), 30);
    expect(days).toHaveLength(30);
    expect(days[0]).toMatchObject({ key: '2026-09-29', isToday: true, weekday: 'вт', day: 29 });
    expect(days[29].key).toBe('2026-10-28');
  });

  it('после полуночи по МСК сегодня — уже следующий день, даже если по UTC ещё вчера', () => {
    // 22:30 UTC 29 сентября = 01:30 МСК 30 сентября
    const days = pickerDays(new Date('2026-09-29T22:30:00Z'), 30);
    expect(days[0].key).toBe('2026-09-30');
  });
});

describe('слоты дня', () => {
  it('с 08:00 по 21:30 шагом 30 минут — 28 слотов, начало слота — момент по МСК', () => {
    const slots = daySlots(DAY, grid(), now('2026-09-29', '12:00'));
    expect(slots).toHaveLength(28);
    expect(slots[0]).toEqual({ iso: '2026-10-01T05:00:00.000Z', time: '08:00', state: 'free' });
    expect(slots[27]).toMatchObject({ iso: '2026-10-01T18:30:00.000Z', time: '21:30' });
  });

  it('шаг и границы берутся из ответа; испорченные поля — значения сервера по умолчанию', () => {
    expect(daySlots(DAY, grid({ step_min: 60, first_slot: '09:00', last_slot: '12:00' }), now('2026-09-29', '12:00')).map((s) => s.time)).toEqual([
      '09:00',
      '10:00',
      '11:00',
      '12:00',
    ]);
    expect(daySlots(DAY, grid({ step_min: 0, first_slot: '??', last_slot: '' }), now('2026-09-29', '12:00'))).toHaveLength(28);
  });

  it('раньше чем через 30 минут от «сейчас» — недоступно; ровно через 30 минут — можно', () => {
    const slots = daySlots(DAY, grid(), now(DAY, '10:00'));
    expect(stateAt(slots, '08:00')).toBe('off');
    expect(stateAt(slots, '10:00')).toBe('off');
    expect(stateAt(slots, '10:30')).toBe('free');
    const later = daySlots(DAY, grid(), now(DAY, '10:05'));
    expect(stateAt(later, '10:30')).toBe('off');
    expect(stateAt(later, '11:00')).toBe('free');
  });

  it('визит [слот, слот + длительность) пересекается с занятым — «занято»; касание краем — свободно', () => {
    const busy = [{ start: msk(DAY, '12:00'), end: msk(DAY, '13:00') }];
    const slots = daySlots(DAY, grid({ busy }), now('2026-09-29', '12:00'));
    expect(stateAt(slots, '11:00')).toBe('free');
    expect(stateAt(slots, '11:30')).toBe('busy');
    expect(stateAt(slots, '12:00')).toBe('busy');
    expect(stateAt(slots, '12:30')).toBe('busy');
    expect(stateAt(slots, '13:00')).toBe('free');
  });

  it('длительность визита сделки: 90 минут занимают больше слотов перед занятым интервалом', () => {
    const busy = [{ start: msk(DAY, '12:00'), end: msk(DAY, '13:00') }];
    const slots = daySlots(DAY, grid({ busy, duration_min: 90 }), now('2026-09-29', '12:00'));
    expect(stateAt(slots, '10:30')).toBe('free');
    expect(stateAt(slots, '11:00')).toBe('busy');
    expect(stateAt(slots, '13:00')).toBe('free');
  });

  it('занятость, начавшаяся накануне, закрывает утро', () => {
    const busy = [{ start: msk('2026-09-30', '21:00'), end: msk(DAY, '09:00') }];
    const slots = daySlots(DAY, grid({ busy }), now('2026-09-29', '12:00'));
    expect(stateAt(slots, '08:30')).toBe('busy');
    expect(stateAt(slots, '09:00')).toBe('free');
  });

  it('текущее время сделки — «сейчас», даже если рядом занято или уже рано', () => {
    const current = msk(DAY, '19:00');
    const busy = [{ start: msk(DAY, '18:30'), end: msk(DAY, '20:00') }];
    expect(stateAt(daySlots(DAY, grid({ current, busy }), now('2026-09-29', '12:00')), '19:00')).toBe('current');
    expect(stateAt(daySlots(DAY, grid({ current }), now(DAY, '18:50')), '19:00')).toBe('current');
  });

  it('дальше горизонта — недоступно', () => {
    const slots = daySlots('2026-10-29', grid({ horizon_days: 30 }), now('2026-09-29', '12:00'));
    expect(stateAt(slots, '11:30')).toBe('free');
    expect(stateAt(slots, '12:00')).toBe('free');
    expect(stateAt(slots, '12:30')).toBe('off');
  });

  it('свободных слотов считаем только доступные', () => {
    const slots = daySlots(DAY, grid({ current: msk(DAY, '08:00'), busy: [{ start: msk(DAY, '09:00'), end: msk(DAY, '22:30') }] }), now('2026-09-29', '12:00'));
    expect(freeCount(slots)).toBe(0);
  });
});

describe('день по умолчанию', () => {
  const days = pickerDays(now('2026-09-29', '12:00'), 30);

  it('день текущего времени сделки, если в нём есть свободное время', () => {
    expect(defaultPickerDay(days, () => 5, msk(DAY, '19:00'))).toBe(DAY);
  });

  it('в дне сделки всё занято или время дальше горизонта — ближайший день со свободным временем', () => {
    const free = (key: string) => (key === DAY || key === '2026-09-29' ? 0 : 3);
    expect(defaultPickerDay(days, free, msk(DAY, '19:00'))).toBe('2026-09-30');
    expect(defaultPickerDay(days, () => 3, msk('2026-12-01', '10:00'))).toBe('2026-09-29');
  });

  it('свободного времени нет нигде — сегодня', () => {
    expect(defaultPickerDay(days, () => 0, null)).toBe('2026-09-29');
  });
});

describe('подписи', () => {
  it('кнопка отправки — день недели, дата и время по МСК, без тире и точек-разделителей', () => {
    const label = proposeLabel(msk(DAY, '19:00'));
    expect(label).toBe('Предложить чт 1 окт, 19:00');
    expect(label).not.toMatch(/[—·]/);
    // 23:30 UTC — уже следующий день по МСК
    expect(proposeLabel('2026-09-30T23:30:00Z')).toBe('Предложить чт 1 окт, 02:30');
  });
});
