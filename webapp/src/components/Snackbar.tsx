// Snackbar (DESIGN_BRIEF §5.1): сообщение об успехе или ошибке действия, 5 секунд, одно действие. Бриф ссылается на
// Snackbar MAX UI, но в @maxhub/max-ui 0.5.0 его нет, поэтому компонент свой на тех же токенах (ДОПУЩЕНИЯ, ЗАДАЧА_07).
// Показывается над нижней панелью; новое сообщение заменяет прежнее, чтобы не копить стопку.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { IconAlert, IconCheck } from './Icons';

export type SnackbarTone = 'info' | 'success' | 'error';

export interface SnackbarOptions {
  tone?: SnackbarTone;
  /** Одно действие, например «Повторить». */
  action?: { label: string; onClick: () => void };
}

type Show = (text: string, options?: SnackbarOptions) => void;

interface Item extends SnackbarOptions {
  id: number;
  text: string;
}

const DURATION_MS = 5000;

const SnackbarContext = createContext<Show>(() => undefined);

export function useSnackbar(): Show {
  return useContext(SnackbarContext);
}

export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<Item | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const show = useCallback<Show>(
    (text, options = {}) => {
      clear();
      seq.current += 1;
      setItem({ id: seq.current, text, ...options });
      timer.current = window.setTimeout(() => setItem(null), DURATION_MS);
    },
    [clear],
  );

  useEffect(() => clear, [clear]);

  const tone = item?.tone ?? 'info';
  return (
    <SnackbarContext.Provider value={show}>
      {children}
      <div className="dg-snackbar-layer" role="status" aria-live="polite">
        {item ? (
          <div key={item.id} className={`dg-snackbar dg-snackbar_${tone}`}>
            {tone === 'error' ? (
              <IconAlert className="dg-snackbar__icon" width={20} height={20} />
            ) : tone === 'success' ? (
              <IconCheck className="dg-snackbar__icon" width={20} height={20} />
            ) : null}
            <span className="dg-snackbar__text">{item.text}</span>
            {item.action ? (
              <button
                type="button"
                className="dg-snackbar__action"
                onClick={() => {
                  clear();
                  setItem(null);
                  item.action?.onClick();
                }}
              >
                {item.action.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </SnackbarContext.Provider>
  );
}
