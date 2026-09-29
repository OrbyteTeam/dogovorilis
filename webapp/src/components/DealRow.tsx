// Строка сделки в расписании и списке «Моих сделок»: CellSimple из MAX UI + ряд действий под ним (ЗАДАЧА_04 C4–C5).
// Строка открывает экран сделки `#/deals/:id` (SPEC §7.4, §7.9, ЗАДАЧА_08 B): она — настоящая кнопка (`as="button"`,
// доступна с клавиатуры), а кнопки действий стоят рядом с ней, а не внутри, — их нажатия строка не перехватывает.
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
  /** Открыть экран сделки; не передан — строка не нажимается. */
  onOpen?: () => void;
}

export function DealRow({ item, lead, meta, actions, onOpen }: DealRowProps) {
  // Исполнителю после названия — имя клиента: «Маникюр с покрытием · Саша». Клиенту имя клиента не нужно — это он сам.
  const clientName = item.role === 'seller' ? item.client_name?.trim() : null;
  const title: ReactNode = (
    <>
      {item.title}
      {clientName ? <span className="dg-deal__client">{` · ${clientName}`}</span> : null}
      {item.demo ? (
        <>
          {' '}
          <span className="dg-tag">демо</span>
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
