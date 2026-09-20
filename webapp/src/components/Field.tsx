// Поле формы: подпись, контрол, подсказка или конкретный текст ошибки — docs/DESIGN.md §4, §5 (валидация).
import type { ReactNode } from 'react';

export interface FieldProps {
  label: string;
  /** Подсказка под полем; скрывается, когда есть ошибка. */
  hint?: ReactNode;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, htmlFor, children }: FieldProps) {
  const hintId = htmlFor ? `${htmlFor}-hint` : undefined;
  return (
    <div className="dg-field">
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
