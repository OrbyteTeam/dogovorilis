// Экран «Мои сделки» — docs/SPEC.md §7.4 (фильтры, список, пустое состояние), вид — docs/DESIGN.md §4.
import { useCallback, useEffect, useState } from 'react';
import { Button, CellList, CellSimple, Panel, Spinner, Typography } from '@maxhub/max-ui';

import { api, errorText } from '../api';
import { Segmented } from '../components/Segmented';
import { ErrorScreen } from '../components/StateScreen';
import { formatDateTime, formatKopecks, statusEmoji } from '../format';
import type { DealListItem, DealsFilter } from '../types';

const FILTERS: { value: DealsFilter; label: string }[] = [
  { value: 'active', label: 'Активные' },
  { value: 'awaiting_payment', label: 'Ждут оплаты' },
  { value: 'done', label: 'Завершённые' },
  { value: 'all', label: 'Все' },
];

const EMPTY_TEXT: Record<DealsFilter, string> = {
  active: 'Пока нет активных сделок. Создайте первую — это займёт полминуты.',
  awaiting_payment: 'Сейчас никто ничего не должен: сделок, ждущих оплаты, нет.',
  done: 'Завершённых сделок пока нет.',
  all: 'Пока нет сделок. Создайте первую — это займёт полминуты.',
};

/** Подпись строки: срок, если он есть, иначе сумма — второй раз сумму в подписи не повторяем. */
function subtitle(item: DealListItem): string {
  const when = item.scheduled_at ? formatDateTime(item.scheduled_at) : null;
  return when ? `${item.status_text} · ${when}` : item.status_text;
}

function DealRow({ item }: { item: DealListItem }) {
  return (
    <CellSimple
      overline={`#${item.public_id}${item.demo ? ' · демо' : ''}`}
      title={`${statusEmoji(item.status)} ${item.title}`}
      subtitle={subtitle(item)}
      after={
        <Typography.Text variant="body-strong" color="secondary">
          {formatKopecks(item.total_kopecks)}
        </Typography.Text>
      }
    />
  );
}

export interface DealsScreenProps {
  onNewDeal: () => void;
}

export function DealsScreen({ onNewDeal }: DealsScreenProps) {
  const [filter, setFilter] = useState<DealsFilter>('active');
  const [items, setItems] = useState<DealListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (next: DealsFilter) => {
    setError(null);
    setItems(null);
    try {
      const response = await api.deals({ role: 'all', filter: next });
      setItems(response.items);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  if (error) return <ErrorScreen message={error} onRetry={() => void load(filter)} />;

  // Сделки, где пользователь — клиент, идут отдельной секцией (SPEC §7.4).
  const asSeller = items?.filter((i) => i.role === 'seller') ?? [];
  const asClient = items?.filter((i) => i.role === 'client') ?? [];

  return (
    <Panel mode="secondary" className="dg-root">
      <div className="dg-screen">
        <Typography.Headline variant="large-strong" asChild>
          <h1>Мои сделки</h1>
        </Typography.Headline>

        <Segmented options={FILTERS} value={filter} onChange={setFilter} ariaLabel="Фильтр сделок" />

        {items === null ? (
          // Спиннер внутри экрана, а не LoadingScreen: тот разворачивает свою Panel во весь экран,
          // и фильтры бы прыгали при каждом переключении.
          <section className="dg-card dg-card_flat">
            <Spinner size={24} appearance="themed" />
            <Typography.Text variant="body" color="secondary">
              Загружаем сделки…
            </Typography.Text>
          </section>
        ) : items.length === 0 ? (
          <section className="dg-card">
            <Typography.Text variant="body" color="secondary">
              {EMPTY_TEXT[filter]}
            </Typography.Text>
            <Button variant="primary" size="large" stretched onClick={onNewDeal}>
              Новая сделка
            </Button>
          </section>
        ) : (
          <>
            {asSeller.length > 0 ? (
              <CellList mode="island" header={asClient.length > 0 ? 'Я — исполнитель' : undefined}>
                {asSeller.map((item) => (
                  <DealRow key={item.public_id} item={item} />
                ))}
              </CellList>
            ) : null}

            {asClient.length > 0 ? (
              <CellList mode="island" header="Я — клиент">
                {asClient.map((item) => (
                  <DealRow key={item.public_id} item={item} />
                ))}
              </CellList>
            ) : null}
          </>
        )}

        <Typography.Text variant="description" color="tertiary">
          Действия по сделке — на её карточке в чате с ботом: там кнопки подтверждения, оплаты и отмены.
        </Typography.Text>
      </div>
    </Panel>
  );
}
