// Навигация мини-приложения: маршруты, разбор start_param и история переходов — docs/SPEC.md §7.1, §13.
// Модуль чистый (без React и без window): его покрывают unit-тесты webapp/test/nav.test.ts.
//
// История — свой стек, а не история браузера: кнопка «назад» MAX (BackButton) ведёт по стеку, а на корневом
// экране (с которого открыли мини-приложение) скрыта — тогда MAX закрывает приложение сам. Адресная строка
// только отражает текущий экран (replaceState), записи в истории WebView не копятся.

export type Route =
  /** `from` — «Повторить сделку»: форма с условиями прежней сделки (`#/new?from=<id>`). */
  | { name: 'new'; from?: string }
  | { name: 'done'; id: string }
  | { name: 'deals' }
  | { name: 'edit'; id: string }
  | { name: 'settings' };

/** Вкладки нижней панели (ЗАДАЧА_08 A). */
export type Tab = 'new' | 'deals' | 'settings';

export const TABS: readonly { tab: Tab; label: string }[] = [
  { tab: 'new', label: 'Новая' },
  { tab: 'deals', label: 'Сделки' },
  { tab: 'settings', label: 'Настройки' },
];

/** Формат public_id — SPEC §13: 10 символов `[A-Za-z0-9]`. */
const ID = '([A-Za-z0-9]{10})';
const DEEPLINK_RE = new RegExp(`^d_${ID}$`);
/** Правка условий из карточки бота: `edit_<id>` → `#/deals/<id>/edit` (ЗАДАЧА_04 E). */
const EDIT_PARAM_RE = new RegExp(`^edit_${ID}$`);
const EDIT_HASH_RE = new RegExp(`^/deals/${ID}/edit$`);
/** «Повторить» из карточки бота: `repeat_<id>` → `#/new?from=<id>` (ЗАДАЧА_04 F). */
const REPEAT_PARAM_RE = new RegExp(`^repeat_${ID}$`);
const REPEAT_HASH_RE = new RegExp(`^/new\\?from=${ID}$`);
const DONE_HASH_RE = /^\/done\/([A-Za-z0-9]{1,32})$/;

export function parseHash(hash: string): Route | null {
  const path = hash.replace(/^#/, '');
  if (path === '/new') return { name: 'new' };
  if (path === '/deals') return { name: 'deals' };
  if (path === '/settings') return { name: 'settings' };
  const repeat = REPEAT_HASH_RE.exec(path);
  if (repeat) return { name: 'new', from: repeat[1] };
  const edit = EDIT_HASH_RE.exec(path);
  if (edit) return { name: 'edit', id: edit[1] };
  const done = DONE_HASH_RE.exec(path);
  if (done) return { name: 'done', id: done[1] };
  return null;
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'done':
      return `#/done/${route.id}`;
    case 'deals':
      return '#/deals';
    case 'settings':
      return '#/settings';
    case 'edit':
      return `#/deals/${route.id}/edit`;
    case 'new':
      return route.from ? `#/new?from=${route.from}` : '#/new';
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return routeToHash(a) === routeToHash(b);
}

/**
 * Стартовый экран по `start_param` (SPEC §7.1, §13): `new` → форма, `d_<id>` → «Готово» с ссылкой,
 * `deals` → «Мои сделки», `settings` → настройки, `edit_<id>` → правка условий, `repeat_<id>` → повтор.
 * Непустой hash (перезагрузка WebView) главнее start_param; неизвестное — форма новой сделки.
 */
export function initialRoute(hash: string, startParam: string | null): Route {
  const fromHash = parseHash(hash);
  if (fromHash) return fromHash;
  const param = (startParam ?? '').trim();
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

/** Какая вкладка подсвечена на экране: всё про сделки (правка, повтор) — «Сделки», «Готово» — «Новая». */
export function tabOf(route: Route): Tab {
  switch (route.name) {
    case 'new':
      return route.from ? 'deals' : 'new';
    case 'done':
      return 'new';
    case 'deals':
    case 'edit':
      return 'deals';
    case 'settings':
      return 'settings';
  }
}

export function tabRoute(tab: Tab): Route {
  return { name: tab };
}

// ───────────────────────────── история ─────────────────────────────

/** Стек экранов: первый элемент — корень (с него «назад» закрывает мини-приложение), последний — текущий. */
export type History = readonly Route[];

/** Больше этого в стеке не держим: самые старые экраны после корня выбрасываются. */
export const HISTORY_LIMIT = 20;

export function startHistory(entry: Route): History {
  return [entry];
}

export function current(history: History): Route {
  return history[history.length - 1];
}

/** Есть куда возвращаться — показываем BackButton; нет — скрываем, и MAX закрывает приложение сам. */
export function canGoBack(history: History): boolean {
  return history.length > 1;
}

/**
 * Переход на экран. Экран уже есть в стеке — возвращаемся к нему, отрезая всё, что выше: так стек не растёт от
 * переключения вкладок туда-обратно, а «назад» не показывает один экран дважды. `replace` — заменить текущий
 * экран (после успешной отправки формы: «назад» с «Готово» не должен возвращать к заполненной форме).
 */
export function push(history: History, route: Route, opts: { replace?: boolean } = {}): History {
  const existing = history.findIndex((r) => sameRoute(r, route));
  if (existing >= 0) return history.slice(0, existing + 1);
  const base = opts.replace && history.length > 1 ? history.slice(0, -1) : opts.replace ? [] : history;
  const next = [...base, route];
  // Корень сохраняем всегда: иначе «назад» дошёл бы до экрана, с которого приложение не открывали.
  return next.length > HISTORY_LIMIT ? [next[0], ...next.slice(next.length - HISTORY_LIMIT + 1)] : next;
}

/** «Назад»: снять текущий экран. С корня не уходим — там кнопка скрыта. */
export function back(history: History): History {
  return history.length > 1 ? history.slice(0, -1) : history;
}
