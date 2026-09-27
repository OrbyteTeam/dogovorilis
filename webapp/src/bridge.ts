// Тонкая обёртка над window.WebApp — docs/MAX_API.md §3, docs/SPEC.md §7.1. Каждый вызов в try/catch:
// отсутствие метода в конкретной версии клиента MAX не должно ломать экран.
import type { PlatformType } from '@maxhub/max-ui';

/** Режим разработки без Bridge: клиентская пара к DEV_FAKE_USER_ID на сервере (SPEC §7.1, §4.3). */
export const DEV_NO_BRIDGE: boolean =
  import.meta.env.DEV &&
  (import.meta.env.VITE_DEV_NO_BRIDGE === '1' || import.meta.env.VITE_MOCK_API === '1');

function webApp(): MaxWebApp | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.WebApp;
  } catch {
    return undefined;
  }
}

/**
 * Скрипт Bridge подключён в index.html и грузится в любом браузере: вне MAX объект `window.WebApp`
 * есть, но `initData` равен null, а `initDataUnsafe` пуст — проверено на st.max.ru 20.09.2026.
 * Поэтому «мы внутри MAX» = есть непустой initData (SPEC §7.1, экран W0).
 */
export function isAvailable(): boolean {
  return (initData()?.length ?? 0) > 0;
}

export function initData(): string | null {
  try {
    const raw = webApp()?.initData;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function startParam(): string | null {
  try {
    return webApp()?.initDataUnsafe?.start_param ?? null;
  } catch {
    return null;
  }
}

/** Имя пользователя из initDataUnsafe — только как подсказка для поля «Как вас подписать». */
export function userDisplayName(): string | null {
  try {
    const user = webApp()?.initDataUnsafe?.user;
    if (!user) return null;
    return [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || null;
  } catch {
    return null;
  }
}

/** MAX UI знает только ios/android; desktop и web показываем в ios-раскладке. */
export function platform(): PlatformType {
  try {
    return webApp()?.platform === 'android' ? 'android' : 'ios';
  } catch {
    return 'ios';
  }
}

export const backButton = {
  show(): void {
    try {
      webApp()?.BackButton?.show();
    } catch {
      /* метода нет — кнопкой «назад» остаётся системная */
    }
  },
  hide(): void {
    try {
      webApp()?.BackButton?.hide();
    } catch {
      /* см. выше */
    }
  },
  onClick(cb: () => void): void {
    try {
      webApp()?.BackButton?.onClick(cb);
    } catch {
      /* см. выше */
    }
  },
  offClick(cb: () => void): void {
    try {
      webApp()?.BackButton?.offClick(cb);
    } catch {
      /* см. выше */
    }
  },
};

export type HapticType = 'success' | 'error' | 'warning' | 'selection' | 'light' | 'medium' | 'heavy';

/** HapticFeedback есть только на мобильных клиентах — отсутствие не ошибка (DESIGN.md §5). */
export function haptic(type: HapticType): void {
  try {
    const hf = webApp()?.HapticFeedback;
    if (!hf) return;
    if (type === 'selection') void hf.selectionChanged()?.catch(() => {});
    else if (type === 'success' || type === 'error' || type === 'warning') {
      void hf.notificationOccurred(type)?.catch(() => {});
    } else void hf.impactOccurred(type)?.catch(() => {});
  } catch {
    /* глушим: вибрация не критична */
  }
}

export interface ShareDealParams {
  text: string;
  link: string;
}

export type ShareResult = 'shared' | 'fallback' | 'unavailable';

/**
 * Отправка карточки клиенту: сначала нативный экран MAX, при отказе — ссылка `:share`
 * (SPEC §7.3, MAX_API.md §1 п. 6). `text` — без ссылки: `shareMaxContent` получает её отдельным `link`,
 * а у `:share` есть только `text`, туда ссылка дописывается один раз (ЗАДАЧА_04 A1 — была дважды).
 */
export async function shareDeal({ text, link }: ShareDealParams): Promise<ShareResult> {
  const app = webApp();
  if (app?.shareMaxContent) {
    try {
      await app.shareMaxContent({ text, link });
      return 'shared';
    } catch {
      /* Bridge отверг вызов — идём в fallback */
    }
  }
  const shareUrl = `https://max.ru/:share?text=${encodeURIComponent(text.includes(link) ? text : `${text}\n${link}`)}`;
  try {
    if (app?.openLink) {
      app.openLink(shareUrl);
      return 'fallback';
    }
    window.open(shareUrl, '_blank', 'noopener');
    return 'fallback';
  } catch {
    return 'unavailable';
  }
}

/** Диплинк в чат с ботом: `openMaxLink` открывает его внутри MAX (SPEC §13). */
export function botLink(botUsername: string, payload?: string): string {
  const base = `https://max.ru/${botUsername}`;
  return payload ? `${base}?start=${payload}` : base;
}

export function openBot(botUsername: string, payload?: string): boolean {
  const url = botLink(botUsername, payload);
  const app = webApp();
  try {
    if (app?.openMaxLink) {
      app.openMaxLink(url);
      return true;
    }
    if (app?.openLink) {
      app.openLink(url);
      return true;
    }
    window.open(url, '_blank', 'noopener');
    return true;
  } catch {
    return false;
  }
}

export function enableClosingConfirmation(): void {
  try {
    webApp()?.enableClosingConfirmation();
  } catch {
    /* нет метода — подтверждение закрытия просто не появится */
  }
}

export function disableClosingConfirmation(): void {
  try {
    webApp()?.disableClosingConfirmation();
  } catch {
    /* см. выше */
  }
}

/** Копирование: сначала Clipboard API, затем скрытая textarea (в MAX WebView Clipboard API бывает запрещён). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* падаем в fallback */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
