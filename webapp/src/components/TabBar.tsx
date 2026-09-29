// Нижняя панель разделов «Новая · Сделки · Настройки» — ЗАДАЧА_08 A, docs/SPEC.md §7.1.
// Таб-бара в MAX UI 0.5.0 нет (ToolButton помечен deprecated), поэтому панель своя — только на переменных
// MAX UI (docs/DESIGN.md §1, §4): тёмная тема и платформа подхватываются сами. Вкладки — настоящие кнопки.
import type { ReactNode } from 'react';

import { TABS, type Tab } from '../nav';

const ICONS: Record<Tab, ReactNode> = {
  new: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  deals: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="16" rx="4" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 9.5h17M8 3v3M16 3v3M8 14h3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 7h9M18 7h1M5 17h1M10 17h9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="16" cy="7" r="2.3" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="8" cy="17" r="2.3" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  ),
};

export interface TabBarProps {
  active: Tab;
  onSelect: (tab: Tab) => void;
}

export function TabBar({ active, onSelect }: TabBarProps) {
  return (
    <nav className="dg-tabbar" aria-label="Разделы">
      <div className="dg-tabbar__inner">
        {TABS.map(({ tab, label }) => {
          const isActive = tab === active;
          return (
            <button
              key={tab}
              type="button"
              className={isActive ? 'dg-tab dg-tab_active' : 'dg-tab'}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelect(tab)}
            >
              <span className="dg-tab__icon">{ICONS[tab]}</span>
              <span className="dg-tab__label">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
