// Состояния экрана (DESIGN_BRIEF §5.2): загрузка (спиннер или скелет), пустое, ошибка с «Повторить», итог.
// Своё на токенах MAX UI: в пакете таких компонентов нет. Каждый экран показывает загрузку, данные или пустое,
// ошибку с «Повторить» и успех действия (Snackbar и переход).
import type { ReactNode } from 'react';
import { Button, Spinner, Typography } from '@maxhub/max-ui';

import { IconAlert, IconCheck, IconEmpty, IconLock } from './Icons';

export interface StateAction {
  label: string;
  onClick: () => void;
}

type Tone = 'empty' | 'error' | 'success' | 'locked';

const ICONS: Record<Tone, ReactNode> = {
  empty: <IconEmpty width={56} height={56} />,
  error: <IconAlert width={56} height={56} />,
  success: <IconCheck width={56} height={56} />,
  locked: <IconLock width={56} height={56} />,
};

interface BlockProps {
  tone: Tone;
  title: string;
  text?: ReactNode;
  /** Первое действие главное (primary), второе ghost. */
  actions?: StateAction[];
}

function StateBlock({ tone, title, text, actions = [] }: BlockProps) {
  return (
    <section className={`dg-state dg-state_${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <span className="dg-state__icon">{ICONS[tone]}</span>
      <Typography.Title variant="large-strong" asChild>
        <h2 className="dg-state__title">{title}</h2>
      </Typography.Title>
      {text ? (
        <Typography.Body variant="medium" className="dg-state__text">
          {text}
        </Typography.Body>
      ) : null}
      {actions.length ? (
        <div className="dg-state__actions">
          {actions.map((action, index) => (
            <Button key={action.label} variant={index === 0 ? 'primary' : 'ghost'} size="large" stretched onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Пустое состояние: иконка 56 px, заголовок, одна-две строки, до двух кнопок. */
export function EmptyState(props: Omit<BlockProps, 'tone'>) {
  return <StateBlock tone="empty" {...props} />;
}

/** Ошибка: заголовок с сутью, текст с инструкцией, «Повторить» главной кнопкой и второй выход, чтобы не было тупика. */
export function ErrorState({ title, text, onRetry, secondary }: { title: string; text?: ReactNode; onRetry: () => void; secondary?: StateAction }) {
  const actions: StateAction[] = [{ label: 'Повторить', onClick: onRetry }];
  if (secondary) actions.push(secondary);
  return <StateBlock tone="error" title={title} text={text} actions={actions} />;
}

/** Итог без формы: «Условия отправлены», «Править нельзя». Выходы дальше, без тупиков. */
export function NoticeState({ tone, title, text, actions }: { tone: 'success' | 'locked'; title: string; text: ReactNode; actions: StateAction[] }) {
  return <StateBlock tone={tone} title={title} text={text} actions={actions} />;
}

/** Загрузка: спиннер по центру и «Загружаем…». */
export function LoadingState({ text = 'Загружаем…' }: { text?: string }) {
  return (
    <div className="dg-state dg-state_loading" role="status" aria-live="polite">
      <Spinner size={24} appearance="themed" />
      <Typography.Body variant="medium" className="dg-state__text">
        {text}
      </Typography.Body>
    </div>
  );
}

/** Скелет: серые полосы на месте будущих блоков; читалке экрана говорим «Загружаем…». */
export function Skeleton({ kind }: { kind: 'form' | 'list' | 'card' }) {
  const bars = kind === 'list' ? 3 : kind === 'card' ? 1 : 2;
  return (
    <div className={`dg-skeleton dg-skeleton_${kind}`} role="status" aria-live="polite" aria-label="Загружаем…">
      {Array.from({ length: bars }, (_, i) =>
        kind === 'list' ? (
          <div key={i} className="dg-skeleton__row">
            <span className="dg-skeleton__bar dg-skeleton__bar_short" />
            <span className="dg-skeleton__bar" />
            <span className="dg-skeleton__bar dg-skeleton__bar_mid" />
          </div>
        ) : (
          <div key={i} className="dg-skeleton__island">
            <span className="dg-skeleton__bar dg-skeleton__bar_mid" />
            <span className="dg-skeleton__field" />
            <span className="dg-skeleton__field" />
            {kind === 'form' ? <span className="dg-skeleton__field" /> : <span className="dg-skeleton__bar" />}
          </div>
        ),
      )}
    </div>
  );
}
