// Каркас мини-приложения: экран по стеку истории (nav.ts), разбор start_param, загрузка /api/me и /api/templates,
// нижняя панель, BackButton и состояния экранов (SPEC §7.1, §13; DESIGN_BRIEF §5.1–5.2; ЗАДАЧА_08 A).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { api, ApiError, errorText } from './api';
import { backButton, DEV_NO_BRIDGE, haptic, insideMax, isAvailable, openBot, startParam } from './bridge';
import { AppHeader } from './components/AppHeader';
import { BottomSheet } from './components/BottomSheet';
import { Screen } from './components/Screen';
import { AuthFailedScreen, BridgeMissingScreen } from './components/ServiceScreens';
import { SnackbarProvider } from './components/Snackbar';
import { ErrorState, Skeleton } from './components/States';
import { TabBar } from './components/TabBar';
import { FormDirtyContext } from './formGuard';
import { needsMove } from './format';
import {
  back,
  canGoBack,
  current,
  initialRoute,
  parseHash,
  push,
  routeToHash,
  startHistory,
  tabOf,
  tabRoute,
  type History,
  type Route,
} from './nav';
import { DealScreen } from './screens/Deal';
import { DealsScreen } from './screens/Deals';
import { DoneScreen } from './screens/Done';
import { EditDealScreen } from './screens/EditDeal';
import { NewScreen } from './screens/New';
import { RepeatDealScreen } from './screens/RepeatDeal';
import { ServiceFormScreen } from './screens/ServiceForm';
import { ServicesScreen } from './screens/Services';
import { SettingsScreen } from './screens/Settings';
import { TimePickerScreen } from './screens/TimePicker';
import type { CreateDealRequest, CreateDealResponse, DealListItem, MeResponse, SellerProfile, Template } from './types';

const DONE_STORAGE_PREFIX = 'dogovorilis:done:';

/** Кэш результата создания на время сессии: sessionStorage в MAX WebView может быть недоступен. */
const doneCache = new Map<string, CreateDealResponse>();

function rememberDone(result: CreateDealResponse): void {
  doneCache.set(result.deal.public_id, result);
  try {
    window.sessionStorage.setItem(`${DONE_STORAGE_PREFIX}${result.deal.public_id}`, JSON.stringify(result));
  } catch {
    /* приватный режим или запрет хранилища: остаётся кэш в памяти */
  }
}

function recallDone(publicId: string): CreateDealResponse | null {
  const cached = doneCache.get(publicId);
  if (cached) return cached;
  try {
    const raw = window.sessionStorage.getItem(`${DONE_STORAGE_PREFIX}${publicId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CreateDealResponse;
    if (!parsed?.deal?.public_id) return null;
    doneCache.set(publicId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Адресная строка отражает текущий экран, но записей в истории WebView не создаёт: история — наш стек (nav.ts). */
function syncHash(route: Route): void {
  const hash = routeToHash(route);
  if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
}

interface AppData {
  me: MeResponse;
  templates: Template[];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: AppData }
  | { status: 'error'; message: string }
  | { status: 'unauthorized' };

type NavOptions = { replace?: boolean };

/** Куда уйти после подтверждения «Уйти без сохранения?»: на экран или на шаг назад. */
type Pending = { kind: 'to'; route: Route; opts?: NavOptions } | { kind: 'back' };

const LOADING_TITLE: Record<Route['name'], string> = {
  new: 'Новая сделка',
  done: 'Сделка',
  deals: 'Сделки',
  edit: 'Изменить условия',
  deal: 'Сделка',
  time: 'Другое время',
  settings: 'Настройки',
  services: 'Мои услуги',
  service: 'Услуга',
};

const LOAD_ERROR_TITLE: Record<Route['name'], string> = {
  new: 'Не удалось загрузить форму',
  done: 'Не удалось загрузить сделку',
  deals: 'Не удалось загрузить сделки',
  edit: 'Не удалось загрузить форму',
  deal: 'Не удалось загрузить сделку',
  time: 'Не удалось загрузить сделку',
  settings: 'Не удалось загрузить настройки',
  services: 'Не удалось загрузить услуги',
  service: 'Не удалось загрузить услугу',
};

function skeletonOf(route: Route): 'form' | 'list' | 'card' {
  if (route.name === 'deals' || route.name === 'services') return 'list';
  if (route.name === 'done' || route.name === 'deal' || route.name === 'time') return 'card';
  return 'form';
}

function Router() {
  const [history, setHistory] = useState<History>(() => startHistory(initialRoute(window.location.hash, startParam())));
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [moves, setMoves] = useState(0);
  const dirty = useRef(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const route = current(history);

  const go = useCallback((to: Route, opts?: NavOptions) => setHistory((h) => push(h, to, opts)), []);

  /** Переход по панели и кнопкам экранов: с несохранённой формы сначала спрашиваем (§5.2, BottomSheet). */
  const navigate = useCallback(
    (to: Route, opts?: NavOptions) => {
      if (routeToHash(to) === routeToHash(route)) return;
      if (dirty.current) {
        setPending({ kind: 'to', route: to, opts });
        return;
      }
      go(to, opts);
    },
    [go, route],
  );

  const goBack = useCallback(() => {
    if (dirty.current) {
      setPending({ kind: 'back' });
      return;
    }
    setHistory(back);
  }, []);

  useEffect(() => syncHash(route), [route]);

  // Ручная правка адреса (разработка в браузере): как обычный переход.
  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHash(window.location.hash);
      if (parsed) go(parsed);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [go]);

  // BackButton MAX ведёт по истории внутри приложения; на корневом экране (с которого открыли мини-приложение)
  // кнопки нет, и «назад» закрывает приложение средствами MAX (SPEC §7.1, ЗАДАЧА_08 A).
  const hasBack = canGoBack(history);
  useEffect(() => {
    if (!hasBack) {
      backButton.hide();
      return;
    }
    backButton.onClick(goBack);
    backButton.show();
    return () => {
      backButton.offClick(goBack);
      backButton.hide();
    };
  }, [hasBack, goBack]);

  // Экран сменился: наверх, иначе новый экран открывается с прокруткой прежнего.
  const routeHash = routeToHash(route);
  useEffect(() => {
    try {
      window.scrollTo(0, 0);
    } catch {
      /* нет окна: нечего прокручивать */
    }
  }, [routeHash]);

  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  const countMoves = useCallback((items: DealListItem[]) => {
    const now = new Date();
    setMoves(items.filter((item) => !(item.role === 'client' && item.demo) && needsMove(item, now)).length);
  }, []);

  const refreshMoves = useCallback(() => {
    // Счётчик на «Сделках» грузим в фоне: без него приложение работает, ошибку не показываем.
    api
      .deals({ role: 'all', filter: 'active' })
      .then((response) => countMoves(response.items))
      .catch(() => undefined);
  }, [countMoves]);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [me, templates] = await Promise.all([api.me(), api.templates()]);
      setState({ status: 'ready', data: { me, templates: templates.items } });
      refreshMoves();
    } catch (error) {
      if (error instanceof ApiError && error.isAuth) {
        setState({ status: 'unauthorized' });
        return;
      }
      setState({ status: 'error', message: errorText(error) });
    }
  }, [refreshMoves]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateProfile = useCallback((profile: SellerProfile) => {
    setState((prev) => (prev.status === 'ready' ? { ...prev, data: { ...prev.data, me: { ...prev.data.me, profile } } } : prev));
  }, []);

  // 401: вне MAX экран W0; внутри MAX (initData есть, но не принят) «закройте и откройте заново» и «Повторить».
  if (state.status === 'unauthorized') {
    return insideMax() ? <AuthFailedScreen onRetry={() => void load()} /> : <BridgeMissingScreen />;
  }

  let content: ReactNode;
  if (state.status === 'loading') {
    content = (
      <Screen>
        <AppHeader title={LOADING_TITLE[route.name]} />
        <Skeleton kind={skeletonOf(route)} />
      </Screen>
    );
  } else if (state.status === 'error') {
    content = (
      <Screen>
        <AppHeader title={LOADING_TITLE[route.name]} />
        <ErrorState title={LOAD_ERROR_TITLE[route.name]} text={state.message} onRetry={() => void load()} />
      </Screen>
    );
  } else {
    content = renderRoute(route, state.data, { navigate, updateProfile, countMoves, refreshMoves });
  }

  return (
    <FormDirtyContext.Provider value={setDirty}>
      <div className="dg-shell">
        {content}
        <TabBar active={tabOf(route)} dealsCounter={moves} onSelect={(tab) => navigate(tabRoute(tab))} />
      </div>
      <BottomSheet
        open={pending !== null}
        title="Уйти без сохранения?"
        text="Введённые условия не сохранятся, форму придётся заполнить заново."
        confirmLabel="Уйти без сохранения"
        cancelLabel="Остаться"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const next = pending;
          dirty.current = false;
          setPending(null);
          if (next?.kind === 'back') setHistory(back);
          else if (next) go(next.route, next.opts);
        }}
      />
    </FormDirtyContext.Provider>
  );
}

interface RouteActions {
  navigate: (route: Route, opts?: NavOptions) => void;
  updateProfile: (profile: SellerProfile) => void;
  countMoves: (items: DealListItem[]) => void;
  refreshMoves: () => void;
}

function renderRoute(route: Route, data: AppData, a: RouteActions): ReactNode {
  const { me, templates } = data;

  async function createDeal(payload: CreateDealRequest): Promise<void> {
    const result = await api.createDeal(payload);
    haptic('success');
    rememberDone(result);
    // Профиль сохранён вместе со сделкой: без этого следующая «Новая сделка» снова покажет пустой блок «О вас».
    if (payload.profile) a.updateProfile(payload.profile);
    a.refreshMoves();
    // «Готово» заменяет форму: «назад» с него не должен возвращать к уже отправленной форме.
    a.navigate({ name: 'done', id: result.deal.public_id }, { replace: true });
  }

  switch (route.name) {
    case 'deals':
      return (
        <DealsScreen
          me={me}
          onNewDeal={() => a.navigate({ name: 'new' })}
          onOpen={(id) => a.navigate({ name: 'deal', id })}
          onEdit={(id) => a.navigate({ name: 'edit', id })}
          onRepeat={(id) => a.navigate({ name: 'new', from: id })}
          onLoaded={a.countMoves}
        />
      );
    case 'edit':
      return (
        <EditDealScreen
          key={route.id}
          publicId={route.id}
          me={me}
          templates={templates}
          onDeals={() => a.navigate({ name: 'deals' })}
          onRepeat={(id) => a.navigate({ name: 'new', from: id })}
        />
      );
    case 'deal':
      return (
        <DealScreen
          key={route.id}
          publicId={route.id}
          me={me}
          onEdit={(id) => a.navigate({ name: 'edit', id })}
          onRepeat={(id) => a.navigate({ name: 'new', from: id })}
          onDeals={() => a.navigate({ name: 'deals' })}
          onTime={(id) => a.navigate({ name: 'time', id })}
        />
      );
    case 'time':
      return (
        <TimePickerScreen
          key={route.id}
          publicId={route.id}
          onOpenChat={() => openBot(me.config.bot_username, `d_${route.id}`)}
          onDeal={() => a.navigate({ name: 'deal', id: route.id })}
          onDeals={() => a.navigate({ name: 'deals' })}
        />
      );
    case 'settings':
      return <SettingsScreen me={me} onSaved={a.updateProfile} onServices={() => a.navigate({ name: 'services' })} />;
    case 'services':
      return (
        <ServicesScreen
          templates={templates}
          onOpen={(id) => a.navigate({ name: 'service', id })}
          onNew={(template) => a.navigate(template ? { name: 'service', id: 'new', template } : { name: 'service', id: 'new' })}
          onSettings={() => a.navigate({ name: 'settings' })}
        />
      );
    case 'service':
      return (
        <ServiceFormScreen
          key={routeToHash(route)}
          id={route.id}
          template={route.template}
          me={me}
          templates={templates}
          // Сохранили: форма уступает место списку, «назад» с него не вернёт к отправленной форме.
          onDone={() => a.navigate({ name: 'services' }, { replace: true })}
        />
      );
    case 'done':
      return (
        <DoneScreen
          key={route.id}
          publicId={route.id}
          me={me}
          result={recallDone(route.id)}
          onDeals={() => a.navigate({ name: 'deals' })}
          onOpenDeal={() => a.navigate({ name: 'deal', id: route.id })}
        />
      );
    case 'new':
      return route.from ? (
        <RepeatDealScreen
          key={route.from}
          publicId={route.from}
          me={me}
          templates={templates}
          onSubmit={createDeal}
          onNewDeal={() => a.navigate({ name: 'new' })}
          onDeals={() => a.navigate({ name: 'deals' })}
        />
      ) : (
        <NewScreen me={me} templates={templates} onSubmit={createDeal} />
      );
  }
}

export function App() {
  // Вне MAX работать нечем: initData нет, значит нет и авторизации (SPEC §7.1, экран W0).
  if (!isAvailable() && !DEV_NO_BRIDGE) return <BridgeMissingScreen />;
  return (
    <SnackbarProvider>
      <Router />
    </SnackbarProvider>
  );
}
