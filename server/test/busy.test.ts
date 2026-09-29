// Занятость исполнителя (ЗАДАЧА_08 D, SPEC §7.10): интервалы с длительностью, пересечения, слияние, сетка пикера.
import { describe, expect, it } from 'vitest';
import { isFree, mergeIntervals, onGrid, overlaps, visitInterval } from '../src/domain/schedule/busy.js';

const at = (iso: string) => new Date(iso);
// 29.09.2026 12:00 МСК = 09:00 UTC
const NOW = at('2026-09-29T09:00:00Z');

describe('занятость исполнителя', () => {
  it('визит без длительности — 60 минут; с длительностью — её', () => {
    expect(visitInterval(at('2026-10-01T07:00:00Z'), null).end.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(visitInterval(at('2026-10-01T07:00:00Z'), 90).end.toISOString()).toBe('2026-10-01T08:30:00.000Z');
  });

  it('интервалы полуоткрытые: конец одного визита — начало другого, это не пересечение', () => {
    const a = visitInterval(at('2026-10-01T07:00:00Z'), 60);
    const b = visitInterval(at('2026-10-01T08:00:00Z'), 60);
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(a, visitInterval(at('2026-10-01T07:30:00Z'), 60))).toBe(true);
  });

  it('длительность нового визита учитывается: 90 минут в 09:00 задевают визит в 10:00', () => {
    const busy = [visitInterval(at('2026-10-01T07:00:00Z'), 60)]; // 10:00–11:00 МСК
    expect(isFree(at('2026-10-01T06:00:00Z'), 90, busy)).toBe(false); // 09:00–10:30 МСК
    expect(isFree(at('2026-10-01T06:00:00Z'), 60, busy)).toBe(true); // 09:00–10:00 МСК — впритык, свободно
  });

  it('слоты вокруг занятого визита с учётом длительности', () => {
    const busy = [visitInterval(at('2026-10-01T07:00:00Z'), 90)]; // 10:00–11:30 МСК
    expect(isFree(at('2026-10-01T05:30:00Z'), 90, busy)).toBe(true); // 08:30–10:00
    expect(isFree(at('2026-10-01T06:00:00Z'), 90, busy)).toBe(false); // 09:00–10:30
    expect(isFree(at('2026-10-01T08:00:00Z'), 60, busy)).toBe(false); // 11:00–12:00
    expect(isFree(at('2026-10-01T08:30:00Z'), 60, busy)).toBe(true); // 11:30–12:30
  });

  it('пересекающиеся и соседние интервалы сливаются; порядок входа не важен', () => {
    const merged = mergeIntervals([
      visitInterval(at('2026-10-01T09:00:00Z'), 60),
      visitInterval(at('2026-10-01T07:00:00Z'), 60),
      visitInterval(at('2026-10-01T07:30:00Z'), 60),
      visitInterval(at('2026-10-01T08:30:00Z'), 30),
      visitInterval(at('2026-10-01T12:00:00Z'), 60),
    ]);
    expect(merged.map((i) => [i.start.toISOString(), i.end.toISOString()])).toEqual([
      ['2026-10-01T07:00:00.000Z', '2026-10-01T10:00:00.000Z'],
      ['2026-10-01T12:00:00.000Z', '2026-10-01T13:00:00.000Z'],
    ]);
  });

  it('сетка: шаг 30 минут, 08:00–21:30 МСК, не раньше чем через 30 минут и не дальше 30 дней', () => {
    expect(onGrid(at('2026-09-30T07:00:00Z'), 10 * 60, NOW)).toBe(true);
    expect(onGrid(at('2026-09-30T07:15:00Z'), 10 * 60 + 15, NOW)).toBe(false);
    expect(onGrid(at('2026-09-30T04:30:00Z'), 7 * 60 + 30, NOW)).toBe(false);
    expect(onGrid(at('2026-09-30T18:30:00Z'), 21 * 60 + 30, NOW)).toBe(true);
    expect(onGrid(at('2026-09-30T19:00:00Z'), 22 * 60, NOW)).toBe(false);
    expect(onGrid(at('2026-09-29T09:00:00Z'), 12 * 60, NOW)).toBe(false); // сейчас
    expect(onGrid(at('2026-09-29T09:30:00Z'), 12 * 60 + 30, NOW)).toBe(true); // ровно +30 минут
    expect(onGrid(at('2026-10-30T09:00:00Z'), 12 * 60, NOW)).toBe(false); // +31 день
  });
});
