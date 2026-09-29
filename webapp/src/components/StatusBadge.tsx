// Плашка статуса (DESIGN_BRIEF §5.2): слово статуса короткой формой и точка 6 px слева. Цвет по семантике
// «чей ход»: действие акцентом, ожидание третичным, успех и негатив своими токенами (--deal-* в ui.css).
import { statusTone, type ViewerRole } from '../format';
import type { DealStatus } from '../types';

export interface StatusBadgeProps {
  status: DealStatus;
  role: ViewerRole;
  /** Короткая форма статуса от сервера (`status_short`), слово в слово как в боте. */
  text: string;
}

export function StatusBadge({ status, role, text }: StatusBadgeProps) {
  const tone = statusTone(status, role);
  return (
    <span className={`dg-badge dg-badge_${tone}`}>
      <span className="dg-badge__dot" aria-hidden="true" />
      {text}
    </span>
  );
}

/** Плашка-метка без точки: «демо», «тест», «пример». */
export function Tag({ children }: { children: string }) {
  return <span className="dg-tag">{children}</span>;
}
