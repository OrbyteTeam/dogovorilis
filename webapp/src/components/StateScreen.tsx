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

export interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
}

export function ErrorScreen({ message, onRetry, retrying = false }: ErrorScreenProps) {
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
