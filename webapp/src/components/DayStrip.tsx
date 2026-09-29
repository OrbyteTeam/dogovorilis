// Лента дней расписания: горизонтальный скролл, сегодня подсвечено, под числом — сколько записей (ЗАДАЧА_04 C3).
// Та же лента — в «Другом времени» (ЗАДАЧА_08 D): там день без свободного времени приглушён, но выбирается.
// Своего компонента в MAX UI нет — собрано на токенах, как чипы (docs/DESIGN.md §4).
import { useLayoutEffect, useRef } from 'react';

import { dayAriaLabel, type Day } from '../schedule';

export interface DayStripProps {
  days: Day[];
  selected: string;
  counts: (key: string) => number;
  onSelect: (key: string) => void;
  /** Приглушить день (цвет не единственный признак: `mutedLabel` дописывается в подпись для доступности). */
  muted?: (key: string) => boolean;
  /** «свободного времени нет» */
  mutedLabel?: string;
}

export function DayStrip({ days, selected, counts, onSelect, muted, mutedLabel }: DayStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);

  // Выбранный день — по центру ленты. Прокручиваем только ленту, а не страницу (scrollIntoView дёрнул бы экран).
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const button = strip?.querySelector<HTMLElement>(`[data-day="${selected}"]`);
    if (!strip || !button) return;
    const left = button.offsetLeft - (strip.clientWidth - button.offsetWidth) / 2;
    const behavior: ScrollBehavior = firstScroll.current ? 'auto' : 'smooth';
    firstScroll.current = false;
    try {
      strip.scrollTo({ left: Math.max(left, 0), behavior });
    } catch {
      strip.scrollLeft = Math.max(left, 0);
    }
  }, [selected, days]);

  return (
    <div className="dg-days" ref={stripRef} role="group" aria-label="Дни">
      {days.map((day) => {
        const count = counts(day.key);
        const active = day.key === selected;
        const dim = muted?.(day.key) ?? false;
        const className = ['dg-day', active ? 'dg-day_active' : '', day.isToday ? 'dg-day_today' : '', dim ? 'dg-day_muted' : '']
          .filter(Boolean)
          .join(' ');
        const label = `${day.isToday ? 'Сегодня, ' : ''}${dayAriaLabel(day.key, count)}${dim && mutedLabel ? `, ${mutedLabel}` : ''}`;
        return (
          <button
            key={day.key}
            type="button"
            data-day={day.key}
            className={className}
            aria-pressed={active}
            aria-label={label}
            onClick={() => onSelect(day.key)}
          >
            <span className={day.isWeekend ? 'dg-day__weekday dg-day__weekday_weekend' : 'dg-day__weekday'}>
              {day.weekday}
            </span>
            <span className="dg-day__num">{day.day}</span>
            <span className={count > 0 ? 'dg-day__count' : 'dg-day__count dg-day__count_empty'} aria-hidden="true">
              {count > 0 ? count : '·'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
