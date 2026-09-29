// Служебные экраны (DESIGN_BRIEF §5.3): вне MAX (W0, SPEC §7.1) и отказ входа внутри MAX (401). Нижней панели на них
// нет: без входа через MAX разделы всё равно не откроются.
import { Button, Panel, Typography } from '@maxhub/max-ui';

import { Logo } from './AppHeader';
import { ErrorState } from './States';

/** Ник бота попадает в бандл при сборке (VITE_BOT_USERNAME): без Bridge спросить его у API нельзя. */
const BOT_USERNAME = String(import.meta.env.VITE_BOT_USERNAME ?? '').trim();

/** W0: мини-приложение открыто в обычном браузере, initData нет. Логотип 96 px по центру (§7). */
export function BridgeMissingScreen() {
  const link = BOT_USERNAME ? `https://max.ru/${BOT_USERNAME}` : null;
  return (
    <Panel mode="secondary" className="dg-root">
      <div className="dg-screen dg-screen_service">
        <Logo size={96} className="dg-logo dg-logo_large" />
        <Typography.Headline variant="large-strong" asChild>
          <h1>Откройте мини-приложение внутри MAX</h1>
        </Typography.Headline>
        <Typography.Body variant="medium" className="dg-state__text">
          Ссылка работает в приложении MAX на телефоне или на web.max.ru
        </Typography.Body>
        {link ? (
          <Button variant="primary" size="large" stretched asChild>
            <a href={link} rel="noreferrer">
              Открыть в MAX
            </a>
          </Button>
        ) : (
          <Typography.Body variant="small" className="dg-state__text">
            Найдите бота «Договорились» в MAX и откройте мини-приложение из его чата.
          </Typography.Body>
        )}
      </div>
    </Panel>
  );
}

/**
 * 401 внутри MAX: initData есть, но сервер его не принял (истёк срок, подпись не сошлась), ЗАДАЧА_04 D1.
 * Экран W0 «откройте внутри MAX» тут был бы неправдой: человек и так в MAX.
 */
export function AuthFailedScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <Panel mode="secondary" className="dg-root">
      <div className="dg-screen dg-screen_service">
        <Logo size={96} className="dg-logo dg-logo_large" />
        <ErrorState title="Не удалось подтвердить вход через MAX" text="Закройте и откройте мини-приложение ещё раз" onRetry={onRetry} />
      </div>
    </Panel>
  );
}
