// Лист снизу для подтверждения необратимого (DESIGN_BRIEF §5.2): вопрос, последствие и две кнопки, разрушительная
// первой, «Оставить» ghost. Своё на токенах: --background-overlay под листом, --background-card у листа, радиус 16 px.
// Закрывается нажатием на затемнение и клавишей Escape; фокус уходит на безопасную кнопку.
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Typography } from '@maxhub/max-ui';

export interface BottomSheetProps {
  open: boolean;
  title: string;
  text?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function BottomSheet({ open, title, text, confirmLabel, cancelLabel, onConfirm, onCancel }: BottomSheetProps) {
  const safe = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    safe.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="dg-sheet-layer">
      <button type="button" className="dg-sheet-overlay" aria-label={cancelLabel} onClick={onCancel} />
      <div className="dg-sheet" role="dialog" aria-modal="true" aria-labelledby="dg-sheet-title">
        <span className="dg-sheet__grip" aria-hidden="true" />
        <Typography.Title variant="large-strong" asChild>
          <h2 id="dg-sheet-title">{title}</h2>
        </Typography.Title>
        {text ? (
          <Typography.Body variant="medium" className="dg-sheet__text">
            {text}
          </Typography.Body>
        ) : null}
        <div className="dg-sheet__actions">
          <Button variant="destructive" size="large" stretched onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button ref={safe} variant="ghost" size="large" stretched onClick={onCancel}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
