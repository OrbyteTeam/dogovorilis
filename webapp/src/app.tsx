// Каркас мини-приложения: hash-роутинг, разбор start_param, загрузка /api/me и /api/templates,
// состояния экранов и BackButton — docs/SPEC.md §7.1, §13; docs/DESIGN.md §5.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, ApiError, errorText } from './api';
import { backButton, DEV_NO_BRIDGE, isAvailable, startParam } from './bridge';
import { BridgeMissingScreen, ErrorScreen, LoadingScreen } from './components/StateScreen';
import { ToastProvider, useToast } from './components/Toast';
import { DoneScreen } from './screens/Done';
import { NewScreen } from './screens/New';
import type { CreateDealResponse, MeResponse, Template } from './types';

type Route = { name: 'new' } | { name: 'done'; id: string };

/** Формат public_id — SPEC §13: `^d_[A-Za-z0-9]{10}$`. */
const DEEPLINK_RE = /^d_([A-Za-z0-9]{10})$/;
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

function parseHash(hash: string): Route | null {
  const path = hash.replace(/^#/, '');
  if (path === '/new') return { name: 'new' };
  const done = /^\/done\/([A-Za-z0-9]{1,32})$/.exec(path);
  if (done) return { name: 'done', id: done[1] };
  return null;
}

function routeToHash(route: Route): string {
  return route.name === 'done' ? `#/done/${route.id}` : '#/new';
}

/**
 * Старт по `start_param` (SPEC §7.1, §13): `new` → форма, `d_<id>` → экран «Готово» с ссылкой,
 * `deals`/`settings` → форма с тостом (эти экраны появятся в ЗАДАЧА_04).
 */
function resolveInitialRoute(): { route: Route; notice: string | null } {
  const fromHash = parseHash(window.location.hash);
  if (fromHash) return { route: fromHash, notice: null };

  const param = (startParam() ?? '').trim();
  const deeplink = DEEPLINK_RE.exec(param);
  if (deeplink) return { route: { name: 'done', id: deeplink[1] }, notice: null };
  if (param === 'deals' || param === 'settings') {
    return { route: { name: 'new' }, notice: 'Список и настройки появятся позже' };
  }
  return { route: { name: 'new' }, notice: null };
}

function navigate(route: Route): void {
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

function Router() {
  const showToast = useToast();
  const initial = useMemo(resolveInitialRoute, []);
  const [route, setRoute] = useState<Route>(initial.route);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  // Приводим адресную строку к выбранному маршруту, не создавая лишнюю запись в истории.
  useEffect(() => {
    const hash = routeToHash(initial.route);
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }, [initial.route]);

  useEffect(() => {
    if (initial.notice) showToast(initial.notice);
  }, [initial.notice, showToast]);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash) ?? { name: 'new' });
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // BackButton — на всех экранах, кроме корневого #/new (SPEC §7.1).
  useEffect(() => {
    if (route.name === 'new') {
      backButton.hide();
      return;
    }
    const onBack = () => navigate({ name: 'new' });
    backButton.onClick(onBack);
    backButton.show();
    return () => {
      backButton.offClick(onBack);
      backButton.hide();
    };
  }, [route.name]);

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

  if (state.status === 'loading') return <LoadingScreen />;
  if (state.status === 'unauthorized') return <BridgeMissingScreen />;
  if (state.status === 'error') return <ErrorScreen message={state.message} onRetry={() => void load()} />;

  if (route.name === 'done') {
    return (
      <DoneScreen
        publicId={route.id}
        me={state.data.me}
        result={recallDone(route.id)}
        onNewDeal={() => navigate({ name: 'new' })}
      />
    );
  }

  return (
    <NewScreen
      me={state.data.me}
      templates={state.data.templates}
      onCreated={(result) => {
        rememberDone(result);
        navigate({ name: 'done', id: result.deal.public_id });
      }}
    />
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
