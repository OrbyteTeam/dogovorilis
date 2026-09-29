// Хронология сделки (DESIGN_BRIEF §5.2): вертикальная лента, точка на линии --divider-primary, заголовок события
// Typography.Body, время Typography.Label третичным. Экран «Сделка» с хронологией появится в ЗАДАЧА_08 B; здесь
// компонент и стили, чтобы он встал на те же токены в обеих темах.
import type { ReactNode } from 'react';
import { Typography } from '@maxhub/max-ui';

export interface TimelineEvent {
  id: string | number;
  title: ReactNode;
  /** «12 окт, 14:07» */
  at: string;
  /** Ссылка на документ: квитанция, чек. */
  extra?: ReactNode;
}

export function Timeline({ events, empty = 'Событий пока нет' }: { events: TimelineEvent[]; empty?: string }) {
  if (!events.length) {
    return (
      <Typography.Body variant="medium" className="dg-timeline__empty">
        {empty}
      </Typography.Body>
    );
  }
  return (
    <ol className="dg-timeline">
      {events.map((event) => (
        <li key={event.id} className="dg-timeline__item">
          <span className="dg-timeline__dot" aria-hidden="true" />
          <Typography.Body variant="medium">{event.title}</Typography.Body>
          <Typography.Label variant="small" className="dg-timeline__at">
            {event.at}
          </Typography.Label>
          {event.extra}
        </li>
      ))}
    </ol>
  );
}
