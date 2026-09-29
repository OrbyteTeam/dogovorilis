// Лист снизу — подтверждение необратимого действия и ввод текста на экране сделки (ЗАДАЧА_08 B, SPEC §7.9).
// Модалки в MAX UI 0.5.0 нет: собрана на токенах, как велит docs/DESIGN.md §4 — `--background-overlay` и лист
// снизу с радиусом 16 px. Живёт внутри дерева MaxUI (без портала), поэтому переменные темы доступны.
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Typography } from '@maxhub/max-ui';

const FOCUSABLE =
  'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export interface SheetProps {
  title: string;
  onClose: () => void;
  /** Пока идёт запрос, лист не закрывается ни фоном, ни Escape: иначе исход действия потеряется. */
  locked?: boolean;
  children: ReactNode;
}

export function Sheet({ title, onClose, locked = false, children }: SheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Фокус — в поле ввода, если оно есть; иначе на сам лист: кнопку «Да, отменить» под Enter не подставляем.
  // Прокрутку экрана под листом выключаем; при закрытии фокус возвращается к кнопке, открывшей лист.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = sheetRef.current;
    const field = sheet?.querySelector<HTMLElement>('textarea:not([disabled]), input:not([disabled])');
    try {
      (field ?? sheet)?.focus({ preventScroll: true });
    } catch {
      /* фокус не обязателен */
    }
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = overflow;
      try {
        previous?.focus({ preventScroll: true });
      } catch {
        /* кнопки уже нет — экран перерисован ответом */
      }
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!locked) onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Tab не уходит за лист: фон под оверлеем недоступен.
    const items = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === sheetRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dg-sheet-layer">
      <div className="dg-sheet-overlay" aria-hidden="true" onClick={locked ? undefined : onClose} />
      <div
        ref={sheetRef}
        className="dg-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <span className="dg-sheet__grip" aria-hidden="true" />
        <Typography.Text variant="subheader" asChild>
          <h2 id={titleId} className="dg-sheet__title">
            {title}
          </h2>
        </Typography.Text>
        {children}
      </div>
    </div>
  );
}
