// Защита несохранённой формы (DESIGN_BRIEF §5.2): форма сообщает, что в ней есть введённые данные, а каркас
// перед переходом по нижней панели спрашивает подтверждение листом снизу. Отдельный модуль, чтобы экраны
// не импортировали каркас, который импортирует их самих.
import { createContext, useContext, useEffect } from 'react';

export const FormDirtyContext = createContext<(dirty: boolean) => void>(() => undefined);

export function useFormDirty(dirty: boolean): void {
  const setDirty = useContext(FormDirtyContext);
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
}
