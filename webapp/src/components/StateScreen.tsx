// Экраны-состояния для экранов ЗАДАЧИ_08 (сделка, выбор времени, «Мои услуги») на компонентах редизайна (ЗАДАЧА_07):
// те же имена и пропсы, что были до редизайна, а рисуют их Screen, LoadingState, ErrorState и NoticeState из States.tsx.
// Так новые экраны выглядят как остальные, а их код не зависит от того, как редизайн устроил состояния.
import type { ReactNode } from 'react';

import { Screen } from './Screen';
import { ErrorState, LoadingState, NoticeState, type StateAction } from './States';

export { AuthFailedScreen, BridgeMissingScreen } from './ServiceScreens';

export type ScreenAction = StateAction;

export function LoadingScreen({ text = 'Загружаем…' }: { text?: string }) {
  return (
    <Screen>
      <LoadingState text={text} />
    </Screen>
  );
}

export interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
  /** Второй выход, чтобы ошибка не была тупиком (например, «Все сделки»). */
  secondary?: ScreenAction;
  title?: string;
}

export function ErrorScreen({ message, onRetry, secondary, title = 'Не получилось загрузить' }: ErrorScreenProps) {
  return (
    <Screen>
      <ErrorState title={title} text={message} onRetry={onRetry} secondary={secondary} />
    </Screen>
  );
}

export interface NoticeScreenProps {
  title: string;
  text: ReactNode;
  /** Первое действие — главное, остальные — второстепенные. */
  actions: ScreenAction[];
  tone?: 'success' | 'neutral';
}

export function NoticeScreen({ title, text, actions, tone = 'neutral' }: NoticeScreenProps) {
  return (
    <Screen>
      <NoticeState tone={tone === 'success' ? 'success' : 'locked'} title={title} text={text} actions={actions} />
    </Screen>
  );
}
