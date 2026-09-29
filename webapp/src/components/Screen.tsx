// Корень экрана: фон поверхности MAX UI, колонка 480 px с отступами 16 px (DESIGN_BRIEF §6), место под нижнюю панель.
import type { ReactNode } from 'react';
import { Panel, Typography } from '@maxhub/max-ui';

export function Screen({ children, as = 'div', onSubmit }: { children: ReactNode; as?: 'div' | 'form'; onSubmit?: () => void }) {
  return (
    <Panel mode="secondary" className="dg-root">
      {as === 'form' ? (
        <form
          className="dg-screen"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit?.();
          }}
        >
          {children}
        </form>
      ) : (
        <div className="dg-screen">{children}</div>
      )}
    </Panel>
  );
}

/** Остров-блок с заголовком (О вас, Условия, Как принимаете деньги). */
export function Island({ id, title, children, flat = false }: { id?: string; title?: string; children: ReactNode; flat?: boolean }) {
  return (
    <section className={flat ? 'dg-card dg-card_flat' : 'dg-card'} aria-labelledby={title && id ? id : undefined}>
      {title ? (
        <Typography.Title variant="medium-strong" asChild>
          <h2 id={id}>{title}</h2>
        </Typography.Title>
      ) : null}
      {children}
    </section>
  );
}
