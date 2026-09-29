// Экран «Другое время» `#/deals/:id/time` (`start_param` `time_<id>`) — docs/SPEC.md §7.10, контракт ЗАДАЧА_08 D.
// Клиент выбирает время по занятости исполнителя: лента из 30 дней по МСК, под ней сетка слотов; занятые, слишком
// ранние и текущее время сделки недоступны. Выбор → закреплённая над таб-баром кнопка «Предложить {день, время}» →
// `POST /time-proposals`; исполнитель принимает одним нажатием, новая версия условий приходит клиенту в чат.
// Расчёт сетки и занятости — чистый модуль time-slots.ts. Вид — docs/DESIGN.md §4, §5.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Panel, Spinner, Typography } from '@maxhub/max-ui';

import { api, ApiError, errorText } from '../api';
import { haptic } from '../bridge';
import { AppHeader } from '../components/AppHeader';
import { DayStrip } from '../components/DayStrip';
import { ErrorScreen, LoadingScreen, NoticeScreen } from '../components/StateScreen';
import { useToast } from '../components/Toast';
import { formatDateTime } from '../format';
import { dayKeyOf, dayTitle } from '../schedule';
import { daySlots, defaultPickerDay, freeCount, pickerDays, proposeLabel, type Slot } from '../time-slots';
import type { BusyResponse, DealStatus } from '../types';

/** Время предлагают, пока условия не подтверждены (SPEC §7.10): до подтверждения и после запроса изменений. */
const OPEN_STATUSES: readonly DealStatus[] = ['awaiting_confirmation', 'changes_requested'];

/** Текст SPEC §7.10 для 409 `invalid_transition`; здесь — когда это видно ещё до выбора (открыли из старого сообщения). */
const LOCKED_TEXT = 'Условия уже подтверждены или сделка завершена.';
const CHAT_FAILED = 'Не удалось открыть чат с ботом. Откройте его в MAX вручную';
/** Время сдвигается само: раз в 30 секунд пересчитываем, какие слоты уже слишком близко. */
const CLOCK_TICK_MS = 30_000;

type DeniedReason = 'forbidden' | 'not_found' | 'seller';

const DENIED_TEXT: Record<DeniedReason, { title: string; text: string }> = {
  forbidden: {
    title: 'Это не ваша сделка',
    text: 'Время предлагает клиент этой сделки.',
  },
  not_found: {
    title: 'Сделка не найдена',
    text: 'Проверьте ссылку или откройте сделку из списка.',
  },
  // /busy открыт любому участнику, а предлагать время может только клиент (SPEC §7.10).
  seller: {
    title: 'Время выбирает клиент',
    text: 'Чтобы сдвинуть время, измените условия на экране сделки',
  },
};

interface PickerData {
  grid: BusyResponse;
  /** Время сервера минус время устройства: «сейчас» для окна +30 минут берём по часам сервера. */
  skew: number;
  title: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'denied'; reason: DeniedReason }
  /** Условия уже не изменить: статус ушёл дальше до выбора или 409 `invalid_transition` при отправке. */
  | { kind: 'locked'; message: string }
  | { kind: 'sent' }
  | { kind: 'ready'; data: PickerData };

function skewOf(grid: BusyResponse): number {
  const server = Date.parse(grid.now);
  return Number.isFinite(server) ? server - Date.now() : 0;
}

function failedState(error: unknown): LoadState {
  if (error instanceof ApiError && !error.isAuth) {
    if (error.status === 403) return { kind: 'denied', reason: 'forbidden' };
    if (error.status === 404) return { kind: 'denied', reason: 'not_found' };
  }
  return { kind: 'error', message: errorText(error) };
}

/** «1 ч 30 мин» — длительность визита, из-за неё соседние с занятым слоты тоже «занято». */
function visitText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

const NO_COUNTS = () => 0;

export interface TimePickerScreenProps {
  publicId: string;
  /** Чат с ботом на карточке сделки; false — открыть не удалось. */
  onOpenChat: () => boolean;
  /** «К сделке» — экран сделки вместо экрана времени. */
  onDeal: () => void;
  onDeals: () => void;
}

export function TimePickerScreen({ publicId, onOpenChat, onDeal, onDeals }: TimePickerScreenProps) {
  const showToast = useToast();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  /** День, выбранный в ленте; null — день по умолчанию (defaultPickerDay). */
  const [day, setDay] = useState<string | null>(null);
  /** Выбранный слот — ISO начала. */
  const [picked, setPicked] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Состояние обновится только после перерисовки — второй тап в тот же кадр ловит ref (двойное нажатие, DESIGN §5).
  const sendingRef = useRef(false);
  const [reloading, setReloading] = useState(false);
  const [clock, setClock] = useState(() => Date.now());

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    // Название и статус — из экрана сделки глазами клиента (в демо это сам исполнитель, `as=client`).
    const [busy, full] = await Promise.allSettled([api.busy(publicId), api.dealFull(publicId, 'client')]);
    if (busy.status === 'rejected') {
      setState(failedState(busy.reason));
      return;
    }
    if (full.status === 'rejected') {
      const error: unknown = full.reason;
      // Занятость отдали, а экран клиента — 403: смотрит исполнитель (не демо).
      if (error instanceof ApiError && !error.isAuth && error.status === 403) setState({ kind: 'denied', reason: 'seller' });
      else setState(failedState(error));
      return;
    }
    if (!OPEN_STATUSES.includes(full.value.status)) {
      setState({ kind: 'locked', message: LOCKED_TEXT });
      return;
    }
    setClock(Date.now());
    setState({ kind: 'ready', data: { grid: busy.value, skew: skewOf(busy.value), title: full.value.terms.title } });
  }, [publicId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isReady = state.kind === 'ready';
  useEffect(() => {
    if (!isReady) return;
    const timer = window.setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isReady]);

  const data = state.kind === 'ready' ? state.data : null;
  const nowMs = clock + (data?.skew ?? 0);

  const days = useMemo(() => (data ? pickerDays(new Date(nowMs), data.grid.horizon_days) : []), [data, nowMs]);
  const slotsByDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    if (data) for (const d of days) map.set(d.key, daySlots(d.key, data.grid, new Date(nowMs)));
    return map;
  }, [data, days, nowMs]);
  const freeOf = useCallback((key: string) => freeCount(slotsByDay.get(key) ?? []), [slotsByDay]);

  function openChat() {
    if (!onOpenChat()) showToast(CHAT_FAILED, 'error');
  }

  /** Перезапрос занятости без экрана загрузки — после 409 `slot_busy`. Ошибка — тостом, сетка остаётся прежней. */
  async function refreshBusy() {
    setReloading(true);
    try {
      const grid = await api.busy(publicId);
      setClock(Date.now());
      setState((prev) => (prev.kind === 'ready' ? { kind: 'ready', data: { ...prev.data, grid, skew: skewOf(grid) } } : prev));
    } catch (error) {
      showToast(errorText(error), 'error');
    } finally {
      setReloading(false);
    }
  }

  async function propose(iso: string) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      // `as: 'client'` — в демо время предлагает исполнитель от роли клиента; настоящему клиенту сервер это разрешает.
      await api.proposeTime(publicId, iso, 'client');
      haptic('success');
      setState({ kind: 'sent' });
    } catch (error) {
      haptic('error');
      if (error instanceof ApiError && error.status === 409 && error.code === 'slot_busy') {
        // Время заняли, пока выбирали: показываем свежую занятость, выбор сбрасываем (контракт ЗАДАЧА_08 D).
        showToast(error.message, 'error');
        setPicked(null);
        void refreshBusy();
      } else if (error instanceof ApiError && error.status === 409 && error.code === 'invalid_transition') {
        setState({ kind: 'locked', message: error.message });
      } else {
        // 400 (например, слот стал ближе 30 минут), сеть, таймаут, 5xx: тост, выбор сохраняется — можно повторить.
        showToast(errorText(error), 'error');
        setClock(Date.now());
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  if (state.kind === 'loading') return <LoadingScreen />;

  if (state.kind === 'error') {
    return <ErrorScreen message={state.message} onRetry={() => void load()} secondary={{ label: 'Все сделки', onClick: onDeals }} />;
  }

  if (state.kind === 'denied') {
    const { title, text } = DENIED_TEXT[state.reason];
    const actions =
      state.reason === 'seller'
        ? [
            { label: 'К сделке', onClick: onDeal },
            { label: 'Все сделки', onClick: onDeals },
          ]
        : [{ label: 'Все сделки', onClick: onDeals }];
    return <NoticeScreen title={title} text={text} actions={actions} />;
  }

  if (state.kind === 'locked') {
    return (
      <NoticeScreen
        title="Время уже не изменить"
        text={state.message}
        actions={[
          { label: 'Открыть чат', onClick: openChat },
          { label: 'К сделке', onClick: onDeal },
        ]}
      />
    );
  }

  if (state.kind === 'sent') {
    return (
      <NoticeScreen
        tone="success"
        title="Предложение отправлено"
        text="Исполнитель получил его и примет одним нажатием. Новые условия придут в чат, подтвердите их там."
        actions={[
          { label: 'Открыть чат', onClick: openChat },
          { label: 'К сделке', onClick: onDeal },
        ]}
      />
    );
  }

  const { grid, title } = state.data;
  const todayKey = days[0]?.key ?? '';
  const selectedDay = day && slotsByDay.has(day) ? day : defaultPickerDay(days, freeOf, grid.current);
  // Прошедшие и слишком близкие слоты не показываем вовсе: серые кнопки без подписи только мешают выбору.
  const slots = (slotsByDay.get(selectedDay) ?? []).filter((s) => s.state !== 'off');
  const free = freeCount(slots);
  // Выбор действует, пока слот свободен: время идёт, а после перезапроса занятости слот мог стать «занято».
  const pickedSlot = picked ? (slotsByDay.get(dayKeyOf(picked) ?? '')?.find((s) => s.iso === picked) ?? null) : null;
  const chosen = pickedSlot?.state === 'free' ? pickedSlot : null;

  function selectDay(key: string) {
    if (key === selectedDay) return;
    haptic('selection');
    setDay(key);
  }

  function pick(slot: Slot) {
    if (slot.state !== 'free' || sendingRef.current) return;
    haptic('selection');
    setDay(selectedDay);
    setPicked(slot.iso);
  }

  return (
    <Panel mode="secondary" className="dg-root">
      <div className="dg-screen dg-screen_plain">
        <AppHeader
          title="Другое время"
          subtitle={
            <>
              {title}
              <br />
              {`Сейчас в условиях: ${formatDateTime(grid.current)}`}
              <br />
              {`Длительность ${visitText(grid.duration_min > 0 ? grid.duration_min : 60)}`}
            </>
          }
        />

        <DayStrip
          days={days}
          selected={selectedDay}
          counts={NO_COUNTS}
          onSelect={selectDay}
          muted={(key) => freeOf(key) === 0}
          mutedLabel="свободного времени нет"
        />

        <section className="dg-section" aria-labelledby="time-day">
          <div className="dg-section__head">
            <div className="dg-deal-id">
              <Typography.Text variant="title" asChild>
                <h2 id="time-day">{dayTitle(selectedDay, todayKey)}</h2>
              </Typography.Text>
              {reloading ? <Spinner size={16} appearance="themed" aria-label="Обновляем" /> : null}
            </div>
            <Typography.Text variant="description" color="tertiary">
              Время МСК
            </Typography.Text>
          </div>
          {free === 0 ? (
            <p className="dg-slots-empty">Свободного времени нет. Выберите другой день</p>
          ) : (
            <div className="dg-slots" role="group" aria-label="Время начала">
              {slots.map((slot) => {
                const active = chosen?.iso === slot.iso;
                const className = ['dg-slot', `dg-slot_${slot.state}`, active ? 'dg-slot_active' : ''].filter(Boolean).join(' ');
                return (
                  <button
                    key={slot.iso}
                    type="button"
                    className={className}
                    disabled={slot.state !== 'free'}
                    aria-pressed={slot.state === 'free' ? active : undefined}
                    onClick={() => pick(slot)}
                  >
                    <span className="dg-slot__time">{slot.time}</span>
                    {slot.state === 'busy' ? <span className="dg-slot__note">занято</span> : null}
                    {slot.state === 'current' ? <span className="dg-slot__note">сейчас</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {chosen ? (
        <div className="dg-pick-bar">
          <div className="dg-pick-bar__inner">
            <Button type="button" variant="primary" size="large" stretched loading={sending} onClick={() => void propose(chosen.iso)}>
              {proposeLabel(chosen.iso)}
            </Button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
