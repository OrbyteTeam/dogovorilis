// Каркас мини-приложения: экран по стеку истории (nav.ts), загрузка /api/me и /api/templates, состояния экранов,
// BackButton и нижняя панель разделов — docs/SPEC.md §7.1, §13; docs/DESIGN.md §5; ЗАДАЧА_08 A.
import { useCallback, useEffect, useState } from 'react';

import { api, ApiError, errorText } from './api';
import { backButton, DEV_NO_BRIDGE, haptic, insideMax, isAvailable, startParam } from './bridge';
import { AuthFailedScreen, BridgeMissingScreen, ErrorScreen, LoadingScreen } from './components/StateScreen';
import { TabBar } from './components/TabBar';
import { ToastProvider } from './components/Toast';
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
import { RepeatDealScreen } from './screens/RepeatDeal';
import { NewScreen } from './screens/New';
import { ServiceFormScreen } from './screens/ServiceForm';
import { ServicesScreen } from './screens/Services';
import { SettingsScreen } from './screens/Settings';
import type { CreateDealRequest, CreateDealResponse, MeResponse, SellerProfile, Template } from './types';

const DONE_STORAGE_PREFIX = 'dogovorilis:done:';

/** Кэш результата создания на время сессии: sessionStorage в MAX WebView может быть недоступен. */
const doneCache = new Map<string, CreateDealResponse>();

function rememberDone(result: CreateDealResponse): void {
  doneCache.set(result.deal.public_id, result);
  try {
    window.sessionStorage.setItem(`${DONE_STORAGE_PREFIX}${result.deal.public_id}`, JSON.stringify(result));
  } catch {
    /* приватный режим или запрет хранилища — остаётся кэш в памяти */
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

function Router() {
  const [history, setHistory] = useState<History>(() => startHistory(initialRoute(window.location.hash, startParam())));
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const route = current(history);

  const navigate = useCallback((to: Route, opts?: { replace?: boolean }) => setHistory((h) => push(h, to, opts)), []);
  const goBack = useCallback(() => setHistory(back), []);

  useEffect(() => syncHash(route), [route]);

  // Ручная правка адреса (разработка в браузере) — как обычный переход.
  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHash(window.location.hash);
      if (parsed) navigate(parsed);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [navigate]);

  // BackButton MAX ведёт по истории внутри приложения; на корневом экране (с которого открыли мини-приложение)
  // кнопки нет — «назад» закрывает приложение средствами MAX (SPEC §7.1, ЗАДАЧА_08 A).
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

  // Экран сменился — наверх: иначе новый экран открывается с прокруткой прежнего.
  const routeHash = routeToHash(route);
  useEffect(() => {
    try {
      window.scrollTo(0, 0);
    } catch {
      /* нет окна — нечего прокручивать */
    }
  }, [routeHash]);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [me, templates] = await Promise.all([api.me(), api.templates()]);
      setState({ status: 'ready', data: { me, templates: templates.items } });
    } catch (error) {
      if (error instanceof ApiError && error.isAuth) {
        setState({ status: 'unauthorized' });
        return;
      }
      setState({ status: 'error', message: errorText(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // До ответа /api/me панели нет: без входа любой раздел покажет тот же экран загрузки или ошибки.
  if (state.status === 'loading') return <LoadingScreen />;
  // 401: вне MAX — экран W0; внутри MAX (initData есть, но не принят) — «закройте и откройте заново» + «Повторить».
  if (state.status === 'unauthorized') {
    return insideMax() ? <AuthFailedScreen onRetry={() => void load()} /> : <BridgeMissingScreen />;
  }
  if (state.status === 'error') return <ErrorScreen message={state.message} onRetry={() => void load()} />;

  const data = state.data;

  function setProfile(profile: SellerProfile): void {
    setState((prev) =>
      prev.status === 'ready' ? { ...prev, data: { ...prev.data, me: { ...prev.data.me, profile } } } : prev,
    );
  }

  async function createDeal(payload: CreateDealRequest): Promise<void> {
    const result = await api.createDeal(payload);
    haptic('success');
    rememberDone(result);
    // Профиль сохранён вместе со сделкой: без этого «Создать ещё одну» снова покажет пустой блок «О вас».
    if (payload.profile) setProfile(payload.profile);
    // «Готово» заменяет форму: «назад» с него не должен возвращать к уже отправленной форме.
    navigate({ name: 'done', id: result.deal.public_id }, { replace: true });
  }

  function screen() {
    switch (route.name) {
      case 'deals':
        return (
          <DealsScreen
            me={data.me}
            onNewDeal={() => navigate({ name: 'new' })}
            onOpen={(id) => navigate({ name: 'deal', id })}
            onEdit={(id) => navigate({ name: 'edit', id })}
            onRepeat={(id) => navigate({ name: 'new', from: id })}
          />
        );
      case 'edit':
        return (
          <EditDealScreen
            key={route.id}
            publicId={route.id}
            me={data.me}
            templates={data.templates}
            onDeals={() => navigate({ name: 'deals' })}
            onRepeat={(id) => navigate({ name: 'new', from: id })}
          />
        );
      case 'deal':
        return (
          <DealScreen
            key={route.id}
            publicId={route.id}
            me={data.me}
            onEdit={(id) => navigate({ name: 'edit', id })}
            onRepeat={(id) => navigate({ name: 'new', from: id })}
            onDeals={() => navigate({ name: 'deals' })}
          />
        );
      case 'settings':
        return <SettingsScreen me={data.me} onSaved={setProfile} onServices={() => navigate({ name: 'services' })} />;
      case 'services':
        return (
          <ServicesScreen
            templates={data.templates}
            onOpen={(id) => navigate({ name: 'service', id })}
            onNew={(template) => navigate(template ? { name: 'service', id: 'new', template } : { name: 'service', id: 'new' })}
            onSettings={() => navigate({ name: 'settings' })}
          />
        );
      case 'service':
        return (
          <ServiceFormScreen
            key={routeToHash(route)}
            id={route.id}
            template={route.template}
            me={data.me}
            templates={data.templates}
            // Сохранили — форма уступает место списку: «назад» с него не вернёт к отправленной форме.
            onDone={() => navigate({ name: 'services' }, { replace: true })}
          />
        );
      case 'done':
        return (
          <DoneScreen
            key={route.id}
            publicId={route.id}
            me={data.me}
            result={recallDone(route.id)}
            onNewDeal={() => navigate({ name: 'new' })}
            onDeals={() => navigate({ name: 'deals' })}
            onOpenDeal={() => navigate({ name: 'deal', id: route.id })}
          />
        );
      case 'new':
        return route.from ? (
          <RepeatDealScreen
            key={route.from}
            publicId={route.from}
            me={data.me}
            templates={data.templates}
            onSubmit={createDeal}
            onNewDeal={() => navigate({ name: 'new' })}
            onDeals={() => navigate({ name: 'deals' })}
          />
        ) : (
          <NewScreen me={data.me} templates={data.templates} onSubmit={createDeal} />
        );
    }
  }

  return (
    <>
      {screen()}
      <TabBar active={tabOf(route)} onSelect={(tab) => navigate(tabRoute(tab))} />
    </>
  );
}

export function App() {
  // Вне MAX работать нечем: initData нет, значит нет и авторизации (SPEC §7.1, экран W0).
  if (!isAvailable() && !DEV_NO_BRIDGE) return <BridgeMissingScreen />;
  return (
    <ToastProvider>
      <Router />
    </ToastProvider>
  );
}
