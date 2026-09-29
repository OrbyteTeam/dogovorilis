// Шапка экрана (DESIGN_BRIEF §5.1, §7): логотип 24 px слева, заголовок Headline large-strong, подпись под ним.
// В тёмной теме логотип белой монохромной версией: тему знает провайдер MAX UI (useAppearance), свои цвета не нужны.
import type { ReactNode } from 'react';
import { Typography, useAppearance } from '@maxhub/max-ui';

const BASE = import.meta.env.BASE_URL;

/** Логотип: синий на светлой теме, белый на тёмной; не перекрашивается и не растягивается (§7). */
export function Logo({ size = 24, className }: { size?: 24 | 96; className?: string }) {
  const { colorScheme } = useAppearance();
  const src = colorScheme === 'dark' ? `${BASE}logo-white-192.png` : `${BASE}logo-192.png`;
  return <img className={className ?? 'dg-logo'} src={src} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}

export interface AppHeaderProps {
  title: string;
  /** Одна-две строки под заголовком: номер сделки, что произойдёт после отправки. */
  subtitle?: ReactNode;
}

export function AppHeader({ title, subtitle }: AppHeaderProps) {
  return (
    <header className="dg-header">
      <div className="dg-header__row">
        <Logo />
        <Typography.Headline variant="large-strong" asChild>
          <h1 className="dg-header__title">{title}</h1>
        </Typography.Headline>
      </div>
      {subtitle ? (
        <Typography.Body variant="medium" className="dg-header__subtitle">
          {subtitle}
        </Typography.Body>
      ) : null}
    </header>
  );
}
