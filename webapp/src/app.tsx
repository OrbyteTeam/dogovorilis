// Каркас мини-приложения: hash-роутинг, разбор start_param, загрузка /api/me и /api/templates,
// состояния экранов и BackButton — docs/SPEC.md §7.1, §13; docs/DESIGN.md §5.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, ApiError, errorText } from './api';
import { backButton, DEV_NO_BRIDGE, haptic, insideMax, isAvailable, startParam } from './bridge';
import { AuthFailedScreen, BridgeMissingScreen, ErrorScreen, LoadingScreen } from './components/StateScreen';
import { ToastProvider, useToast } from './components/Toast';
import { DealsScreen } from './screens/Deals';
import { DoneScreen } from './screens/Done';
import { EditDealScreen } from './screens/EditDeal';
import { RepeatDealScreen } from './screens/RepeatDeal';
import { NewScreen } from './screens/New';
import { SettingsScreen } from './screens/Settings';
import type { CreateDealRequest, CreateDealResponse, MeResponse, SellerProfile, Template } from './types';

type Route =
  /** `from` — «Повторить сделку»: форма с условиями прежней сделки (`#/new?from=<id>`). */
  | { name: 'new'; from?: string }
  | { name: 'done'; id: string }
  | { name: 'deals' }
  | { name: 'edit'; id: string }
  | { name: 'settings' };

/** Формат public_id — SPEC §13: `^d_[A-Za-z0-9]{10}$`. */
const DEEPLINK_RE = /^d_([A-Za-z0-9]{10})$/;
/** Правка условий из карточки бота: `edit_<id>` → `#/deals/<id>/edit` (ЗАДАЧА_04 E). */
const EDIT_PARAM_RE = /^edit_([A-Za-z0-9]{10})$/;
const EDIT_HASH_RE = /^\/deals\/([A-Za-z0-9]{10})\/edit$/;
/** «Повторить» из карточки бота: `repeat_<id>` → `#/new?from=<id>` (ЗАДАЧА_04 F). */
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
 * Старт по `start_param` (SPEC §7.1, §13): `new` → форма, `d_<id>` → экран «Готово» с ссылкой,
 * `deals` → список сделок (§7.4), `settings` → профиль (§7.7), `edit_<id>` → правка условий, `repeat_<id>` → повтор (§7.5).
 */
function resolveInitialRoute(): { route: Route; notice: string | null } {
  const fromHash = parseHash(window.location.hash);
  if (fromHash) return { route: fromHash, notice: null };

  const param = (startParam() ?? '').trim();
  const deeplink = DEEPLINK_RE.exec(param);
  if (deeplink) return { route: { name: 'done', id: deeplink[1] }, notice: null };
  const edit = EDIT_PARAM_RE.exec(param);
  if (edit) return { route: { name: 'edit', id: edit[1] }, notice: null };
  const repeat = REPEAT_PARAM_RE.exec(param);
  if (repeat) return { route: { name: 'new', from: repeat[1] }, notice: null };
  if (param === 'deals') return { route: { name: 'deals' }, notice: null };
  if (param === 'settings') return { route: { name: 'settings' }, notice: null };
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

  // BackButton — на всех экранах, кроме корневого #/new (SPEC §7.1). С правки и повтора — в «Мои сделки», откуда пришли.
  const isRoot = route.name === 'new' && !route.from;
  const backToDeals = route.name === 'edit' || (route.name === 'new' && Boolean(route.from));
  useEffect(() => {
    if (isRoot) {
      backButton.hide();
      return;
    }
    const onBack = () => navigate(backToDeals ? { name: 'deals' } : { name: 'new' });
    backButton.onClick(onBack);
    backButton.show();
    return () => {
      backButton.offClick(onBack);
      backButton.hide();
    };
  }, [isRoot, backToDeals]);

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
  // 401: вне MAX — экран W0; внутри MAX (initData есть, но не принят) — «закройте и откройте заново» + «Повторить».
  if (state.status === 'unauthorized') {
    return insideMax() ? <AuthFailedScreen onRetry={() => void load()} /> : <BridgeMissingScreen />;
  }
  if (state.status === 'error') return <ErrorScreen message={state.message} onRetry={() => void load()} />;

  if (route.name === 'deals') {
    return (
      <DealsScreen
        me={state.data.me}
        onNewDeal={() => navigate({ name: 'new' })}
        onEdit={(id) => navigate({ name: 'edit', id })}
        onRepeat={(id) => navigate({ name: 'new', from: id })}
      />
    );
  }

  if (route.name === 'edit') {
    return (
      <EditDealScreen
        key={route.id}
        publicId={route.id}
        me={state.data.me}
        templates={state.data.templates}
        onDeals={() => navigate({ name: 'deals' })}
        onRepeat={(id) => navigate({ name: 'new', from: id })}
      />
    );
  }

  if (route.name === 'settings') {
    return (
      <SettingsScreen
        me={state.data.me}
        onSaved={(profile: SellerProfile) =>
          setState((prev) =>
            prev.status === 'ready'
              ? { ...prev, data: { ...prev.data, me: { ...prev.data.me, profile } } }
              : prev,
          )
        }
      />
    );
  }

  if (route.name === 'done') {
    return (
      <DoneScreen
        publicId={route.id}
        me={state.data.me}
        result={recallDone(route.id)}
        onNewDeal={() => navigate({ name: 'new' })}
        onDeals={() => navigate({ name: 'deals' })}
      />
    );
  }

  async function createDeal(payload: CreateDealRequest): Promise<void> {
    const result = await api.createDeal(payload);
    haptic('success');
    rememberDone(result);
    // Профиль сохранён вместе со сделкой: без этого «Создать ещё одну» снова покажет пустой блок «О вас».
    const savedProfile = payload.profile;
    if (savedProfile) {
      setState((prev) =>
        prev.status === 'ready'
          ? { ...prev, data: { ...prev.data, me: { ...prev.data.me, profile: savedProfile } } }
          : prev,
      );
    }
    navigate({ name: 'done', id: result.deal.public_id });
  }

  if (route.from) {
    return (
      <RepeatDealScreen
        key={route.from}
        publicId={route.from}
        me={state.data.me}
        templates={state.data.templates}
        onSubmit={createDeal}
        onNewDeal={() => navigate({ name: 'new' })}
        onDeals={() => navigate({ name: 'deals' })}
      />
    );
  }

  return <NewScreen me={state.data.me} templates={state.data.templates} onSubmit={createDeal} />;
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
