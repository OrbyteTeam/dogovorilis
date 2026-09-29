// Строка сделки в расписании и списке (DESIGN_BRIEF §5.3): CellSimple из MAX UI, справа сумма и плашка статуса,
// под строкой действия. Экрана «Сделка» пока нет (ЗАДАЧА_08 B), поэтому строка не открывается, а действия
// «Открыть в чате / Изменить условия / Повторить сделку» остаются под ней.
import type { ReactNode } from 'react';
import { Button, CellSimple } from '@maxhub/max-ui';

import type { DealListItem } from '../types';
import { AmountText } from './AmountText';
import { StatusBadge, Tag } from './StatusBadge';

export interface DealRowAction {
  label: string;
  onClick: () => void;
}

export interface DealRowProps {
  item: DealListItem;
  /** Над названием: время в расписании («14:00»). */
  overline?: string;
  /** Под названием: имя клиента в расписании или «12 окт, 14:00» в списке. */
  subtitle?: ReactNode;
  actions: DealRowAction[];
}

export function DealRow({ item, overline, subtitle, actions }: DealRowProps) {
  const title: ReactNode = (
    <>
      {item.title}
      {item.demo ? (
        <>
          {' '}
          <Tag>демо</Tag>
        </>
      ) : null}
    </>
  );
  return (
    <div className="dg-deal">
      <CellSimple
        overline={overline}
        title={title}
        subtitle={subtitle}
        after={
          <span className="dg-deal__after">
            <AmountText kopecks={item.total_kopecks} />
            <StatusBadge status={item.status} role={item.role} text={item.status_short} />
          </span>
        }
      />
      {actions.length > 0 ? (
        <div className="dg-deal__actions">
          {actions.map((action) => (
            <Button key={action.label} type="button" variant="secondary" size="small" onClick={action.onClick}>
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DealRows({ children }: { children: ReactNode }) {
  return <div className="dg-deals">{children}</div>;
}
