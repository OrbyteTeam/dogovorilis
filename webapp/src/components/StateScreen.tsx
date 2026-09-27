// Состояния экрана: загрузка / ошибка с «Повторить» / W0 «откройте внутри MAX» — docs/SPEC.md §7.1, docs/DESIGN.md §5.
import { Button, Panel, Spinner, Typography } from '@maxhub/max-ui';

export function LoadingScreen({ text = 'Загружаем…' }: { text?: string }) {
  return (
    <Panel mode="secondary" centeredX centeredY className="dg-root">
      <div className="dg-screen dg-screen_centered">
        <Spinner size={24} appearance="themed" />
        <Typography.Text variant="body" color="secondary">
          {text}
        </Typography.Text>
      </div>
    </Panel>
  );
}

export interface ScreenAction {
  label: string;
  onClick: () => void;
}

export interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
  /** Второй выход, чтобы ошибка не была тупиком (например, «Мои сделки»). */
  secondary?: ScreenAction;
}

export function ErrorScreen({ message, onRetry, retrying = false, secondary }: ErrorScreenProps) {
  return (
    <Panel mode="secondary" centeredX centeredY className="dg-root">
      <div className="dg-screen dg-screen_centered">
        <Typography.Text variant="subheader" asChild>
          <h1>Не получилось загрузить</h1>
        </Typography.Text>
        <Typography.Text variant="body" color="secondary">
          {message}
        </Typography.Text>
        <Button variant="primary" size="large" stretched loading={retrying} onClick={onRetry}>
          Повторить
        </Button>
        {secondary ? (
          <Button variant="ghost" size="large" stretched onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        ) : null}
      </div>
    </Panel>
  );
}

export interface NoticeScreenProps {
  title: string;
  text: string;
  /** Первое действие — главное (primary), остальные — второстепенные. */
  actions: ScreenAction[];
  tone?: 'success' | 'neutral';
}

/** Экран-итог без формы: «Условия отправлены», «Править нельзя» — текст и выходы дальше, без тупиков. */
export function NoticeScreen({ title, text, actions, tone = 'neutral' }: NoticeScreenProps) {
  return (
    <Panel mode="secondary" centeredX centeredY className="dg-root">
      <div className="dg-screen dg-screen_centered">
        {tone === 'success' ? (
          <span className="dg-notice-icon" aria-hidden="true">
            ✓
          </span>
        ) : null}
        <Typography.Text variant="subheader" asChild>
          <h1>{title}</h1>
        </Typography.Text>
        <Typography.Text variant="body" color="secondary">
          {text}
        </Typography.Text>
        <div className="dg-actions dg-actions_full">
          {actions.map((action, index) => (
            <Button
              key={action.label}
              variant={index === 0 ? 'primary' : 'secondary'}
              size="large"
              stretched
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/**
 * 401 внутри MAX: initData есть, но сервер его не принял (истёк срок, подпись не сошлась) — ЗАДАЧА_04 D1.
 * Экран W0 «откройте внутри MAX» тут был бы неправдой: человек и так в MAX.
 */
export function AuthFailedScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <Panel mode="secondary" centeredX centeredY className="dg-root">
      <div className="dg-screen dg-screen_centered">
        <Typography.Text variant="subheader" asChild>
          <h1>Не удалось подтвердить вход через MAX</h1>
        </Typography.Text>
        <Typography.Text variant="body" color="secondary">
          Закройте и откройте мини-приложение заново — MAX выдаст новые данные для входа.
        </Typography.Text>
        <Button variant="primary" size="large" stretched onClick={onRetry}>
          Повторить
        </Button>
      </div>
    </Panel>
  );
}

/** Ник бота попадает в бандл при сборке (VITE_BOT_USERNAME): без Bridge спросить его у API нельзя. */
const BOT_USERNAME = String(import.meta.env.VITE_BOT_USERNAME ?? '').trim();

/** Экран W0 — SPEC §7.1: мини-приложение открыто вне MAX. */
export function BridgeMissingScreen() {
  const link = BOT_USERNAME ? `https://max.ru/${BOT_USERNAME}` : null;
  return (
    <Panel mode="secondary" centeredX centeredY className="dg-root">
      <div className="dg-screen dg-screen_centered">
        <Typography.Text variant="subheader" asChild>
          <h1>Откройте мини-приложение внутри MAX</h1>
        </Typography.Text>
        <Typography.Text variant="body" color="secondary">
          «Договорились» работает как мини-приложение мессенджера MAX: карточка сделки уходит в чат, а вход — по вашему
          профилю MAX. В обычном браузере эти данные недоступны.
        </Typography.Text>
        {link ? (
          <Button variant="primary" size="large" stretched asChild>
            <a href={link} rel="noreferrer">
              Открыть бота в MAX
            </a>
          </Button>
        ) : (
          <Typography.Text variant="description" color="tertiary">
            Найдите бота «Договорились» в MAX и откройте мини-приложение из его чата.
          </Typography.Text>
        )}
      </div>
    </Panel>
  );
}
