// Экран «Мои сделки» — docs/SPEC.md §7.4, ЗАДАЧА_04 C: вкладки «Я исполнитель» / «Я клиент», внутри —
// «Расписание» (лента дней по МСК) или «Список» с фильтрами. Строка открывает экран сделки `#/deals/:id` (§7.9,
// ЗАДАЧА_08 B); под строкой остаются «Открыть в чате», «Изменить» и «Повторить». Вид — docs/DESIGN.md §4.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Panel, Spinner, Typography } from '@maxhub/max-ui';

import { api, errorText } from '../api';
import { openBot } from '../bridge';
import { DayStrip } from '../components/DayStrip';
import { DealRow, DealRows, type DealRowAction } from '../components/DealRow';
import { Segmented } from '../components/Segmented';
import { ErrorScreen } from '../components/StateScreen';
import { useToast } from '../components/Toast';
import {
  AWAITING_PAYMENT,
  buildDays,
  buildSchedule,
  dayKey,
  dayTitle,
  defaultDay,
  isTerminal,
  pluralRecords,
  shortDateTime,
  timeOf,
} from '../schedule';
import type { DealListItem, DealsFilter, DealStatus, MeResponse } from '../types';

type Role = 'seller' | 'client';
type View = 'schedule' | 'list';

const ROLE_TABS: { value: Role; label: string }[] = [
  { value: 'seller', label: 'Я исполнитель' },
  { value: 'client', label: 'Я клиент' },
];

const VIEWS: { value: View; label: string }[] = [
  { value: 'schedule', label: '📅 Расписание' },
  { value: 'list', label: '☰ Список' },
];

// Подписи короче, чем в SPEC §7.4: четыре полных не помещаются на 375 px и обрезаются многоточием.
// «Закрытые» заодно точнее «Завершённых» — в этот фильтр попадают и отменённые, и отклонённые.
const FILTERS: { value: DealsFilter; label: string }[] = [
  { value: 'active', label: 'Активные' },
  { value: 'awaiting_payment', label: 'К оплате' },
  { value: 'done', label: 'Закрытые' },
  { value: 'all', label: 'Все' },
];

const EMPTY_TEXT: Record<Role, Record<DealsFilter, string>> = {
  seller: {
    active: 'Активных сделок нет. Создайте новую — это займёт полминуты.',
    awaiting_payment: 'Сейчас никто ничего не должен: сделок, ждущих оплаты, нет.',
    done: 'Закрытых сделок пока нет.',
    all: 'Вы ещё не создавали сделок как исполнитель. Создайте первую — это займёт полминуты.',
  },
  client: {
    active: 'Активных записей нет.',
    awaiting_payment: 'Оплачивать сейчас нечего.',
    done: 'Закрытых записей пока нет.',
    all: 'Записей пока нет.',
  },
};

/** Исполнитель: «Изменить» — пока клиент не подтвердил (T5), «Повторить» — у закрытых (ЗАДАЧА_04 C5). */
const EDITABLE: readonly DealStatus[] = ['awaiting_confirmation', 'changes_requested'];

// ─────────────── запоминание вида (localStorage в WebView MAX бывает запрещён — всё в try/catch) ───────────────

const VIEW_KEY = 'dogovorilis:deals-view:';

/** Исполнителю — расписание (его день — это записи); клиенту — список: у него 1–3 записи у разных исполнителей. */
const DEFAULT_VIEW: Record<Role, View> = { seller: 'schedule', client: 'list' };

function recallView(role: Role): View {
  try {
    const saved = window.localStorage.getItem(`${VIEW_KEY}${role}`);
    if (saved === 'schedule' || saved === 'list') return saved;
  } catch {
    /* хранилище недоступно — вид по умолчанию */
  }
  return DEFAULT_VIEW[role];
}

function rememberView(role: Role, view: View): void {
  try {
    window.localStorage.setItem(`${VIEW_KEY}${role}`, view);
  } catch {
    /* не запомнили — не страшно */
  }
}

// ─────────────────────────────────────────── список ───────────────────────────────────────────

function matchesFilter(item: DealListItem, filter: DealsFilter): boolean {
  if (filter === 'active') return !isTerminal(item.status);
  if (filter === 'done') return isTerminal(item.status);
  if (filter === 'awaiting_payment') return AWAITING_PAYMENT.includes(item.status);
  return true;
}

/** Действующие — ближайшие сверху, без даты в конце; закрытые и «Все» — как отдал сервер (свежие изменения сверху). */
function sortForFilter(items: DealListItem[], filter: DealsFilter): DealListItem[] {
  if (filter === 'done' || filter === 'all') return items;
  return [...items].sort((a, b) => {
    if (a.scheduled_at && b.scheduled_at) return a.scheduled_at.localeCompare(b.scheduled_at);
    if (a.scheduled_at) return -1;
    if (b.scheduled_at) return 1;
    return 0;
  });
}

function listMeta(item: DealListItem): string {
  const when = item.scheduled_at ? shortDateTime(item.scheduled_at) : 'Без даты';
  return `${when} · ${item.status_short}`;
}

// ─────────────────────────────────────────── экран ───────────────────────────────────────────

export interface DealsScreenProps {
  me: MeResponse;
  onNewDeal: () => void;
  /** Экран сделки `#/deals/:id` — по нажатию на строку. */
  onOpen: (publicId: string) => void;
  /** Правка условий (`#/deals/:id/edit`); не передан — кнопки «Изменить» нет. */
  onEdit?: (publicId: string) => void;
  /** Повтор закрытой сделки (`#/new?from=:id`); не передан — кнопки «Повторить» нет. */
  onRepeat?: (publicId: string) => void;
}

export function DealsScreen({ me, onNewDeal, onOpen, onEdit, onRepeat }: DealsScreenProps) {
  const showToast = useToast();
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
      // Одним запросом все роли и статусы (до 200 строк) — вкладки, фильтры и дни считаются на клиенте (ЗАДАЧА_04 C3).
      const response = await api.deals({ role: 'all', filter: 'all' });
      setItems(response.items);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Демо-сделка принадлежит исполнителю (клиент в ней — он сам), поэтому во вкладку «Я клиент» не попадает.
  const sellerItems = useMemo(() => items?.filter((i) => i.role === 'seller') ?? [], [items]);
  const clientItems = useMemo(() => items?.filter((i) => i.role === 'client' && !i.demo) ?? [], [items]);

  // Вкладка по умолчанию: исполнитель; если своих сделок нет, а клиентские есть — сразу «Я клиент».
  const activeRole: Role = role ?? (sellerItems.length === 0 && clientItems.length > 0 ? 'client' : 'seller');
  const roleItems = activeRole === 'seller' ? sellerItems : clientItems;
  const view = views[activeRole];

  const schedule = useMemo(() => buildSchedule(roleItems, todayKey), [roleItems, todayKey]);
  const selectedDay = pickedDay ?? defaultDay(schedule, todayKey);

  function openInChat(publicId: string) {
    if (!openBot(me.config.bot_username, `d_${publicId}`)) {
      showToast('Не удалось открыть чат с ботом. Откройте его в MAX вручную', 'error');
    }
  }

  function openChat() {
    if (!openBot(me.config.bot_username)) {
      showToast('Не удалось открыть чат с ботом. Откройте его в MAX вручную', 'error');
    }
  }

  function actionsFor(item: DealListItem): DealRowAction[] {
    const actions: DealRowAction[] = [{ label: 'Открыть в чате', onClick: () => openInChat(item.public_id) }];
    if (item.role !== 'seller') return actions;
    if (onEdit && EDITABLE.includes(item.status)) {
      actions.push({ label: 'Изменить', onClick: () => onEdit(item.public_id) });
    }
    if (onRepeat && isTerminal(item.status) && !item.demo) {
      actions.push({ label: 'Повторить', onClick: () => onRepeat(item.public_id) });
    }
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

  if (error) return <ErrorScreen message={error} onRetry={() => void load()} />;

  let body: ReactNode;
  if (items === null) {
    // Спиннер внутри экрана, а не LoadingScreen: тот разворачивает свою Panel во весь экран.
    body = (
      <section className="dg-card dg-card_flat">
        <Spinner size={24} appearance="themed" />
        <Typography.Text variant="body" color="secondary">
          Загружаем сделки…
        </Typography.Text>
      </section>
    );
  } else if (sellerItems.length === 0 && clientItems.length === 0) {
    body = (
      <section className="dg-card">
        <Typography.Text variant="body" color="secondary">
          Пока нет сделок. Создайте первую — это займёт полминуты.
        </Typography.Text>
        <Button variant="primary" size="large" stretched onClick={onNewDeal}>
          Новая сделка
        </Button>
      </section>
    );
  } else {
    body = (
      <>
        {clientItems.length > 0 ? (
          <Segmented options={ROLE_TABS} value={activeRole} onChange={switchRole} ariaLabel="Чьи сделки показать" />
        ) : null}

        {roleItems.length > 0 ? <ViewSwitch value={view} onChange={switchView} /> : null}

        {roleItems.length === 0 ? (
          <section className="dg-card">
            <Typography.Text variant="body" color="secondary">
              {EMPTY_TEXT[activeRole].all}
            </Typography.Text>
            {activeRole === 'seller' ? (
              <Button variant="primary" size="large" stretched onClick={onNewDeal}>
                Новая сделка
              </Button>
            ) : null}
          </section>
        ) : view === 'schedule' ? (
          <ScheduleView
            days={days}
            todayKey={todayKey}
            selectedDay={selectedDay}
            onSelectDay={setPickedDay}
            schedule={schedule}
            actionsFor={actionsFor}
            onOpen={onOpen}
            onShowList={() => switchView('list')}
          />
        ) : (
          <ListView
            role={activeRole}
            items={roleItems}
            filter={filter}
            onFilter={setFilter}
            actionsFor={actionsFor}
            onOpen={onOpen}
            onNewDeal={onNewDeal}
          />
        )}
      </>
    );
  }

  return (
    <Panel mode="secondary" className="dg-root">
      <div className="dg-screen">
        <Typography.Headline variant="large-strong" asChild>
          <h1>Мои сделки</h1>
        </Typography.Headline>

        {body}

        <footer className="dg-card dg-card_flat dg-card_row">
          <Typography.Text variant="description" color="secondary">
            Карточки сделок — в чате с ботом
          </Typography.Text>
          <Button type="button" variant="secondary" size="small" onClick={openChat}>
            Открыть чат
          </Button>
        </footer>
      </div>
    </Panel>
  );
}

/** «Расписание» / «Список» — чипы (как табы в DESIGN §4), чтобы не спорить с сегмент-контролом вкладок над ними. */
function ViewSwitch({ value, onChange }: { value: View; onChange: (view: View) => void }) {
  return (
    <div className="dg-chips dg-chips_tight" role="group" aria-label="Вид">
      {VIEWS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'dg-chip dg-chip_active' : 'dg-chip'}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────── расписание ───────────────────────────────────────────

interface ScheduleViewProps {
  days: ReturnType<typeof buildDays>;
  todayKey: string;
  selectedDay: string;
  onSelectDay: (key: string) => void;
  schedule: ReturnType<typeof buildSchedule>;
  actionsFor: (item: DealListItem) => DealRowAction[];
  onOpen: (publicId: string) => void;
  onShowList: () => void;
}

function ScheduleView({ days, todayKey, selectedDay, onSelectDay, schedule, actionsFor, onOpen, onShowList }: ScheduleViewProps) {
  const dayItems = schedule.byDay.get(selectedDay) ?? [];
  return (
    <>
      <DayStrip
        days={days}
        selected={selectedDay}
        counts={(key) => schedule.byDay.get(key)?.length ?? 0}
        onSelect={onSelectDay}
      />

      <section className="dg-section" aria-labelledby="schedule-day">
        <div className="dg-section__head">
          <Typography.Text variant="title" asChild>
            <h2 id="schedule-day">{dayTitle(selectedDay, todayKey)}</h2>
          </Typography.Text>
          <Typography.Text variant="description" color="tertiary">
            {dayItems.length > 0 ? `${pluralRecords(dayItems.length)} · время — МСК` : 'время — МСК'}
          </Typography.Text>
        </div>
        {dayItems.length > 0 ? (
          <DealRows>
            {dayItems.map((item) => (
              <DealRow
                key={item.public_id}
                item={item}
                lead={item.scheduled_at ? timeOf(item.scheduled_at) : undefined}
                meta={item.status_short}
                actions={actionsFor(item)}
                onOpen={() => onOpen(item.public_id)}
              />
            ))}
          </DealRows>
        ) : (
          <div className="dg-card dg-card_flat">
            <Typography.Text variant="body" color="secondary">
              Записей нет
            </Typography.Text>
          </div>
        )}
      </section>

      {schedule.undated.length > 0 ? (
        <section className="dg-section" aria-labelledby="schedule-undated">
          <div className="dg-section__head">
            <Typography.Text variant="title" asChild>
              <h2 id="schedule-undated">Без даты</h2>
            </Typography.Text>
            <Typography.Text variant="description" color="tertiary">
              Срок не назначен — договоритесь о нём в чате
            </Typography.Text>
          </div>
          <DealRows>
            {schedule.undated.map((item) => (
              <DealRow
                key={item.public_id}
                item={item}
                meta={item.status_short}
                actions={actionsFor(item)}
                onOpen={() => onOpen(item.public_id)}
              />
            ))}
          </DealRows>
        </section>
      ) : null}

      {schedule.laterCount > 0 ? (
        <div className="dg-card dg-card_flat dg-card_row">
          <Typography.Text variant="body" color="secondary">
            {`Позже трёх недель — ещё ${pluralRecords(schedule.laterCount)}`}
          </Typography.Text>
          <Button type="button" variant="secondary" size="small" onClick={onShowList}>
            Открыть список
          </Button>
        </div>
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
  onOpen: (publicId: string) => void;
  onNewDeal: () => void;
}

function ListView({ role, items, filter, onFilter, actionsFor, onOpen, onNewDeal }: ListViewProps) {
  const shown = sortForFilter(
    items.filter((item) => matchesFilter(item, filter)),
    filter,
  );
  return (
    <>
      <Segmented options={FILTERS} value={filter} onChange={onFilter} ariaLabel="Фильтр сделок" compact />
      {shown.length > 0 ? (
        <>
          <DealRows>
            {shown.map((item) => (
              <DealRow
                key={item.public_id}
                item={item}
                meta={listMeta(item)}
                actions={actionsFor(item)}
                onOpen={() => onOpen(item.public_id)}
              />
            ))}
          </DealRows>
          <Typography.Text variant="description" color="tertiary">
            Время — МСК
          </Typography.Text>
        </>
      ) : (
        <section className="dg-card">
          <Typography.Text variant="body" color="secondary">
            {EMPTY_TEXT[role][filter]}
          </Typography.Text>
          {role === 'seller' ? (
            <Button variant="primary" size="large" stretched onClick={onNewDeal}>
              Новая сделка
            </Button>
          ) : null}
        </section>
      )}
    </>
  );
}
