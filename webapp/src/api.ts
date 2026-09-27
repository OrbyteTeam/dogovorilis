// Клиент внутреннего API мини-приложения — docs/SPEC.md §7.8 (контракт, коды ошибок) и §7.1 (авторизация по initData).
import { DEV_NO_BRIDGE, initData, insideMax } from './bridge';
import type {
  CreateDealRequest,
  CreateDealResponse,
  DealsFilter,
  DealsResponse,
  DealsRole,
  MeResponse,
  ProfileResponse,
  SellerProfile,
  TemplatesResponse,
} from './types';

const BASE = '/api';
const TIMEOUT_MS = 10_000;

/** Заглушка API для визуальной проверки без сервера; в прод-бандл не попадает (см. mock/api-mock.ts). */
const USE_MOCK = import.meta.env.DEV && import.meta.env.VITE_MOCK_API === '1';

export type ApiErrorCode =
  | 'validation'
  | 'init_data_invalid'
  | 'forbidden'
  | 'not_found'
  | 'invalid_transition'
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

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  if (USE_MOCK) {
    const { mockRequest } = await import('./mock/api-mock');
    return mockRequest<T>(method, path, body);
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...authHeaders(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    throw aborted ? new ApiError(0, 'timeout', TIMEOUT_MESSAGE) : new ApiError(0, 'network', NETWORK_MESSAGE);
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
};

/** initData не принят сервером, хотя мини-приложение открыто внутри MAX (истёк или подпись не сошлась) — ЗАДАЧА_04 D1. */
export const AUTH_FAILED_TEXT = 'Не удалось подтвердить вход через MAX. Закройте и откройте мини-приложение заново';

/** Текст для пользователя по любой ошибке запроса (DESIGN.md §5). */
export function errorText(error: unknown): string {
  if (error instanceof ApiError && error.isAuth && insideMax()) return AUTH_FAILED_TEXT;
  if (error instanceof ApiError) return error.message;
  if (DEV_NO_BRIDGE && error instanceof Error) return error.message;
  return 'Что-то пошло не так. Попробуйте ещё раз';
}
