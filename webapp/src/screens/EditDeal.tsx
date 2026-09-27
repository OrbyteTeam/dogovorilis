// Правка условий (T5) — `#/deals/:id/edit`, docs/SPEC.md §7.5, ЗАДАЧА_04 E. Та же форма, что и «Новая сделка»,
// с предзаполнением из GET /api/deals/:id; отправка — PUT /api/deals/:id. Каждая ветка заканчивается экраном
// с выходом дальше: форма, «Условия отправлены», «Править нельзя» или ошибка с «Повторить».
import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, errorText } from '../api';
import { haptic, openBot } from '../bridge';
import { ErrorScreen, LoadingScreen, NoticeScreen } from '../components/StateScreen';
import { useToast } from '../components/Toast';
import { isTerminal } from '../schedule';
import type { CreateDealRequest, DealDetails, MeResponse, Template, UpdateDealResponse } from '../types';
import { NewScreen } from './New';

/** Почему править нельзя — от этого зависит, что сказать и куда отправить дальше. */
type LockReason = 'confirmed' | 'finished' | 'client' | 'forbidden';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'form'; deal: DealDetails }
  | { kind: 'locked'; reason: LockReason; canRepeat?: boolean }
  | { kind: 'sent'; response: UpdateDealResponse };

const LOCK_TEXT: Record<LockReason, { title: string; text: string }> = {
  confirmed: {
    title: 'Править нельзя',
    text: 'Клиент уже подтвердил прежние условия — править нельзя. Отмените сделку и создайте новую',
  },
  finished: {
    title: 'Сделка уже завершена',
    text: 'Условия завершённой сделки не меняются',
  },
  client: {
    title: 'Условия меняет исполнитель',
    text: 'Если нужно что-то поправить — нажмите «Предложить изменения» на карточке сделки в чате',
  },
  forbidden: {
    title: 'Сделка недоступна',
    text: 'Менять условия может только исполнитель этой сделки',
  },
};

function lockReason(deal: DealDetails): LockReason {
  if (deal.role !== 'seller') return 'client';
  if (isTerminal(deal.status)) return 'finished';
  return 'confirmed';
}

/** 404/405 — сделки нет или сервер ещё не умеет этот запрос: служебное «Такого метода нет» человеку не показываем. */
function loadErrorText(error: unknown): string {
  if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
    return 'Не нашли эту сделку или сервер пока не может её открыть. Попробуйте ещё раз чуть позже или откройте «Мои сделки»';
  }
  return errorText(error);
}

export interface EditDealScreenProps {
  publicId: string;
  me: MeResponse;
  templates: Template[];
  onDeals: () => void;
  /** Завершённую сделку править нельзя, но можно повторить (`#/new?from=:id`). */
  onRepeat: (publicId: string) => void;
}

export function EditDealScreen({ publicId, me, templates, onDeals, onRepeat }: EditDealScreenProps) {
  const showToast = useToast();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const deal = await api.deal(publicId);
      setState(
        deal.can_edit ? { kind: 'form', deal } : { kind: 'locked', reason: lockReason(deal), canRepeat: deal.can_repeat },
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setState({ kind: 'locked', reason: 'forbidden' });
        return;
      }
      setState({ kind: 'error', message: loadErrorText(error) });
    }
  }, [publicId]);

  useEffect(() => {
    void load();
  }, [load]);

  function openChat() {
    if (!openBot(me.config.bot_username, `d_${publicId}`)) {
      showToast('Не удалось открыть чат с ботом. Откройте его в MAX вручную', 'error');
    }
  }

  async function submit(payload: CreateDealRequest): Promise<void> {
    // Тело как у создания, без профиля (контракт PUT /api/deals/:id).
    const { profile: _profile, ...body } = payload;
    try {
      const response = await api.updateDeal(publicId, body);
      haptic('success');
      setState({ kind: 'sent', response });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'no_changes') {
          showToast('Вы ничего не изменили');
          return;
        }
        if (error.code === 'deal_not_editable' || error.status === 403) {
          haptic('error');
          setState({ kind: 'locked', reason: 'confirmed' });
          return;
        }
        if (error.status === 404 || error.status === 405) {
          throw new ApiError(error.status, error.code, 'Сервер пока не принял новые условия. Попробуйте ещё раз чуть позже');
        }
      }
      throw error;
    }
  }

  if (state.kind === 'loading') return <LoadingScreen />;

  if (state.kind === 'error') {
    return (
      <ErrorScreen message={state.message} onRetry={() => void load()} secondary={{ label: 'Мои сделки', onClick: onDeals }} />
    );
  }

  if (state.kind === 'locked') {
    const { title } = LOCK_TEXT[state.reason];
    const offerRepeat = state.reason === 'finished' && state.canRepeat === true;
    // Совет «повторите» — только вместе с кнопкой «Повторить»: демо-сделки, например, не повторяются.
    const text = offerRepeat ? `${LOCK_TEXT.finished.text}. Если нужно ещё раз — повторите её с новой датой` : LOCK_TEXT[state.reason].text;
    const actions = [{ label: 'Мои сделки', onClick: onDeals }];
    if (offerRepeat) actions.unshift({ label: 'Повторить', onClick: () => onRepeat(publicId) });
    if (state.reason !== 'forbidden') actions.push({ label: 'Открыть в чате', onClick: openChat });
    return <NoticeScreen title={title} text={text} actions={actions} />;
  }

  if (state.kind === 'sent') {
    const { response } = state;
    const text = response.client_notified
      ? `Карточка обновилась у вас и у клиента. Клиент подтвердит версию ${response.version} заново.`
      : `Карточка обновилась у вас (версия ${response.version}). Клиенту сообщение не дошло — напомните ему открыть карточку по ссылке.`;
    return (
      <NoticeScreen
        tone="success"
        title="Условия отправлены"
        text={text}
        actions={[
          { label: 'Мои сделки', onClick: onDeals },
          { label: 'Открыть чат', onClick: openChat },
        ]}
      />
    );
  }

  return <NewScreen me={me} templates={templates} mode={{ kind: 'edit', source: state.deal }} onSubmit={submit} />;
}
