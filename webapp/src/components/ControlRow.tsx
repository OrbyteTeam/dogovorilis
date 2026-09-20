// Строка с контролом (Radio / Switch из MAX UI) и подписью — тап-зона ≥ 44 px, docs/DESIGN.md §3, §4.
import type { ReactNode } from 'react';

export interface ControlRowProps {
  control: ReactNode;
  title: string;
  subtitle?: string;
}

export function ControlRow({ control, title, subtitle }: ControlRowProps) {
  return (
    <label className="dg-control-row">
      {control}
      <span className="dg-control-row__text">
        {title}
        {subtitle ? <span className="dg-control-row__sub">{subtitle}</span> : null}
      </span>
    </label>
  );
}
