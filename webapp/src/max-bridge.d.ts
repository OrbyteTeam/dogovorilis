// Типы window.WebApp по docs/CONTRACTS.md §4 и docs/MAX_API.md §3 (официальных .d.ts у MAX Bridge нет).
export {};

declare global {
  interface MaxInitDataUnsafe {
    query_id: string;
    auth_date: number;
    hash: string;
    ip?: string;
    user?: { id: number; first_name: string; last_name?: string | null; username?: string | null; language_code?: string; photo_url?: string | null };
    chat?: { id: number; type: 'DIALOG' | 'CHAT' | 'CHANNEL' };
    start_param?: string;
  }
  interface MaxWebApp {
    initData: string;
    initDataUnsafe: MaxInitDataUnsafe;
    platform: 'ios' | 'android' | 'desktop' | 'web';
    version: string;
    deviceName: string;
    requestContact(): Promise<{ phone: string; authDate: string; hash: string }>;
    openLink(url: string): void;
    openMaxLink(url: string): void;
    shareMaxContent(params: { text?: string; link?: string } | { mid: string; chatType: 'DIALOG' | 'CHAT' }): Promise<unknown>;
    openCodeReader(fileSelect?: boolean): Promise<string>;
    enableClosingConfirmation(): void;
    disableClosingConfirmation(): void;
    getViewportSize(): Promise<{ height: string; width: string }>;
    BackButton: { show(): void; hide(): void; isVisible: boolean; onClick(cb: () => void): void; offClick(cb: () => void): void };
    HapticFeedback?: {
      impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft', disableVibrationFallback?: boolean): Promise<unknown>;
      notificationOccurred(type: 'error' | 'success' | 'warning', disableVibrationFallback?: boolean): Promise<unknown>;
      selectionChanged(disableVibrationFallback?: boolean): Promise<unknown>;
    };
  }
  interface Window {
    WebApp?: MaxWebApp;
  }
}
