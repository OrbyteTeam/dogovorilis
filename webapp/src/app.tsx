// Каркас мини-приложения: hash-роутинг, разбор start_param, загрузка /api/me и /api/templates, нижняя панель,
// BackButton и состояния экранов (SPEC §7.1, §13; DESIGN_BRIEF §5.1–5.2).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { api, ApiError, errorText } from './api';
import { backButton, DEV_NO_BRIDGE, haptic, insideMax, isAvailable, startParam } from './bridge';
import { AppHeader } from './components/AppHeader';
import { BottomSheet } from './components/BottomSheet';
import { Screen } from './components/Screen';
import { AuthFailedScreen, BridgeMissingScreen } from './components/ServiceScreens';
import { SnackbarProvider } from './components/Snackbar';
import { ErrorState, Skeleton } from './components/States';
import { TabBar, type Tab } from './components/TabBar';
import { FormDirtyContext } from './formGuard';
import { needsMove } from './format';
import { DealsScreen } from './screens/Deals';
import { DoneScreen } from './screens/Done';
import { EditDealScreen } from './screens/EditDeal';
import { NewScreen } from './screens/New';
import { RepeatDealScreen } from './screens/RepeatDeal';
import { SettingsScreen } from './screens/Settings';
import type { CreateDealRequest, CreateDealResponse, DealListItem, MeResponse, SellerProfile, Template } from './types';

type Route =
  /** `from`: «Повторить сделку», форма с условиями прежней сделки (`#/new?from=<id>`). */
  | { name: 'new'; from?: string }
  | { name: 'done'; id: string }
  | { name: 'deals' }
  | { name: 'edit'; id: string }
  | { name: 'settings' };

/** Формат public_id: SPEC §13, `^d_[A-Za-z0-9]{10}$`. */
const DEEPLINK_RE = /^d_([A-Za-z0-9]{10})$/;
/** Правка условий из карточки бота: `edit_<id>` → `#/deals/<id>/edit` (ЗАДАЧА_04 E). */
const EDIT_PARAM_RE = /^edit_([A-Za-z0-9]{10})$/;
const EDIT_HASH_RE = /^\/deals\/([A-Za-z0-9]{10})\/edit$/;
/** «Повторить сделку» из карточки бота: `repeat_<id>` → `#/new?from=<id>` (ЗАДАЧА_04 F). */
const REPEAT_PARAM_RE = /^repeat_([A-Za-z0-9]{10})$/;
const REPEAT_HASH_RE = /^\/new\?from=([A-Za-z0-9]{10})$/;
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

function parseHash(hash: string): Route | null {
  const path = hash.replace(/^#/, '');
  if (path === '/new') return { name: 'new' };
  if (path === '/deals') return { name: 'deals' };
  if (path === '/settings') return { name: 'settings' };
  const repeat = REPEAT_HASH_RE.exec(path);
  if (repeat) return { name: 'new', from: repeat[1] };
  const edit = EDIT_HASH_RE.exec(path);
  if (edit) return { name: 'edit', id: edit[1] };
  const done = /^\/done\/([A-Za-z0-9]{1,32})$/.exec(path);
  if (done) return { name: 'done', id: done[1] };
  return null;
}

function routeToHash(route: Route): string {
  if (route.name === 'done') return `#/done/${route.id}`;
  if (route.name === 'deals') return '#/deals';
  if (route.name === 'settings') return '#/settings';
  if (route.name === 'edit') return `#/deals/${route.id}/edit`;
  return route.from ? `#/new?from=${route.from}` : '#/new';
}

/**
 * Старт по `start_param` (SPEC §7.1, §13): `new` → форма, `d_<id>` → экран «Готово» со ссылкой,
 * `deals` → сделки (§7.4), `settings` → настройки (§7.7), `edit_<id>` → правка условий, `repeat_<id>` → повтор (§7.5).
 */
function resolveInitialRoute(): Route {
  const fromHash = parseHash(window.location.hash);
  if (fromHash) return fromHash;
  const param = (startParam() ?? '').trim();
  const deeplink = DEEPLINK_RE.exec(param);
  if (deeplink) return { name: 'done', id: deeplink[1] };
  const edit = EDIT_PARAM_RE.exec(param);
  if (edit) return { name: 'edit', id: edit[1] };
  const repeat = REPEAT_PARAM_RE.exec(param);
  if (repeat) return { name: 'new', from: repeat[1] };
  if (param === 'deals') return { name: 'deals' };
  if (param === 'settings') return { name: 'settings' };
  return { name: 'new' };
}

/** Корневые экраны нижней панели (DESIGN_BRIEF §5.1). */
function isTabRoot(route: Route): boolean {
  return (route.name === 'new' && !route.from) || route.name === 'deals' || route.name === 'settings';
}

/** Какой пункт панели подсвечен: у правки и повтора родитель «Сделки», у «Готово» «Новая». */
function tabOf(route: Route): Tab {
  if (route.name === 'deals' || route.name === 'edit' || (route.name === 'new' && route.from)) return 'deals';
  if (route.name === 'settings') return 'settings';
  return 'new';
}

/**
 * Куда ведёт системная «назад» (DESIGN_BRIEF §5.1, ЗАДАЧА_04 D). Корневые экраны панели и экран, с которого открыли
 * мини-приложение, закрывают его. Правка и повтор возвращают к «Сделкам», «Готово» к форме новой сделки.
 */
function parentOf(route: Route, entry: Route): Route | null {
  if (routeToHash(route) === routeToHash(entry)) return null;
  if (isTabRoot(route)) return null;
  if (route.name === 'edit' || route.name === 'new') return { name: 'deals' };
  if (route.name === 'done') return { name: 'new' };
  return null;
}

function goTo(route: Route): void {
  const hash = routeToHash(route);
  if (window.location.hash === hash) return;
  window.location.hash = hash;
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

const LOADING_TITLE: Record<Route['name'], string> = {
  new: 'Новая сделка',
  done: 'Сделка',
  deals: 'Сделки',
  edit: 'Изменить условия',
  settings: 'Настройки',
};

const LOAD_ERROR_TITLE: Record<Route['name'], string> = {
  new: 'Не удалось загрузить форму',
  done: 'Не удалось загрузить сделку',
  deals: 'Не удалось загрузить сделки',
  edit: 'Не удалось загрузить форму',
  settings: 'Не удалось загрузить настройки',
};

function Router() {
  const initial = useMemo(resolveInitialRoute, []);
  const [route, setRoute] = useState<Route>(initial);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [moves, setMoves] = useState(0);
  const dirty = useRef(false);
  const [leaveTo, setLeaveTo] = useState<Route | null>(null);

  // Приводим адресную строку к выбранному маршруту, не создавая лишнюю запись в истории.
  useEffect(() => {
    const hash = routeToHash(initial);
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }, [initial]);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash) ?? { name: 'new' });
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);


  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  /** Переход по панели и кнопкам экранов: с несохранённой формы сначала спрашиваем (§5.2, BottomSheet). */
  const navigate = useCallback(
    (next: Route) => {
      if (routeToHash(next) === window.location.hash) return;
      if (dirty.current) {
        setLeaveTo(next);
        return;
      }
      goTo(next);
    },
    [],
  );

  const parent = parentOf(route, initial);
  const parentHash = parent ? routeToHash(parent) : null;
  useEffect(() => {
    if (!parent) {
      backButton.hide();
      return;
    }
    // Через navigate, а не goTo: с несохранённой формы системная «Назад» тоже спрашивает (§5.2).
    const onBack = () => navigate(parent);
    backButton.onClick(onBack);
    backButton.show();
    return () => {
      backButton.offClick(onBack);
      backButton.hide();
    };
    // parent пересоздаётся на каждый рендер, поэтому зависимость по его адресу
  }, [parentHash, navigate]);

  const countMoves = useCallback((items: DealListItem[]) => {
    const now = new Date();
    setMoves(items.filter((item) => !(item.role === 'client' && item.demo) && needsMove(item, now)).length);
  }, []);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [me, templates] = await Promise.all([api.me(), api.templates()]);
      setState({ status: 'ready', data: { me, templates: templates.items } });
      // Счётчик на «Сделках» грузим в фоне: без него приложение работает, ошибку не показываем.
      api
        .deals({ role: 'all', filter: 'active' })
        .then((response) => countMoves(response.items))
        .catch(() => undefined);
    } catch (error) {
      if (error instanceof ApiError && error.isAuth) {
        setState({ status: 'unauthorized' });
        return;
      }
      setState({ status: 'error', message: errorText(error) });
    }
  }, [countMoves]);

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

  const tabBar = (
    <TabBar
      active={tabOf(route)}
      dealsCounter={moves}
      onSelect={(tab) => navigate(tab === 'new' ? { name: 'new' } : { name: tab })}
    />
  );

  let content: ReactNode;
  if (state.status === 'loading') {
    content = (
      <Screen>
        <AppHeader title={LOADING_TITLE[route.name]} />
        <Skeleton kind={route.name === 'deals' ? 'list' : route.name === 'done' ? 'card' : 'form'} />
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
    const { me, templates } = state.data;
    content = renderRoute(route, me, templates, { navigate, updateProfile, countMoves });
  }

  return (
    <FormDirtyContext.Provider value={setDirty}>
      <div className="dg-shell">
        {content}
        {tabBar}
      </div>
      <BottomSheet
        open={leaveTo !== null}
        title="Уйти без сохранения?"
        text="Введённые условия не сохранятся, форму придётся заполнить заново."
        confirmLabel="Уйти без сохранения"
        cancelLabel="Остаться"
        onCancel={() => setLeaveTo(null)}
        onConfirm={() => {
          const next = leaveTo;
          dirty.current = false;
          setLeaveTo(null);
          if (next) goTo(next);
        }}
      />
    </FormDirtyContext.Provider>
  );
}

interface RouteActions {
  navigate: (route: Route) => void;
  updateProfile: (profile: SellerProfile) => void;
  countMoves: (items: DealListItem[]) => void;
}

function renderRoute(route: Route, me: MeResponse, templates: Template[], a: RouteActions) {
  if (route.name === 'deals') {
    return (
      <DealsScreen
        me={me}
        onNewDeal={() => a.navigate({ name: 'new' })}
        onEdit={(id) => a.navigate({ name: 'edit', id })}
        onRepeat={(id) => a.navigate({ name: 'new', from: id })}
        onLoaded={a.countMoves}
      />
    );
  }

  if (route.name === 'edit') {
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
  }

  if (route.name === 'settings') return <SettingsScreen me={me} onSaved={a.updateProfile} />;

  if (route.name === 'done') {
    return <DoneScreen key={route.id} publicId={route.id} me={me} result={recallDone(route.id)} onDeals={() => a.navigate({ name: 'deals' })} />;
  }

  async function createDeal(payload: CreateDealRequest): Promise<void> {
    const result = await api.createDeal(payload);
    haptic('success');
    rememberDone(result);
    // Профиль сохранён вместе со сделкой: без этого следующая «Новая сделка» снова покажет пустой блок «О вас».
    if (payload.profile) a.updateProfile(payload.profile);
    goTo({ name: 'done', id: result.deal.public_id });
  }

  if (route.from) {
    return (
      <RepeatDealScreen
        key={route.from}
        publicId={route.from}
        me={me}
        templates={templates}
        onSubmit={createDeal}
        onNewDeal={() => a.navigate({ name: 'new' })}
        onDeals={() => a.navigate({ name: 'deals' })}
      />
    );
  }

  return <NewScreen me={me} templates={templates} onSubmit={createDeal} />;
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
