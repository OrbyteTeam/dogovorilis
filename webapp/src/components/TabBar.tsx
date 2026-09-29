// Нижняя панель «Новая / Сделки / Настройки» (DESIGN_BRIEF §5.1). В MAX UI такого компонента нет, панель своя на
// токенах: высота 56 px плюс safe area, активный пункт акцентом, тап-зона всей ячейки. На «Сделках» счётчик
// сделок, где нужен ход пользователя. Пока в поле ввода открыта экранная клавиатура, панель прячется.
import { useEffect, useState, type ReactNode } from 'react';
import { Counter, Typography } from '@maxhub/max-ui';

import { counterLabel } from '../format';
import { IconGear, IconList, IconPlusCircle } from './Icons';

export type Tab = 'new' | 'deals' | 'settings';

const TABS: { value: Tab; label: string; icon: ReactNode }[] = [
  { value: 'new', label: 'Новая', icon: <IconPlusCircle /> },
  { value: 'deals', label: 'Сделки', icon: <IconList /> },
  { value: 'settings', label: 'Настройки', icon: <IconGear /> },
];

// Дата и время открывают системный выбор, а не клавиатуру: панель при них не прячется.
const EDITABLE =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="date"]):not([type="datetime-local"]):not([type="time"]), textarea, [contenteditable="true"]';
/** На сколько должна уменьшиться видимая область, чтобы считать клавиатуру открытой. */
const KEYBOARD_MIN_PX = 150;

/**
 * Клавиатура открыта: фокус в поле ввода на сенсорном устройстве И видимая область заметно уменьшилась.
 * Одного фокуса мало: поле может получить его программно (автофокус «Когда» на повторе), а клавиатуры нет.
 * На компьютере панель не мешает и не прячется.
 */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let coarse = false;
    try {
      coarse = window.matchMedia('(pointer: coarse)').matches;
    } catch {
      coarse = false;
    }
    if (!coarse) return;
    const viewport = window.visualViewport ?? null;
    let fullHeight = 0;
    let width = 0;
    const shrunk = () => {
      const h = viewport ? viewport.height : window.innerHeight;
      const w = viewport ? viewport.width : window.innerWidth;
      // Поворот экрана: высота «без клавиатуры» считается заново.
      if (w !== width) {
        width = w;
        fullHeight = h;
      }
      fullHeight = Math.max(fullHeight, h);
      return fullHeight - h > KEYBOARD_MIN_PX;
    };
    const update = () => {
      const active = document.activeElement;
      setOpen(active instanceof HTMLElement && active.matches(EDITABLE) && shrunk());
    };
    shrunk();
    // focusout приходит раньше, чем фокус встанет на следующий элемент: проверяем после него.
    const later = () => window.setTimeout(update, 0);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', later);
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', later);
      viewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return open;
}

export interface TabBarProps {
  active: Tab | null;
  onSelect: (tab: Tab) => void;
  /** Сделки, где ход за пользователем; 0 — счётчика нет. */
  dealsCounter: number;
}

export function TabBar({ active, onSelect, dealsCounter }: TabBarProps) {
  const keyboardOpen = useKeyboardOpen();
  if (keyboardOpen) return null;
  return (
    <nav className="dg-tabbar" aria-label="Разделы">
      {TABS.map((tab) => {
        const isActive = tab.value === active;
        const counter = tab.value === 'deals' && dealsCounter > 0 ? dealsCounter : 0;
        return (
          <button
            key={tab.value}
            type="button"
            className={isActive ? 'dg-tab dg-tab_active' : 'dg-tab'}
            aria-current={isActive ? 'page' : undefined}
            aria-label={counter ? `${tab.label}, нужно ваше действие: ${counterLabel(counter)}` : tab.label}
            onClick={() => onSelect(tab.value)}
          >
            <span className="dg-tab__icon">
              {tab.icon}
              {counter ? (
                <span className="dg-tab__counter" aria-hidden="true">
                  {counter >= 100 ? (
                    <span className="dg-counter-overflow">99+</span>
                  ) : (
                    <Counter value={counter} variant="attention" rounded />
                  )}
                </span>
              ) : null}
            </span>
            <Typography.Label variant="small-strong" className="dg-tab__label">
              {tab.label}
            </Typography.Label>
          </button>
        );
      })}
    </nav>
  );
}
