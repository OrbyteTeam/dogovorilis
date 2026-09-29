// Короткие сообщения для экранов ЗАДАЧИ_08 через Snackbar редизайна (ЗАДАЧА_07): прежний вызов
// `showToast(text, 'error' | 'info')` превращается в Snackbar с тем же текстом и тоном.
import { useCallback } from 'react';

import { useSnackbar } from './Snackbar';

export type ToastKind = 'info' | 'error';

export function useToast(): (text: string, kind?: ToastKind) => void {
  const show = useSnackbar();
  return useCallback((text: string, kind: ToastKind = 'info') => show(text, { tone: kind === 'error' ? 'error' : 'success' }), [show]);
}
