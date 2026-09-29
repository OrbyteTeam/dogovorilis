// Клиент внутреннего API мини-приложения — docs/SPEC.md §7.8 (контракт, коды ошибок) и §7.1 (авторизация по initData).
import { DEV_NO_BRIDGE, initData, insideMax } from './bridge';
import type {
  CreateDealRequest,
  CreateDealResponse,
  DealActionRequest,
  DealActionResponse,
  DealDetails,
  DealFull,
  DealRole,
  DealsFilter,
  DealsResponse,
  DealsRole,
  MeResponse,
  ProfileResponse,
  ReceiptUploadResponse,
  SellerProfile,
  TemplatesResponse,
  UpdateDealRequest,
  UpdateDealResponse,
} from './types';

const BASE = '/api';
const TIMEOUT_MS = 10_000;
/** Файл чека до 20 МБ по мобильной сети за 10 с не уходит — у загрузки свой таймаут (ЗАДАЧА_08 B). */
const UPLOAD_TIMEOUT_MS = 60_000;

/** Заглушка API для визуальной проверки без сервера; в прод-бандл не попадает (см. mock/api-mock.ts). */
const USE_MOCK = import.meta.env.DEV && import.meta.env.VITE_MOCK_API === '1';

export type ApiErrorCode =
  | 'validation'
  | 'init_data_invalid'
  | 'forbidden'
  | 'not_found'
  | 'invalid_transition'
  // 409 экрана сделки (SPEC §7.8, §7.9): клиенту отмена закрыта после выполнения (E7), условия сменились под
  // «Подтверждаю», квитанция запрошена до завершения; правка условий (T5) — сделка уже не правится / ничего не изменилось.
  | 'client_cancel_locked'
  | 'version_mismatch'
  | 'receipt_not_ready'
  | 'deal_not_editable'
  | 'no_changes'
  // Чек: 413 — больше 20 МБ; 502 — MAX не принял файл; 503 — на сервере нет связи с MAX.
  | 'file_too_large'
  | 'upload_failed'
  | 'unavailable'
  | 'rate_limited'
  | 'internal'
  | 'network'
  | 'timeout'
  | 'bad_response';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;

  constructor(status: number, code: ApiErrorCode | string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** 401 — initData не принят: мини-приложение открыто вне MAX или срок initData истёк (SPEC §9.4). */
  get isAuth(): boolean {
    return this.status === 401 || this.code === 'init_data_invalid';
  }
}

const NETWORK_MESSAGE = 'Нет связи. Проверьте интернет и повторите';
const TIMEOUT_MESSAGE = 'Сервер не ответил за 10 секунд. Попробуйте ещё раз';
const UPLOAD_TIMEOUT_MESSAGE = 'Файл не загрузился за минуту. Проверьте интернет и попробуйте ещё раз';

function authHeaders(): Record<string, string> {
  const raw = initData();
  // В development без Bridge заголовок не отправляем — сервер подставит DEV_FAKE_USER_ID (SPEC §7.1, §4.3).
  if (!raw) return {};
  return { 'X-Max-Init-Data': raw };
}

async function parseError(response: Response): Promise<ApiError> {
  let code = 'internal';
  let message = 'Что-то пошло не так. Попробуйте ещё раз';
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const err = (body as { error?: { code?: unknown; message?: unknown } }).error;
      if (typeof err?.code === 'string') code = err.code;
      if (typeof err?.message === 'string' && err.message.trim()) message = err.message;
    }
  } catch {
    /* тело не JSON — оставляем текст по умолчанию */
  }
  return new ApiError(response.status, code, message);
}

interface SendOptions {
  /** Тело как есть (файл чека), без JSON — заголовки задаёт вызывающий. */
  raw?: Blob;
  headers?: Record<string, string>;
  timeoutMs?: number;
  timeoutMessage?: string;
}

/** Один запрос к API: заголовок авторизации, таймаут, коды ошибок `{ error: { code, message } }` (SPEC §7.8). */
async function send<T>(method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, opts: SendOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  const json = opts.raw === undefined && body !== undefined;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
        ...authHeaders(),
      },
      body: opts.raw ?? (json ? JSON.stringify(body) : undefined),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    throw aborted
      ? new ApiError(0, 'timeout', opts.timeoutMessage ?? TIMEOUT_MESSAGE)
      : new ApiError(0, 'network', NETWORK_MESSAGE);
  } finally {
    window.clearTimeout(timer);
  }

  if (!response.ok) throw await parseError(response);

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, 'bad_response', 'Сервер вернул неожиданный ответ');
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  if (USE_MOCK) {
    const { mockRequest } = await import('./mock/api-mock');
    return mockRequest<T>(method, path, body);
  }
  return send<T>(method, path, body);
}

/**
 * Чек к сделке (T15): тело — сам файл, имя — в заголовке `X-File-Name` (URL-encoded), таймаут 60 с (SPEC §7.8).
 * Тип файла проверен до вызова (deal-screen.ts `checkReceiptFile`) и передаётся явно: у части Android WebView
 * `file.type` пустой, а сервер принимает только pdf/jpeg/png по Content-Type.
 */
async function uploadReceipt(publicId: string, file: File, contentType: string = file.type): Promise<ReceiptUploadResponse> {
  if (USE_MOCK) {
    const { mockUploadReceipt } = await import('./mock/api-mock');
    return mockUploadReceipt(publicId, file, contentType);
  }
  return send<ReceiptUploadResponse>('POST', `/deals/${encodeURIComponent(publicId)}/receipt`, undefined, {
    raw: file,
    headers: { 'Content-Type': contentType, 'X-File-Name': encodeURIComponent(file.name) },
    timeoutMs: UPLOAD_TIMEOUT_MS,
    timeoutMessage: UPLOAD_TIMEOUT_MESSAGE,
  });
}

export const get = <T>(path: string): Promise<T> => request<T>('GET', path);
export const put = <T>(path: string, body: unknown): Promise<T> => request<T>('PUT', path, body);
export const post = <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body);

/** Именованные методы контракта §7.8 — чтобы пути не расползались по экранам. */
export const api = {
  me: () => get<MeResponse>('/me'),
  templates: () => get<TemplatesResponse>('/templates'),
  saveProfile: (profile: SellerProfile) => put<ProfileResponse>('/me/profile', profile),
  createDeal: (deal: CreateDealRequest) => post<CreateDealResponse>('/deals', deal),
  deals: (q: { role: DealsRole; filter: DealsFilter }) =>
    get<DealsResponse>(`/deals?role=${q.role}&filter=${q.filter}`),
  deal: (publicId: string) => get<DealDetails>(`/deals/${encodeURIComponent(publicId)}`),
  updateDeal: (publicId: string, body: UpdateDealRequest) =>
    put<UpdateDealResponse>(`/deals/${encodeURIComponent(publicId)}`, body),
  /** Экран сделки (§7.9). `as=client` — демо «Как видит клиент»; без параметра сервер берёт роль смотрящего. */
  dealFull: (publicId: string, as?: DealRole) =>
    get<DealFull>(`/deals/${encodeURIComponent(publicId)}/full${as === 'client' ? '?as=client' : ''}`),
  dealAction: (publicId: string, body: DealActionRequest) =>
    post<DealActionResponse>(`/deals/${encodeURIComponent(publicId)}/actions`, body),
  uploadReceipt,
};

/**
 * Сбой, который имеет смысл просто повторить: сеть, таймаут, 5xx, а также 404/405 от сервера, где метода ещё нет
 * (мини-приложение выкатывается раньше сервера). Ошибки валидации сюда не входят — их исправляют в поле.
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status >= 500 || error.status === 404 || error.status === 405;
}

/** initData не принят сервером, хотя мини-приложение открыто внутри MAX (истёк или подпись не сошлась) — ЗАДАЧА_04 D1. */
export const AUTH_FAILED_TEXT = 'Не удалось подтвердить вход через MAX. Закройте и откройте мини-приложение заново';

/** Текст для пользователя по любой ошибке запроса (DESIGN.md §5). */
export function errorText(error: unknown): string {
  if (error instanceof ApiError && error.isAuth && insideMax()) return AUTH_FAILED_TEXT;
  if (error instanceof ApiError) return error.message;
  if (DEV_NO_BRIDGE && error instanceof Error) return error.message;
  return 'Что-то пошло не так. Попробуйте ещё раз';
}
