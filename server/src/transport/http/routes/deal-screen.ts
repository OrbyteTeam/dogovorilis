// Маршруты экрана сделки (ЗАДАЧА_08 B, SPEC §7.8–§7.9): GET /full, POST /actions, POST /receipt.
// Каждое действие — тот же доменный вызов, что у кнопки в чате, и та же доставка (publishOutcome): карточки обеих
// сторон правятся на месте, вторая сторона получает уведомление. Авторизация — общий хук /api (routes/api.ts).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { inTx } from '../../../db/pool.js';
import * as eventsRepo from '../../../db/repos/events.js';
import * as inputsRepo from '../../../db/repos/inputs.js';
import * as versionsRepo from '../../../db/repos/versions.js';
import { ForbiddenError, InvalidTransition, ValidationError } from '../../../errors.js';
import type { MaxGateway } from '../../../integrations/max/gateway.js';
import { log } from '../../../logger.js';
import * as texts from '../../../texts.js';
import { isTerminal, type DealBundle, type InputKind } from '../../../types.js';
import * as dealService from '../../../domain/deal/service.js';
import type { Actor, ServiceResult } from '../../../domain/deal/service.js';
import { canTransition } from '../../../domain/deal/state-machine.js';
import { cfg } from '../../../config.js';
import { syncCards } from '../../bot/cards.js';
import { otherTimeKeyboard } from '../../bot/keyboards.js';
import { deliver } from '../../bot/notify.js';
import { publishNewVersion, publishOutcome } from '../../bot/outcome.js';
import { renderAndSendReceipt } from '../../bot/receipt.js';
import { remindClientNow, remindNote } from '../../bot/remind.js';
import { checkedPublicId, fail, firstIssue, me, sendError } from '../common.js';
import { cardActions, dealFullView, SERVER_ACTIONS, type ServerAction } from '../deal-full.js';

export type DealScreenDeps = { max: MaxGateway | null };

/** Чек из мини-приложения — те же типы и размер, что в чате (SPEC §6.6): PDF, JPG, PNG до 20 МБ. */
export const CHEQUE_MAX_BYTES = 20 * 1024 * 1024;
const CHEQUE_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

const roleSchema = z.enum(['seller', 'client']);
const fullQuerySchema = z.object({ as: roleSchema.optional() });
const actionSchema = z.object({
  action: z.enum(SERVER_ACTIONS),
  as: roleSchema.optional(),
  version: z.number().int().min(1).optional(),
  text: z.string().optional(),
  reason: z.string().optional(),
  proposal_id: z.number().int().positive().optional(),
});
type ActionBody = z.infer<typeof actionSchema>;

/** Действия, у которых роль задана самим действием (как у кнопок в CODE_ROLE бота). Остальные — по `as`. */
const ACTION_ROLE: Partial<Record<ServerAction, 'seller' | 'client'>> = {
  confirm: 'client',
  request_changes: 'client',
  decline: 'client',
  accept: 'client',
  remarks: 'client',
  keep_as_is: 'seller',
  done: 'seller',
  fixed: 'seller',
  close_without_receipt: 'seller',
  remind_client: 'seller',
  accept_time: 'seller',
};

/**
 * Чьими глазами смотреть и от чьего имени действовать. Без `as` — исполнитель, если он исполнитель, иначе клиент.
 * `as` можно, только если у пользователя эта роль в сделке (в демо у исполнителя — обе). Иначе 403.
 */
function resolveRole(bundle: DealBundle, userId: number, wanted?: 'seller' | 'client'): 'seller' | 'client' {
  const roles = dealService.participantRole(bundle.deal, userId);
  if (roles.length === 0) throw new ForbiddenError('not_participant');
  if (wanted) {
    if (!roles.includes(wanted)) throw new ForbiddenError(`роль ${wanted} недоступна`);
    return wanted;
  }
  return roles.includes('seller') ? 'seller' : 'client';
}

async function fullOf(bundle: DealBundle, role: 'seller' | 'client', viewerId: number) {
  const { versions, events } = await inTx(async (c) => ({
    versions: await versionsRepo.listByDeal(c, bundle.deal.id),
    events: await eventsRepo.listByDeal(c, bundle.deal.id),
  }));
  return dealFullView({ bundle, role, viewerId, versions, events });
}

function textOf(body: ActionBody, max: number, message: string): string {
  const t = (body.text ?? '').trim();
  if (t.length < 1 || t.length > max) throw new ValidationError(message, 'text');
  return t;
}

/** Снять ожидание ввода в чате по этой сделке: действие уже сделано из приложения, следующая реплика — не ответ. */
async function clearPendingInput(userId: number, dealId: number, kinds: InputKind[]): Promise<void> {
  await inTx(async (c) => {
    for (const kind of kinds) await inputsRepo.clearIf(c, { userId, kind, dealId });
  });
}

type Executed = { result: ServiceResult | null; notice: string | null };

/** Одно действие: доменный вызов + доставка сторонам. Никакой своей логики переходов — только маршрутизация. */
async function execute(max: MaxGateway | null, bundle: DealBundle, actor: Actor, body: ActionBody): Promise<Executed> {
  const id = bundle.deal.publicId;
  const dealId = bundle.deal.id;
  let result: ServiceResult;
  let notice: string | null = null;

  switch (body.action) {
    case 'confirm':
      if (!body.version) throw new ValidationError('Нужен номер версии условий', 'version');
      result = await dealService.confirm(id, actor, undefined, body.version);
      break;
    case 'request_changes':
      result = await dealService.requestChanges(id, actor, textOf(body, 500, texts.API_TEXT_LENGTH));
      await clearPendingInput(actor.userId, dealId, ['change_request']);
      break;
    case 'remarks':
      result = await dealService.remarks(id, actor, textOf(body, 500, texts.API_TEXT_LENGTH));
      await clearPendingInput(actor.userId, dealId, ['remarks']);
      break;
    case 'decline':
      result = await dealService.decline(id, actor);
      break;
    case 'accept':
      result = await dealService.accept(id, actor);
      break;
    case 'cancel': {
      // Причина — только у исполнителя (N15 второй стороне), как в чате; у клиента поле не спрашивается.
      const reason = actor.role === 'seller' ? (body.reason ?? '').trim() : '';
      if (reason.length > 300) throw new ValidationError(texts.API_REASON_LENGTH, 'reason');
      result = await dealService.cancel(id, actor, reason || null);
      await clearPendingInput(actor.userId, dealId, ['cancel_reason']);
      break;
    }
    case 'keep_as_is':
      result = await dealService.keepAsIs(id, actor);
      break;
    case 'done':
      result = await dealService.markDone(id, actor);
      break;
    case 'fixed':
      result = await dealService.markFixed(id, actor);
      break;
    case 'close_without_receipt':
      result = await dealService.closeWithoutReceipt(id, actor);
      break;
    case 'refund_confirmed':
      result = await dealService.confirmRefund(id, actor);
      notice = actor.role === 'seller' ? texts.REFUND_SENT_ACK : texts.REFUND_RECEIVED_ACK;
      break;
    case 'remind_client': {
      // Не переход: доступно ровно там, где у карточки есть «Напомнить клиенту».
      if (!cardActions(bundle, 'seller').includes('remind_client')) {
        throw new InvalidTransition(bundle.deal.status, 'done', 'seller', 'forbidden');
      }
      const outcome = max ? await remindClientNow(max, bundle) : 'no_chat';
      return { result: null, notice: remindNote(outcome) };
    }
    case 'accept_time': {
      // Тот же путь, что кнопка «✅ Принять» в чате (handlers/deal.ts acceptTime), SPEC §7.10.
      const proposalId = body.proposal_id ?? bundle.timeProposal?.id;
      if (!proposalId) throw new InvalidTransition(bundle.deal.status, 'new_version', 'seller', 'forbidden');
      const outcome = await dealService.acceptTimeProposal(id, actor, proposalId, cfg().APP_TIMEZONE);
      if (outcome.kind === 'accepted') {
        if (max) await publishNewVersion(max, outcome.result, { sellerNote: false });
        return { result: outcome.result, notice: texts.TIME_ACCEPTED_ACK };
      }
      if (outcome.kind === 'taken') {
        if (max) {
          await syncCards(max, outcome.bundle);
          await deliver(max, outcome.bundle, {
            to: 'client',
            text: texts.TIME_TAKEN_CLIENT({ id, at: outcome.proposal.scheduledAt }),
            keyboard: otherTimeKeyboard(id),
          });
        }
        return { result: null, notice: texts.TIME_TAKEN_SELLER };
      }
      return { result: null, notice: texts.TIME_STALE };
    }
    case 'receipt_pdf':
      if (!isTerminal(bundle.deal.status)) return { result: null, notice: null };
      if (max) await renderAndSendReceipt(max, bundle, { onDemandFor: actor.userId });
      return { result: null, notice: texts.API_RECEIPT_SENT };
  }

  if (max) await publishOutcome(max, result);
  if (result.alreadyDone) notice = texts.API_ALREADY_DONE;
  return { result, notice };
}

/** Имя файла чека для истории (receipts.file_name): без путей и служебных символов, расширение по типу. */
export function chequeFileName(raw: string | undefined, publicId: string, ext: string): string {
  let name = '';
  try {
    name = raw ? decodeURIComponent(raw) : '';
  } catch {
    name = '';
  }
  name = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').trim().slice(0, 80);
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return `${base || `Чек_${publicId}`}.${ext}`;
}

/**
 * Имя файла, под которым чек загружается в MAX и приходит клиенту. Только латиница: SDK кладёт имя в заголовок
 * Content-Disposition, и кириллица там не проходит (так же названа квитанция — `Kvitanciya-<id>.pdf`, pdf.ts).
 */
export function chequeUploadName(publicId: string, ext: string): string {
  return `Chek-${publicId}.${ext}`;
}

export function registerDealScreenApi(app: FastifyInstance, deps: DealScreenDeps): void {
  app.get<{ Params: { publicId: string } }>('/api/deals/:publicId/full', async (req, reply) => {
    const user = me(req);
    const q = fullQuerySchema.safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'validation', firstIssue(q.error.issues));
    try {
      const bundle = await dealService.getBundle(checkedPublicId(req.params.publicId));
      const role = resolveRole(bundle, user.maxUserId, q.data.as);
      return await fullOf(bundle, role, user.maxUserId);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post<{ Params: { publicId: string } }>('/api/deals/:publicId/actions', async (req, reply) => {
    const user = me(req);
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'validation', firstIssue(parsed.error.issues));
    const body = parsed.data;
    try {
      const bundle = await dealService.getBundle(checkedPublicId(req.params.publicId));
      const fixedRole = ACTION_ROLE[body.action];
      if (fixedRole && body.as && body.as !== fixedRole) throw new ForbiddenError('действие другой роли');
      const role = resolveRole(bundle, user.maxUserId, fixedRole ?? body.as);
      if (body.action === 'receipt_pdf' && !isTerminal(bundle.deal.status)) {
        return fail(reply, 409, 'receipt_not_ready', texts.API_RECEIPT_NOT_READY);
      }
      const { result, notice } = await execute(deps.max, bundle, { userId: user.maxUserId, role }, body);
      const fresh = result?.bundle ?? (await dealService.getBundle(bundle.deal.publicId));
      return {
        deal: await fullOf(fresh, role, user.maxUserId),
        result: result?.alreadyDone ? 'already_done' : 'done',
        notice,
      };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Чек файлом (T15): тело запроса — сам файл. Свой парсер и лимит только у этого маршрута, остальной /api — JSON до 1 МБ.
  app.register(async (scope) => {
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: CHEQUE_MAX_BYTES }, (_req, body, done) => done(null, body));
    scope.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
      if (err.statusCode === 413) return reply.code(413).send({ error: { code: 'file_too_large', message: texts.API_CHEQUE_TOO_LARGE } });
      if (err.statusCode && err.statusCode < 500) return reply.code(400).send({ error: { code: 'validation', message: texts.API_CHEQUE_TYPE } });
      log.error({ err: err.message }, 'API: ошибка приёма чека');
      return reply.code(500).send({ error: { code: 'internal', message: 'Внутренняя ошибка, попробуйте позже' } });
    });

    scope.post<{ Params: { publicId: string } }>(
      '/api/deals/:publicId/receipt',
      { bodyLimit: CHEQUE_MAX_BYTES },
      async (req, reply) => uploadCheque(deps.max, req.params.publicId, me(req).maxUserId, req.headers, req.body, reply),
    );
  });
}

async function uploadCheque(
  max: MaxGateway | null,
  rawPublicId: string,
  userId: number,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
  reply: FastifyReply,
) {
  try {
    const bundle = await dealService.getBundle(checkedPublicId(rawPublicId));
    const roles = dealService.participantRole(bundle.deal, userId);
    if (!roles.includes('seller')) throw new ForbiddenError('чек прикладывает исполнитель');
    // Статус проверяем до загрузки в MAX: незачем грузить файл, который сделка уже не примет.
    const verdict = canTransition(
      { status: bundle.deal.status, prepaymentKopecks: 0, totalKopecks: 0, paidKopecks: 0, taxMode: 'npd', clientJoined: true },
      'attach_receipt',
      'seller',
    );
    if (!verdict.ok) throw new InvalidTransition(bundle.deal.status, 'attach_receipt', 'seller', verdict.reason);

    const type = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const ext = CHEQUE_TYPES[type];
    if (!ext || !Buffer.isBuffer(body) || body.length === 0) return fail(reply, 400, 'validation', texts.API_CHEQUE_TYPE);
    if (!max) return fail(reply, 503, 'unavailable', texts.API_UPLOAD_FAILED);

    const rawName = headers['x-file-name'];
    const fileName = chequeFileName(Array.isArray(rawName) ? rawName[0] : rawName, bundle.deal.publicId, ext);
    // MAX показывает получателю имя файла по пути загрузки (CONTRACTS §1.8) — поэтому отдельный каталог и это имя.
    const dir = await mkdtemp(path.join(tmpdir(), 'dogovorilis-cheque-'));
    let token: string;
    try {
      const filePath = path.join(dir, chequeUploadName(bundle.deal.publicId, ext));
      await writeFile(filePath, body);
      const attachment = (await max.uploadFile(filePath)) as { payload?: { token?: string } };
      token = attachment.payload?.token ?? '';
    } catch (e) {
      log.warn({ deal: bundle.deal.publicId, err: (e as Error).message }, 'чек из мини-приложения не загрузился в MAX');
      return fail(reply, 502, 'upload_failed', texts.API_UPLOAD_FAILED);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!token) return fail(reply, 502, 'upload_failed', texts.API_UPLOAD_FAILED);

    const actor: Actor = { userId, role: 'seller' };
    const result = await dealService.attachReceipt({
      publicId: bundle.deal.publicId,
      actor,
      attachmentType: 'file',
      maxToken: token,
      maxUrl: null,
      fileName,
    });
    await inTx((c) => inputsRepo.clearIf(c, { userId, kind: 'receipt', dealId: bundle.deal.id }));
    await publishOutcome(max, result); // карточки, чек клиенту, N14 и квитанция PDF (T15)
    log.info({ deal: bundle.deal.publicId }, 'чек приложен из мини-приложения, сделка закрыта');
    return { deal: await fullOf(result.bundle, 'seller', userId), notice: texts.API_CHEQUE_ACCEPTED };
  } catch (e) {
    return sendError(reply, e);
  }
}
