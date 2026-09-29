// Строка сделки в расписании и списке (DESIGN_BRIEF §5.3): CellSimple из MAX UI, справа сумма и плашка статуса,
// под строкой действия. Строка открывает экран сделки `#/deals/:id` (SPEC §7.4, §7.9, ЗАДАЧА_08 B): она настоящая
// кнопка (`as="button"`, доступна с клавиатуры), а кнопки действий стоят рядом с ней и её нажатия не перехватывают.
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
  /** Открыть экран сделки; не передан — строка не нажимается. */
  onOpen?: () => void;
}

export function DealRow({ item, overline, subtitle, actions, onOpen }: DealRowProps) {
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
        as={onOpen ? 'button' : 'div'}
        className={onOpen ? 'dg-deal__open' : undefined}
        onClick={onOpen}
        showChevron={Boolean(onOpen)}
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
