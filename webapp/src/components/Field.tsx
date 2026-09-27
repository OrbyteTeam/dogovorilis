// Поле формы: подпись, контрол, подсказка или конкретный текст ошибки — docs/DESIGN.md §4, §5 (валидация).
import type { ReactNode } from 'react';

export interface FieldProps {
  label: string;
  /** Подсказка под полем; скрывается, когда есть ошибка. */
  hint?: ReactNode;
  error?: string | null;
  htmlFor?: string;
  /** id обёртки — по нему форма прокручивает к первому полю с ошибкой (revealField). */
  anchorId?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, htmlFor, anchorId, children }: FieldProps) {
  const hintId = htmlFor ? `${htmlFor}-hint` : undefined;
  return (
    <div className="dg-field" id={anchorId}>
      {htmlFor ? (
        <label className="dg-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="dg-field__label">{label}</span>
      )}
      {children}
      {error ? (
        <span className="dg-field__hint dg-field__hint_error" id={hintId} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="dg-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])';

/**
 * Прокрутить к полю и поставить фокус в первый доступный контрол внутри него (ЗАДАЧА_04 D1).
 * Для «Когда» с включённым «Без даты» поле ввода выключено — фокус получает сам переключатель.
 */
export function revealField(anchorId: string): void {
  const container = document.getElementById(anchorId);
  if (!container) return;
  try {
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch {
    container.scrollIntoView();
  }
  const control = container.querySelector<HTMLElement>(FOCUSABLE);
  try {
    control?.focus({ preventScroll: true });
  } catch {
    /* фокус не обязателен — поле уже на экране */
  }
}
