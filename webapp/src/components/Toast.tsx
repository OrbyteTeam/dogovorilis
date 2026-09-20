// Тост — своего компонента в MAX UI 0.5.0 нет, собран на токенах: docs/DESIGN.md §4 («тост: низ экрана, 3 с»), §5.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'info' | 'error';

type ShowToast = (text: string, kind?: ToastKind) => void;

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

const TOAST_MS = 3000;

const ToastContext = createContext<ShowToast>(() => undefined);

export function useToast(): ShowToast {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current = [];
    },
    [],
  );

  const show = useCallback<ShowToast>((text, kind = 'info') => {
    const id = (nextId.current += 1);
    setItems((prev) => [...prev, { id, text, kind }]);
    const timer = window.setTimeout(() => {
      setItems((prev) => prev.filter((item) => item.id !== id));
      timers.current = timers.current.filter((value) => value !== timer);
    }, TOAST_MS);
    timers.current.push(timer);
  }, []);

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="dg-toast-layer" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={item.kind === 'error' ? 'dg-toast dg-toast_error' : 'dg-toast'}>
            {item.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
