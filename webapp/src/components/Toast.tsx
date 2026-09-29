// Короткие сообщения для экранов ЗАДАЧИ_08 через Snackbar редизайна (ЗАДАЧА_07): `showToast(text, kind)`
// превращается в Snackbar с тем же текстом. По умолчанию успех (галочка); `info` — без галочки, для «уже сделано».
import { useCallback } from 'react';

import { useSnackbar } from './Snackbar';

export type ToastKind = 'success' | 'info' | 'error';

export function useToast(): (text: string, kind?: ToastKind) => void {
  const show = useSnackbar();
  return useCallback((text: string, kind: ToastKind = 'success') => show(text, { tone: kind }), [show]);
}
