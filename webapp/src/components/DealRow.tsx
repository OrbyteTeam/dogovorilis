// Строка сделки в расписании и списке «Моих сделок»: CellSimple из MAX UI + ряд действий под ним (ЗАДАЧА_04 C4–C5).
// Строка сама не открывается — экрана сделки нет, карточка в чате и есть экран сделки.
import type { ReactNode } from 'react';
import { Button, CellSimple, Typography } from '@maxhub/max-ui';

import { formatKopecks } from '../format';
import type { DealListItem } from '../types';

export interface DealRowAction {
  label: string;
  onClick: () => void;
}

export interface DealRowProps {
  item: DealListItem;
  /** Время слева (в расписании день уже выбран — показываем только «14:00»). */
  lead?: string;
  /** Подпись под названием: «Пн 28 сен, 14:00 · ждём предоплату». */
  meta: string;
  actions: DealRowAction[];
}

export function DealRow({ item, lead, meta, actions }: DealRowProps) {
  const title: ReactNode = item.demo ? (
    <>
      {item.title} <span className="dg-tag">демо</span>
    </>
  ) : (
    item.title
  );
  return (
    <div className="dg-deal">
      <CellSimple
        before={lead ? <span className="dg-deal__time">{lead}</span> : undefined}
        title={title}
        subtitle={meta}
        after={
          <Typography.Text variant="body-strong" color="secondary" className="dg-deal__sum">
            {formatKopecks(item.total_kopecks)}
          </Typography.Text>
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
