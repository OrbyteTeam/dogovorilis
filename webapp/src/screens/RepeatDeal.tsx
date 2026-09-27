// «Повторить сделку» — `#/new?from=:id` и start_param `repeat_<id>`, docs/SPEC.md §7.5, ЗАДАЧА_04 F. Та же форма,
// что и «Новая сделка», с предзаполнением из GET /api/deals/:id, кроме даты; создание — обычный POST /api/deals
// с repeat_of и same_client, дальше — экран «Готово».
import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, errorText } from '../api';
import { ErrorScreen, LoadingScreen, NoticeScreen } from '../components/StateScreen';
import { isTerminal } from '../schedule';
import type { CreateDealRequest, DealDetails, MeResponse, Template } from '../types';
import { NewScreen } from './New';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'form'; deal: DealDetails }
  | { kind: 'locked'; text: string };

/** Почему повторить нельзя — объясняем и даём выход: новая сделка с нуля или «Мои сделки». */
function lockText(deal: DealDetails | null): string {
  if (!deal) return 'Повторить может только исполнитель этой сделки. Можно создать новую сделку с нуля';
  if (deal.demo) return 'Демо-сделки не повторяются — создайте настоящую сделку, это займёт полминуты';
  if (deal.role !== 'seller') return 'Повторить может только исполнитель. Если хотите записаться снова — напишите исполнителю';
  if (!isTerminal(deal.status)) return 'Эта сделка ещё идёт — повторить можно после её завершения. Или создайте новую сделку с нуля';
  return 'Эту сделку повторить нельзя. Создайте новую сделку с нуля';
}

export interface RepeatDealScreenProps {
  publicId: string;
  me: MeResponse;
  templates: Template[];
  /** Создание: то же, что у «Новой сделки» (POST, запоминание результата, переход на «Готово»). */
  onSubmit: (payload: CreateDealRequest) => Promise<void>;
  onNewDeal: () => void;
  onDeals: () => void;
}

export function RepeatDealScreen({ publicId, me, templates, onSubmit, onNewDeal, onDeals }: RepeatDealScreenProps) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const deal = await api.deal(publicId);
      setState(deal.can_repeat ? { kind: 'form', deal } : { kind: 'locked', text: lockText(deal) });
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setState({ kind: 'locked', text: lockText(null) });
        return;
      }
      const message =
        error instanceof ApiError && (error.status === 404 || error.status === 405)
          ? 'Не нашли прежнюю сделку или сервер пока не может её открыть. Попробуйте ещё раз чуть позже или создайте сделку с нуля'
          : errorText(error);
      setState({ kind: 'error', message });
    }
  }, [publicId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') return <LoadingScreen />;

  if (state.kind === 'error') {
    return (
      <ErrorScreen message={state.message} onRetry={() => void load()} secondary={{ label: 'Новая сделка', onClick: onNewDeal }} />
    );
  }

  if (state.kind === 'locked') {
    return (
      <NoticeScreen
        title="Повторить нельзя"
        text={state.text}
        actions={[
          { label: 'Новая сделка', onClick: onNewDeal },
          { label: 'Мои сделки', onClick: onDeals },
        ]}
      />
    );
  }

  return <NewScreen me={me} templates={templates} mode={{ kind: 'repeat', source: state.deal }} onSubmit={onSubmit} />;
}
