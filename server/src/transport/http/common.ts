// Общее для маршрутов /api: кто запрашивает, формат ошибок { error: { code, message } } (SPEC §7.8), проверка public_id.
// Вынесено из routes/api.ts, когда появились маршруты экрана сделки (ЗАДАЧА_08 B): ошибки везде одинаковые.
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  DealNotEditableError,
  InvalidTransition,
  UnauthorizedError,
  ValidationError,
  VersionMismatchError,
} from '../../errors.js';
import { log } from '../../logger.js';
import * as texts from '../../texts.js';
import type { DealBundle, User } from '../../types.js';
import { PUBLIC_ID_RE } from '../../domain/ids.js';
import * as dealService from '../../domain/deal/service.js';
import { NotFoundError, ForbiddenError } from '../../errors.js';

export type AuthedRequest = FastifyRequest & { appUser?: User };

/** Пользователь, проверенный хуком авторизации (routes/api.ts). Без него маршрут /api не выполняется. */
export function me(req: FastifyRequest): User {
  const user = (req as AuthedRequest).appUser;
  if (!user) throw new UnauthorizedError('запрос без проверенного пользователя');
  return user;
}

export function firstIssue(issues: { message: string; path: (string | number | symbol)[] }[]): string {
  const i = issues[0];
  return i ? i.message : 'Проверьте заполнение полей';
}

export function fail(reply: FastifyReply, status: number, code: string, message: string, extra?: Record<string, unknown>) {
  reply.code(status);
  return { error: { code, message, ...extra } };
}

/** public_id не того вида — такой сделки нет (404), в БД не ходим. */
export function checkedPublicId(publicId: string): string {
  if (!PUBLIC_ID_RE.test(publicId)) throw new NotFoundError(`сделка ${publicId}`);
  return publicId;
}

/** Роль смотрящего; в демо он и исполнитель, и клиент — главная роль исполнителя. Посторонний — 403. */
export function viewerRole(bundle: DealBundle, userId: number): 'seller' | 'client' {
  const roles = dealService.participantRole(bundle.deal, userId);
  if (roles.includes('seller')) return 'seller';
  if (roles.includes('client')) return 'client';
  throw new ForbiddenError('not_participant');
}

/** Ошибка домена → HTTP по таблице SPEC §7.8. Неизвестное — 500 без подробностей наружу. */
export function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof UnauthorizedError) return fail(reply, 401, e.code, 'Откройте мини-приложение внутри MAX');
  if (e instanceof ValidationError) return fail(reply, 400, 'validation', e.message);
  if (e instanceof DealNotEditableError) return fail(reply, 409, e.code, texts.API_NOT_EDITABLE, { status: e.status });
  if (e instanceof VersionMismatchError) return fail(reply, 409, 'version_mismatch', texts.API_VERSION_MISMATCH);
  if (e instanceof InvalidTransition) {
    if (e.reason === 'client_cancel_locked') return fail(reply, 409, 'client_cancel_locked', texts.E7);
    return fail(reply, 409, 'invalid_transition', texts.API_INVALID_TRANSITION, { status: e.status });
  }
  if (e instanceof AppError) {
    switch (e.code) {
      case 'forbidden':
        return fail(reply, 403, 'forbidden', texts.API_FORBIDDEN_DEAL);
      case 'deal_not_found':
        return fail(reply, 404, 'not_found', texts.API_DEAL_NOT_FOUND);
      case 'no_changes':
        return fail(reply, 409, 'no_changes', texts.API_NO_CHANGES);
      default:
        break;
    }
    log.error({ err: e.message, code: e.code }, 'API: ошибка домена');
    return fail(reply, 500, 'internal', 'Внутренняя ошибка, попробуйте позже');
  }
  log.error({ err: (e as Error).message }, 'API: необработанная ошибка');
  return fail(reply, 500, 'internal', 'Внутренняя ошибка, попробуйте позже');
}
