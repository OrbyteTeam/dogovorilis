// Экран «Сделки» (DESIGN_BRIEF §5.3, SPEC §7.4, ЗАДАЧА_04 C): вкладки «Исполнитель / Клиент», внутри «Расписание»
// (лента дней по МСК) или «Список» с фильтрами. Экрана сделки пока нет (ЗАДАЧА_08 B), поэтому под строкой действия
// «Открыть в чате», «Изменить условия», «Повторить сделку»: карточка в боте и есть экран сделки.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Typography } from '@maxhub/max-ui';

import { api, errorText } from '../api';
import { openBot } from '../bridge';
import { AppHeader } from '../components/AppHeader';
import { DayStrip } from '../components/DayStrip';
import { DealRow, DealRows, type DealRowAction } from '../components/DealRow';
import { Island, Screen } from '../components/Screen';
import { Segmented } from '../components/Segmented';
import { useSnackbar } from '../components/Snackbar';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { listDateTime } from '../format';
import { AWAITING_PAYMENT, buildDays, buildSchedule, dayKey, dayTitle, dealsWord, defaultDay, isTerminal, timeOf } from '../schedule';
import type { DealListItem, DealsFilter, DealStatus, MeResponse } from '../types';

type Role = 'seller' | 'client';
type View = 'schedule' | 'list';

const ROLE_TABS: { value: Role; label: string }[] = [
  { value: 'seller', label: 'Исполнитель' },
  { value: 'client', label: 'Клиент' },
];

const VIEWS: { value: View; label: string }[] = [
  { value: 'schedule', label: 'Расписание' },
  { value: 'list', label: 'Список' },
];

// Подписи короче, чем в SPEC §7.4: четыре полных не помещаются на 375 px. «Закрытые» точнее «Завершённых»:
// в этот фильтр попадают и отменённые, и отклонённые.
const FILTERS: { value: DealsFilter; label: string }[] = [
  { value: 'active', label: 'Активные' },
  { value: 'awaiting_payment', label: 'К оплате' },
  { value: 'done', label: 'Закрытые' },
  { value: 'all', label: 'Все' },
];

/** Пустое по вкладке и фильтру (DESIGN_BRIEF §5.3): исполнителю с кнопкой «Новая сделка», клиенту без кнопки. */
const EMPTY: Record<Role, Record<DealsFilter, { title: string; text: string }>> = {
  seller: {
    active: { title: 'Активных сделок нет', text: 'Создайте новую, это займёт полминуты' },
    awaiting_payment: { title: 'Оплат не ждём', text: 'Сделок, где ждём предоплату или остаток, сейчас нет' },
    done: { title: 'Закрытых сделок пока нет', text: 'Здесь будут закрытые, отменённые и истёкшие сделки' },
    all: { title: 'Сделок пока нет', text: 'Создайте первую, это займёт полминуты' },
  },
  client: {
    active: { title: 'Активных сделок нет', text: 'Здесь появятся сделки, которые вам предложат' },
    awaiting_payment: { title: 'Оплачивать нечего', text: 'Когда понадобится внести предоплату или остаток, сделка будет здесь' },
    done: { title: 'Закрытых сделок пока нет', text: 'Здесь будут закрытые и отменённые сделки' },
    all: { title: 'Сделок пока нет', text: 'Здесь появятся сделки, которые вам предложат' },
  },
};

/** Исполнитель: «Изменить условия», пока клиент не подтвердил (T5); «Повторить сделку» у закрытых (ЗАДАЧА_04 C5). */
const EDITABLE: readonly DealStatus[] = ['awaiting_confirmation', 'changes_requested'];

// ─────────────── запоминание вида (localStorage в WebView MAX бывает запрещён, поэтому всё в try/catch) ───────────────

const VIEW_KEY = 'dogovorilis:deals-view:';

/** Исполнителю расписание (его день состоит из сделок); клиенту список: у него одна-три сделки у разных исполнителей. */
const DEFAULT_VIEW: Record<Role, View> = { seller: 'schedule', client: 'list' };

function recallView(role: Role): View {
  try {
    const saved = window.localStorage.getItem(`${VIEW_KEY}${role}`);
    if (saved === 'schedule' || saved === 'list') return saved;
  } catch {
    /* хранилище недоступно: вид по умолчанию */
  }
  return DEFAULT_VIEW[role];
}

function rememberView(role: Role, view: View): void {
  try {
    window.localStorage.setItem(`${VIEW_KEY}${role}`, view);
  } catch {
    /* не запомнили, не страшно */
  }
}

function matchesFilter(item: DealListItem, filter: DealsFilter): boolean {
  if (filter === 'active') return !isTerminal(item.status);
  if (filter === 'done') return isTerminal(item.status);
  if (filter === 'awaiting_payment') return AWAITING_PAYMENT.includes(item.status);
  return true;
}

/** Действующие: ближайшие сверху, без даты в конце; закрытые и «Все» как отдал сервер (свежие изменения сверху). */
function sortForFilter(items: DealListItem[], filter: DealsFilter): DealListItem[] {
  if (filter === 'done' || filter === 'all') return items;
  return [...items].sort((a, b) => {
    if (a.scheduled_at && b.scheduled_at) return a.scheduled_at.localeCompare(b.scheduled_at);
    if (a.scheduled_at) return -1;
    if (b.scheduled_at) return 1;
    return 0;
  });
}

export interface DealsScreenProps {
  me: MeResponse;
  onNewDeal: () => void;
  /** Правка условий (`#/deals/:id/edit`); не передан: кнопки «Изменить условия» нет. */
  onEdit?: (publicId: string) => void;
  /** Повтор закрытой сделки (`#/new?from=:id`); не передан: кнопки «Повторить сделку» нет. */
  onRepeat?: (publicId: string) => void;
  /** Список загружен: каркас пересчитывает счётчик на нижней панели. */
  onLoaded?: (items: DealListItem[]) => void;
}

export function DealsScreen({ me, onNewDeal, onEdit, onRepeat, onLoaded }: DealsScreenProps) {
  const snackbar = useSnackbar();
  const [items, setItems] = useState<DealListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [views, setViews] = useState<Record<Role, View>>(() => ({ seller: recallView('seller'), client: recallView('client') }));
  const [filter, setFilter] = useState<DealsFilter>('active');
  const [pickedDay, setPickedDay] = useState<string | null>(null);

  // «Сегодня» фиксируем на время жизни экрана: лента не должна перескакивать в полночь под пальцем.
  const todayKey = useMemo(() => dayKey(new Date()), []);
  const days = useMemo(() => buildDays(todayKey), [todayKey]);

  const load = useCallback(async () => {
    setError(null);
    setItems(null);
    try {
      // Одним запросом все роли и статусы (до 200 строк): вкладки, фильтры и дни считаются на клиенте (ЗАДАЧА_04 C3).
      const response = await api.deals({ role: 'all', filter: 'all' });
      setItems(response.items);
      onLoaded?.(response.items);
    } catch (e) {
      setError(errorText(e));
    }
  }, [onLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  // Демо-сделка принадлежит исполнителю (клиент в ней он сам), поэтому во вкладку «Клиент» не попадает.
  const sellerItems = useMemo(() => items?.filter((i) => i.role === 'seller') ?? [], [items]);
  const clientItems = useMemo(() => items?.filter((i) => i.role === 'client' && !i.demo) ?? [], [items]);

  // Вкладка по умолчанию исполнитель; если своих сделок нет, а клиентские есть, сразу «Клиент».
  const activeRole: Role = role ?? (sellerItems.length === 0 && clientItems.length > 0 ? 'client' : 'seller');
  const roleItems = activeRole === 'seller' ? sellerItems : clientItems;
  const view = views[activeRole];

  const schedule = useMemo(() => buildSchedule(roleItems, todayKey), [roleItems, todayKey]);
  const selectedDay = pickedDay ?? defaultDay(schedule, todayKey);

  function openChat(publicId?: string) {
    if (!openBot(me.config.bot_username, publicId ? `d_${publicId}` : undefined)) {
      snackbar('Не удалось открыть чат с ботом. Откройте его в MAX вручную', { tone: 'error' });
    }
  }

  function actionsFor(item: DealListItem): DealRowAction[] {
    const actions: DealRowAction[] = [{ label: 'Открыть в чате', onClick: () => openChat(item.public_id) }];
    if (item.role !== 'seller') return actions;
    if (onEdit && EDITABLE.includes(item.status)) actions.push({ label: 'Изменить условия', onClick: () => onEdit(item.public_id) });
    if (onRepeat && isTerminal(item.status) && !item.demo) actions.push({ label: 'Повторить сделку', onClick: () => onRepeat(item.public_id) });
    return actions;
  }

  function switchRole(next: Role) {
    setRole(next);
    setPickedDay(null);
    setFilter('active');
  }

  function switchView(next: View) {
    setViews((prev) => ({ ...prev, [activeRole]: next }));
    rememberView(activeRole, next);
  }

  let body: ReactNode;
  if (error) {
    body = <ErrorState title="Не удалось загрузить сделки" text={error} onRetry={() => void load()} />;
  } else if (items === null) {
    body = <Skeleton kind="list" />;
  } else if (roleItems.length === 0) {
    const empty = EMPTY[activeRole].all;
    body = (
      <>
        {clientItems.length > 0 ? <Segmented options={ROLE_TABS} value={activeRole} onChange={switchRole} ariaLabel="Чьи сделки показать" /> : null}
        <EmptyState
          title={empty.title}
          text={empty.text}
          actions={activeRole === 'seller' ? [{ label: 'Новая сделка', onClick: onNewDeal }] : []}
        />
      </>
    );
  } else {
    body = (
      <>
        {clientItems.length > 0 ? <Segmented options={ROLE_TABS} value={activeRole} onChange={switchRole} ariaLabel="Чьи сделки показать" /> : null}
        <Segmented options={VIEWS} value={view} onChange={switchView} ariaLabel="Вид" />
        {view === 'schedule' ? (
          <ScheduleView
            role={activeRole}
            days={days}
            todayKey={todayKey}
            selectedDay={selectedDay}
            onSelectDay={setPickedDay}
            schedule={schedule}
            actionsFor={actionsFor}
            onShowList={() => switchView('list')}
          />
        ) : (
          <ListView role={activeRole} items={roleItems} filter={filter} onFilter={setFilter} actionsFor={actionsFor} onNewDeal={onNewDeal} />
        )}
      </>
    );
  }

  return (
    <Screen>
      <AppHeader title="Сделки" />
      {body}
      {items !== null && !error ? (
        <Island flat>
          <div className="dg-row">
            <Typography.Label variant="small" className="dg-note">
              Действия и оплата по сделке на её карточке в чате с ботом
            </Typography.Label>
            <Button type="button" variant="secondary" size="small" onClick={() => openChat()}>
              Открыть чат
            </Button>
          </div>
        </Island>
      ) : null}
    </Screen>
  );
}

// ─────────────────────────────────────────── расписание ───────────────────────────────────────────

interface ScheduleViewProps {
  role: Role;
  days: ReturnType<typeof buildDays>;
  todayKey: string;
  selectedDay: string;
  onSelectDay: (key: string) => void;
  schedule: ReturnType<typeof buildSchedule>;
  actionsFor: (item: DealListItem) => DealRowAction[];
  onShowList: () => void;
}

/** Под названием в расписании: исполнителю имя клиента; клиенту имени исполнителя API списка не отдаёт. */
function whoOf(item: DealListItem): string | undefined {
  if (item.role !== 'seller') return undefined;
  if (item.demo) return 'демо-клиент';
  return item.client_name?.trim() || 'клиент ещё не открыл ссылку';
}

function ScheduleView({ role, days, todayKey, selectedDay, onSelectDay, schedule, actionsFor, onShowList }: ScheduleViewProps) {
  const dayItems = schedule.byDay.get(selectedDay) ?? [];
  return (
    <>
      <DayStrip days={days} selected={selectedDay} counts={(key) => schedule.byDay.get(key)?.length ?? 0} onSelect={onSelectDay} />

      <section className="dg-section" aria-labelledby="schedule-day">
        <div className="dg-section__head">
          <Typography.Title variant="medium-strong" asChild>
            <h2 id="schedule-day">{dayTitle(selectedDay, todayKey)}</h2>
          </Typography.Title>
          <Typography.Label variant="small" className="dg-note">
            {dayItems.length > 0 ? `${dealsWord(dayItems.length)}, время МСК` : 'Время МСК'}
          </Typography.Label>
        </div>
        {dayItems.length > 0 ? (
          <DealRows>
            {dayItems.map((item) => (
              <DealRow
                key={item.public_id}
                item={item}
                overline={item.scheduled_at ? timeOf(item.scheduled_at) : undefined}
                subtitle={whoOf(item)}
                actions={actionsFor(item)}
              />
            ))}
          </DealRows>
        ) : (
          <Island flat>
            <Typography.Body variant="medium" className="dg-muted">
              Сделок нет
            </Typography.Body>
          </Island>
        )}
      </section>

      {schedule.undated.length > 0 ? (
        <section className="dg-section" aria-labelledby="schedule-undated">
          <div className="dg-section__head">
            <Typography.Title variant="medium-strong" asChild>
              <h2 id="schedule-undated">Без даты</h2>
            </Typography.Title>
            <Typography.Label variant="small" className="dg-note">
              Срок не назначен, договоритесь о нём в чате
            </Typography.Label>
          </div>
          <DealRows>
            {schedule.undated.map((item) => (
              <DealRow key={item.public_id} item={item} subtitle={role === 'seller' ? whoOf(item) : undefined} actions={actionsFor(item)} />
            ))}
          </DealRows>
        </section>
      ) : null}

      {schedule.laterCount > 0 ? (
        <Island flat>
          <div className="dg-row">
            <Typography.Body variant="medium" className="dg-muted">
              {`Позже трёх недель: ещё ${dealsWord(schedule.laterCount)}`}
            </Typography.Body>
            <Button type="button" variant="secondary" size="small" onClick={onShowList}>
              Открыть список
            </Button>
          </div>
        </Island>
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────── список ───────────────────────────────────────────

interface ListViewProps {
  role: Role;
  items: DealListItem[];
  filter: DealsFilter;
  onFilter: (filter: DealsFilter) => void;
  actionsFor: (item: DealListItem) => DealRowAction[];
  onNewDeal: () => void;
}

function ListView({ role, items, filter, onFilter, actionsFor, onNewDeal }: ListViewProps) {
  const shown = sortForFilter(
    items.filter((item) => matchesFilter(item, filter)),
    filter,
  );
  const empty = EMPTY[role][filter];
  return (
    <>
      <Segmented options={FILTERS} value={filter} onChange={onFilter} ariaLabel="Фильтр сделок" compact />
      {shown.length > 0 ? (
        <>
          <DealRows>
            {shown.map((item) => (
              <DealRow key={item.public_id} item={item} subtitle={listDateTime(item.scheduled_at)} actions={actionsFor(item)} />
            ))}
          </DealRows>
          <Typography.Label variant="small" className="dg-note dg-note_center">
            Время МСК
          </Typography.Label>
        </>
      ) : (
        <EmptyState
          title={empty.title}
          text={empty.text}
          actions={role === 'seller' && (filter === 'active' || filter === 'all') ? [{ label: 'Новая сделка', onClick: onNewDeal }] : []}
        />
      )}
    </>
  );
}
