// Сервис сделок: ЕДИНСТВЕННОЕ место, где меняется состояние сделки.
// Каждый переход — в транзакции с `SELECT … FOR UPDATE` строки deals (SPEC §5.2 «Конкурентность»),
// с записью события (§5.4) и пересозданием набора напоминаний (§10.1).
// Транспорт (бот, HTTP) не знает про SQL, а домен не знает про SDK MAX: сервис возвращает список
// добавленных событий, а какие уведомления N1–N15 из них следуют — решает transport/bot/notify.
import { ForbiddenError, InvalidTransition, NotFoundError, TrialLimitError, ValidationError } from '../../errors.js';
import { inTx, type DbClient } from '../../db/pool.js';
import * as cardsRepo from '../../db/repos/cards.js';
import * as dealsRepo from '../../db/repos/deals.js';
import * as eventsRepo from '../../db/repos/events.js';
import * as paymentsRepo from '../../db/repos/payments.js';
import * as receiptsRepo from '../../db/repos/receipts.js';
import * as remindersRepo from '../../db/repos/reminders.js';
import * as usersRepo from '../../db/repos/users.js';
import * as versionsRepo from '../../db/repos/versions.js';
import { log } from '../../logger.js';
import {
  isTerminal,
  paidTotal,
  type ActorRole,
  type CancelRule,
  type Deal,
  type DealAction,
  type DealBundle,
  type DealEvent,
  type DealStatus,
  type DealVersion,
  type Role,
  type TaxMode,
  type TemplateKey,
} from '../../types.js';
import { assertAmounts } from '../money.js';
import { addHours, addMinutes } from '../time.js';
import { newPublicId } from '../ids.js';
import { planReminders } from '../reminder/plan.js';
import { refundExpected } from './rules.js';
import { canTransition } from './state-machine.js';

/** Кто совершает действие. Роль приходит от транспорта (кнопка принадлежит роли), а не угадывается по id:
 *  в демо-режиме исполнитель и клиент — один и тот же пользователь (SPEC §12). */
export type Actor = { userId: number; role: Exclude<Role, 'system'> };
export const SYSTEM: Actor = { userId: 0, role: 'seller' }; // не используется как участник; см. systemActor()

export type ServiceResult = {
  bundle: DealBundle;
  previousStatus: DealStatus;
  statusChanged: boolean;
  /** Что произошло — по этим событиям транспорт выбирает уведомления. */
  events: DealEvent[];
  /** Действие уже было выполнено раньше: побочных эффектов нет, карточку надо просто перерисовать. */
  alreadyDone: boolean;
};

const CONFIRMATION_TTL_HOURS = 72; // SPEC §5.2 T1/T8
/** Статусы, в которых действует `deals.expires_at` — срок подтверждения (T8 истекает только из них). */
const AWAITING_CONFIRMATION: readonly DealStatus[] = ['awaiting_confirmation', 'changes_requested'];
export const INPUT_TTL_MINUTES = 30; // SPEC §6.6

// ─────────────────────────────── чтение ───────────────────────────────

export async function loadBundle(c: DbClient, deal: Deal): Promise<DealBundle> {
  const version = await versionsRepo.byVersion(c, deal.id, deal.currentVersion);
  if (!version) throw new Error(`у сделки ${deal.publicId} нет версии ${deal.currentVersion}`);
  // Запросы строго последовательно: один клиент транзакции не выполняет запросы параллельно
  // (pg предупреждает об этом и в 9.0 сделает ошибкой).
  const payments = await paymentsRepo.listByDeal(c, deal.id);
  const seller = await usersRepo.byId(c, deal.sellerUserId);
  const sellerProfile = await usersRepo.getProfile(c, deal.sellerUserId);
  const receipt = await receiptsRepo.byDeal(c, deal.id);
  if (!seller) throw new Error(`у сделки ${deal.publicId} нет исполнителя ${deal.sellerUserId}`);
  const client = deal.clientUserId ? await usersRepo.byId(c, deal.clientUserId) : null;
  return { deal, version, payments, seller, sellerProfile, client, receipt };
}

/** Прочитать сделку по публичному id без блокировки — для рендера карточки и для API. */
export async function getBundle(publicId: string): Promise<DealBundle> {
  return inTx(async (c) => {
    const deal = await dealsRepo.byPublicId(c, publicId);
    if (!deal) throw new NotFoundError(`сделка ${publicId}`);
    return loadBundle(c, deal);
  });
}

export async function getBundleById(dealId: number): Promise<DealBundle> {
  return inTx(async (c) => {
    const deal = await dealsRepo.byId(c, dealId);
    if (!deal) throw new NotFoundError(`сделка id=${dealId}`);
    return loadBundle(c, deal);
  });
}

export function taxModeOf(bundle: Pick<DealBundle, 'sellerProfile'>): TaxMode {
  return bundle.sellerProfile?.taxMode ?? 'npd';
}

/** Роль пользователя в сделке. В демо клиент и исполнитель — один человек, поэтому роль сообщает транспорт. */
export function participantRole(deal: Deal, userId: number): Array<'seller' | 'client'> {
  const roles: Array<'seller' | 'client'> = [];
  if (deal.sellerUserId === userId) roles.push('seller');
  if (deal.clientUserId === userId) roles.push('client');
  return roles;
}

export function actorRoleFor(deal: Deal, actor: Actor): ActorRole {
  if (actor.role === 'client' && deal.demo) return 'client_demo';
  return actor.role;
}

// ─────────────────────────── общий механизм перехода ───────────────────────────

type MutateArgs = {
  c: DbClient;
  deal: Deal;
  version: DealVersion;
  to: DealStatus;
  now: Date;
  actor: Actor;
  actorRole: ActorRole;
};

type TransitionSpec = {
  publicId?: string;
  dealId?: number;
  action: DealAction;
  actor: Actor;
  /** system-переходы (T8, T9, T14) не проверяют участие пользователя */
  system?: boolean;
  /** дополнительные изменения и события внутри той же транзакции */
  mutate?: (a: MutateArgs) => Promise<{ patch?: dealsRepo.DealPatch; events?: Array<{ type: DealEvent['type']; payload?: Record<string, unknown> }> }>;
};

function assertParticipant(deal: Deal, actor: Actor): void {
  const roles = participantRole(deal, actor.userId);
  if (!roles.includes(actor.role)) {
    throw new ForbiddenError(`пользователь ${actor.userId} не является ${actor.role} сделки ${deal.publicId}`);
  }
}

/**
 * Выполняет переход: блокировка строки → проверка машины состояний → патч + события → перепланирование напоминаний.
 * Идемпотентность: если действие уже применено (машина вернула `already_done`), ничего не меняем
 * и возвращаем alreadyDone=true — транспорт ответит «уже сделано» и перерисует карточку.
 */
async function runTransition(spec: TransitionSpec, now = new Date()): Promise<ServiceResult> {
  return inTx(async (c) => {
    const deal = spec.publicId
      ? await dealsRepo.lockByPublicId(c, spec.publicId)
      : await dealsRepo.lockById(c, spec.dealId!);
    if (!deal) throw new NotFoundError(`сделка ${spec.publicId ?? spec.dealId}`);
    if (!spec.system) assertParticipant(deal, spec.actor);

    const version = await versionsRepo.byVersion(c, deal.id, deal.currentVersion);
    if (!version) throw new Error(`у сделки ${deal.publicId} нет версии ${deal.currentVersion}`);
    const payments = await paymentsRepo.listByDeal(c, deal.id);
    const profile = await usersRepo.getProfile(c, deal.sellerUserId);
    const role: Role = spec.system ? 'system' : spec.actor.role;

    const verdict = canTransition(
      {
        status: deal.status,
        prepaymentKopecks: version.prepaymentKopecks,
        totalKopecks: version.totalKopecks,
        paidKopecks: paidTotal(payments),
        taxMode: profile?.taxMode ?? 'npd',
        clientJoined: deal.clientUserId !== null,
      },
      spec.action,
      role,
    );

    if (!verdict.ok) {
      if (verdict.reason === 'already_done') {
        const bundle = await loadBundle(c, deal);
        return { bundle, previousStatus: deal.status, statusChanged: false, events: [], alreadyDone: true };
      }
      throw new InvalidTransition(deal.status, spec.action, role, verdict.reason);
    }

    const actorRole = spec.system ? 'system' : actorRoleFor(deal, spec.actor);
    const extra = spec.mutate
      ? await spec.mutate({ c, deal, version, to: verdict.to, now, actor: spec.actor, actorRole })
      : {};

    const statusChanged = verdict.to !== deal.status;
    const patch: dealsRepo.DealPatch = { ...extra.patch };
    if (statusChanged) {
      patch.status = verdict.to;
      patch.statusChangedAt = now;
      // Срок подтверждения живёт, только пока ждём подтверждения (T1, T5, T6 его ставят); вышли из ожидания
      // в любой другой статус (T3, T7, T8, T16) — обнуляем, чтобы в БД не висел «срок» у подтверждённой сделки.
      if (AWAITING_CONFIRMATION.includes(deal.status) && !AWAITING_CONFIRMATION.includes(verdict.to)) patch.expiresAt = null;
    }
    const updated = await dealsRepo.update(c, deal.id, patch);

    const appended: DealEvent[] = [];
    for (const e of extra.events ?? []) {
      appended.push(
        await eventsRepo.append(c, {
          dealId: deal.id,
          type: e.type,
          actorUserId: spec.system ? null : spec.actor.userId,
          actorRole,
          payload: e.payload ?? {},
        }),
      );
    }

    const bundle = await loadBundle(c, updated);
    await replanReminders(c, bundle, now);
    log.info(
      { deal: updated.publicId, from: deal.status, to: updated.status, action: spec.action, role },
      'переход выполнен',
    );
    return { bundle, previousStatus: deal.status, statusChanged, events: appended, alreadyDone: false };
  });
}

/**
 * Пересоздание набора напоминаний (SPEC §10.1): гасим pending, которых нет в новом наборе, и материализуем набор.
 * Раньше гасилось всё подряд, а вставка шла ON CONFLICT DO NOTHING: у перехода без смены статуса (T2 «клиент
 * открыл ссылку», демо «Открыть как клиент») ключ confirmation_expired тот же — строка оставалась погашенной,
 * и настоящая сделка не истекала никогда (аудит 22.09 п. 3). Уже зависшие строки поднимает миграция 0003.
 */
async function replanReminders(c: DbClient, bundle: DealBundle, now: Date): Promise<void> {
  const items = isTerminal(bundle.deal.status)
    ? []
    : planReminders({ deal: bundle.deal, version: bundle.version, taxMode: taxModeOf(bundle), now });
  await remindersRepo.cancelPendingExcept(c, bundle.deal.id, items.map((i) => i.dedupeKey), 'replanned');
  if (items.length) await remindersRepo.planMany(c, bundle.deal.id, items);
}

// ─────────────────────────────── T1: создание ───────────────────────────────

export type CreateDealInput = {
  sellerUserId: number;
  template: TemplateKey;
  title: string;
  description: string | null;
  scheduledAt: Date | null;
  totalKopecks: number;
  prepaymentKopecks: number;
  cancelRule: CancelRule;
  photoMaxToken: string | null;
  /** предзаполненная демо-сделка: клиентом сразу становится сам исполнитель (SPEC §12) */
  demo?: boolean;
  /**
   * Пробная сделка из чата: `example` — «📝 Сделка-пример для клиента» (настоящая, клиент не привязан),
   * `demo` — «🧪 Попробовать на демо-сделке». Не больше TRIAL_LIMIT_PER_HOUR каждого вида в час.
   */
  trial?: 'example' | 'demo';
};

export const TRIAL_LIMIT_PER_HOUR = 5;

export async function createDeal(input: CreateDealInput, now = new Date()): Promise<ServiceResult> {
  assertAmounts(input.totalKopecks, input.prepaymentKopecks);
  const title = input.title.trim();
  if (title.length < 2 || title.length > 80) throw new ValidationError('Название — от 2 до 80 символов', 'title');
  if (input.description && input.description.length > 1000)
    throw new ValidationError('Уточнения — до 1000 символов', 'description');
  if (input.scheduledAt && input.scheduledAt.getTime() < addMinutes(now, 30).getTime())
    throw new ValidationError('Дата не раньше чем через 30 минут', 'scheduled_at');

  return inTx(async (c) => {
    if (input.trial) await assertTrialQuota(c, input.sellerUserId, input.trial, now);
    const deal = await createWithUniquePublicId(c, {
      sellerUserId: input.sellerUserId,
      template: input.template,
      expiresAt: addHours(now, CONFIRMATION_TTL_HOURS),
    });
    await versionsRepo.create(c, {
      dealId: deal.id,
      version: 1,
      title,
      description: input.description,
      scheduledAt: input.scheduledAt,
      totalKopecks: input.totalKopecks,
      prepaymentKopecks: input.prepaymentKopecks,
      cancelRule: input.cancelRule,
      photoMaxToken: input.photoMaxToken,
      changeRequestText: null,
      createdByUserId: input.sellerUserId,
    });
    const created = await eventsRepo.append(c, {
      dealId: deal.id,
      type: 'deal.created',
      actorUserId: input.sellerUserId,
      actorRole: 'seller',
      payload: { template: input.template, total: input.totalKopecks, prepayment: input.prepaymentKopecks, source: input.trial ?? 'app' },
    });

    const withDemo = input.demo
      ? await dealsRepo.update(c, deal.id, { demo: true, clientUserId: input.sellerUserId, clientJoinedAt: now })
      : deal;
    const bundle = await loadBundle(c, withDemo);
    await replanReminders(c, bundle, now);
    return { bundle, previousStatus: 'awaiting_confirmation', statusChanged: true, events: [created], alreadyDone: false };
  });
}

/**
 * Лимит пробных сделок в час. Advisory-блокировка по пользователю в той же транзакции: два быстрых
 * нажатия не проскочат между подсчётом и вставкой.
 */
async function assertTrialQuota(c: DbClient, sellerUserId: number, trial: 'example' | 'demo', now: Date): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`trial:${sellerUserId}`]);
  const created = await eventsRepo.countCreatedSince(c, { sellerUserId, source: trial, since: addHours(now, -1) });
  if (created >= TRIAL_LIMIT_PER_HOUR) throw new TrialLimitError(trial);
}

/** public_id генерируется случайно; на коллизию (крайне маловероятную) просто пробуем ещё раз. */
async function createWithUniquePublicId(
  c: DbClient,
  args: { sellerUserId: number; template: TemplateKey; expiresAt: Date },
): Promise<Deal> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await dealsRepo.create(c, { ...args, publicId: newPublicId() });
    } catch (e) {
      const msg = (e as Error).message;
      if (!/deals_public_id_key|duplicate key/.test(msg) || attempt === 4) throw e;
      log.warn({ attempt }, 'коллизия public_id, повтор');
    }
  }
  throw new Error('не удалось подобрать public_id');
}

// ─────────────────────────────── T2: вход клиента ───────────────────────────────

/**
 * Клиент перешёл по ссылке. Идемпотентно: повторное открытие тем же клиентом ничего не меняет (§14 п. 5).
 * Возвращает `alreadyDone: true`, если клиент уже был привязан.
 */
export async function joinClient(args: { publicId: string; userId: number }, now = new Date()): Promise<ServiceResult> {
  return inTx(async (c) => {
    const deal = await dealsRepo.lockByPublicId(c, args.publicId);
    if (!deal) throw new NotFoundError(`сделка ${args.publicId}`);

    if (deal.clientUserId === args.userId) {
      const bundle = await loadBundle(c, deal);
      return { bundle, previousStatus: deal.status, statusChanged: false, events: [], alreadyDone: true };
    }
    if (deal.clientUserId !== null) throw new ForbiddenError('other_client');
    if (deal.sellerUserId === args.userId) throw new ForbiddenError('self_is_seller');
    if (isTerminal(deal.status)) throw new InvalidTransition(deal.status, 'join', 'client', 'forbidden');

    const version = await versionsRepo.byVersion(c, deal.id, deal.currentVersion);
    if (!version) throw new Error(`нет версии ${deal.currentVersion}`);
    const profile = await usersRepo.getProfile(c, deal.sellerUserId);
    const verdict = canTransition(
      {
        status: deal.status,
        prepaymentKopecks: version.prepaymentKopecks,
        totalKopecks: version.totalKopecks,
        paidKopecks: 0,
        taxMode: profile?.taxMode ?? 'npd',
        clientJoined: false,
      },
      'join',
      'client',
    );
    if (!verdict.ok) throw new InvalidTransition(deal.status, 'join', 'client', 'forbidden');

    const updated = await dealsRepo.update(c, deal.id, { clientUserId: args.userId, clientJoinedAt: now });
    const event = await eventsRepo.append(c, {
      dealId: deal.id,
      type: 'client.joined',
      actorUserId: args.userId,
      actorRole: 'client',
      payload: {},
    });
    const bundle = await loadBundle(c, updated);
    await replanReminders(c, bundle, now);
    return { bundle, previousStatus: deal.status, statusChanged: false, events: [event], alreadyDone: false };
  });
}

/** Демо-режим «Открыть как клиент»: клиентом становится сам исполнитель (SPEC §12). */
export async function openAsClient(args: { publicId: string; sellerUserId: number }, now = new Date()): Promise<ServiceResult> {
  return inTx(async (c) => {
    const deal = await dealsRepo.lockByPublicId(c, args.publicId);
    if (!deal) throw new NotFoundError(`сделка ${args.publicId}`);
    if (deal.sellerUserId !== args.sellerUserId) throw new ForbiddenError('не ваша сделка');

    if (deal.demo && deal.clientUserId === args.sellerUserId) {
      const bundle = await loadBundle(c, deal);
      return { bundle, previousStatus: deal.status, statusChanged: false, events: [], alreadyDone: true };
    }
    if (deal.clientUserId !== null) throw new ForbiddenError('к сделке уже присоединился клиент');
    if (isTerminal(deal.status)) throw new InvalidTransition(deal.status, 'join', 'client', 'forbidden');

    const updated = await dealsRepo.update(c, deal.id, {
      demo: true,
      clientUserId: args.sellerUserId,
      clientJoinedAt: now,
    });
    const event = await eventsRepo.append(c, {
      dealId: deal.id,
      type: 'demo.opened',
      actorUserId: args.sellerUserId,
      actorRole: 'seller',
      payload: {},
    });
    const bundle = await loadBundle(c, updated);
    await replanReminders(c, bundle, now);
    return { bundle, previousStatus: deal.status, statusChanged: false, events: [event], alreadyDone: false };
  });
}

// ─────────────────────── T3–T7, T10, T12, T13: кнопки сторон ───────────────────────

export function confirm(publicId: string, actor: Actor, now = new Date()): Promise<ServiceResult> {
  return runTransition(
    {
      publicId,
      action: 'confirm',
      actor,
      mutate: async ({ c, deal, version, now: at, actor: a }) => {
        await versionsRepo.markConfirmed(c, deal.id, version.version, a.userId, at);
        return {
          patch: { confirmedAt: at },
          events: [{ type: 'version.confirmed', payload: { version: version.version } }],
        };
      },
    },
    now,
  );
}

export function requestChanges(publicId: string, actor: Actor, text: string, now = new Date()): Promise<ServiceResult> {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 500) throw new ValidationError('input_too_long', 'text');
  return runTransition(
    {
      publicId,
      action: 'request_changes',
      actor,
      mutate: async () => ({ events: [{ type: 'version.change_requested', payload: { text: trimmed } }] }),
    },
    now,
  );
}

/** T6 «Оставить как есть»: версия та же, продлеваем срок подтверждения. */
export function keepAsIs(publicId: string, actor: Actor, now = new Date()): Promise<ServiceResult> {
  return runTransition(
    {
      publicId,
      action: 'keep_as_is',
      actor,
      mutate: async ({ version, now: at }) => ({
        patch: { expiresAt: addHours(at, CONFIRMATION_TTL_HOURS) },
        // Отдельного типа события в SPEC §5.4 для T6 нет; помечаем флагом, чтобы транспорт выбрал N5, а не N4.
        events: [{ type: 'version.created', payload: { version: version.version, kept_as_is: true } }],
      }),
    },
    now,
  );
}

export type NewVersionInput = {
  title: string;
  description: string | null;
  scheduledAt: Date | null;
  totalKopecks: number;
  prepaymentKopecks: number;
  cancelRule: CancelRule;
  photoMaxToken: string | null;
};

/** T5: новая версия условий. Старая версия не редактируется — только добавляется следующая (SPEC §8). */
export function newVersion(publicId: string, actor: Actor, input: NewVersionInput, now = new Date()): Promise<ServiceResult> {
  assertAmounts(input.totalKopecks, input.prepaymentKopecks);
  const title = input.title.trim();
  if (title.length < 2 || title.length > 80) throw new ValidationError('Название — от 2 до 80 символов', 'title');
  if (input.scheduledAt && input.scheduledAt.getTime() < addMinutes(now, 30).getTime())
    throw new ValidationError('Дата не раньше чем через 30 минут', 'scheduled_at');

  return runTransition(
    {
      publicId,
      action: 'new_version',
      actor,
      mutate: async ({ c, deal, now: at, actor: a }) => {
        const nextVersion = (await versionsRepo.maxVersion(c, deal.id)) + 1;
        const lastChangeRequest = (await eventsRepo.listByDeal(c, deal.id, 50))
          .filter((e) => e.type === 'version.change_requested')
          .at(-1);
        await versionsRepo.create(c, {
          dealId: deal.id,
          version: nextVersion,
          title,
          description: input.description,
          scheduledAt: input.scheduledAt,
          totalKopecks: input.totalKopecks,
          prepaymentKopecks: input.prepaymentKopecks,
          cancelRule: input.cancelRule,
          photoMaxToken: input.photoMaxToken,
          changeRequestText: (lastChangeRequest?.payload?.text as string | undefined) ?? null,
          createdByUserId: a.userId,
        });
        return {
          patch: { currentVersion: nextVersion, expiresAt: addHours(at, CONFIRMATION_TTL_HOURS), confirmedAt: null },
          events: [{ type: 'version.created', payload: { version: nextVersion } }],
        };
      },
    },
    now,
  );
}

export function decline(publicId: string, actor: Actor, now = new Date()): Promise<ServiceResult> {
  return runTransition(
    { publicId, action: 'decline', actor, mutate: async () => ({ events: [{ type: 'deal.declined' }] }) },
    now,
  );
}

export function markDone(publicId: string, actor: Actor, now = new Date()): Promise<ServiceResult> {
  return runTransition(
    {
      publicId,
      action: 'done',
      actor,
      mutate: async ({ now: at }) => ({ patch: { doneAt: at }, events: [{ type: 'deal.done' }] }),
    },
    now,
  );
}

export function remarks(publicId: string, actor: Actor, text: string, now = new Date()): Promise<ServiceResult> {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 500) throw new ValidationError('input_too_long', 'text');
  return runTransition(
    { publicId, action: 'remarks', actor, mutate: async () => ({ events: [{ type: 'deal.remarks', payload: { text: trimmed } }] }) },
    now,
  );
}

export function markFixed(publicId: string, actor: Actor, now = new Date()): Promise<ServiceResult> {
  return runTransition(
    { publicId, action: 'fixed', actor, mutate: async () => ({ events: [{ type: 'deal.fixed' }] }) },
    now,
  );
}

/**
 * T11 «Принимаю». Если остатка нет, целевой статус — `paid`, и тогда сразу выполняются эффекты T14
 * (SPEC §5.2 T11: «если сразу paid — выполняются эффекты T14»), а при tax_mode='none' — ещё и T15.
 * Цепочку доводит вызывающий через `finishIfPaid`, чтобы каждый переход остался отдельной транзакцией
 * со своим событием и своим перепланированием напоминаний.
 */
export function accept(publicId: string, actor: Actor, now = new Date()): Promise<ServiceResult> {
  return runTransition(
    {
      publicId,
      action: 'accept',
      actor,
      mutate: async ({ now: at, to }) => ({
        patch: to === 'paid' ? { acceptedAt: at, paidAt: at } : { acceptedAt: at },
        events:
          to === 'paid'
            ? [{ type: 'deal.accepted' }, { type: 'payment.succeeded', payload: { kind: 'final', amount: 0, no_remainder: true } }]
            : [{ type: 'deal.accepted' }],
      }),
    },
    now,
  );
}

// ─────────────────────── T9, T14: деньги пришли (system) ───────────────────────

/** Платёж подтверждён: вебхуком, опросом или кнопкой «Получил(а)». Идемпотентно по статусу сделки. */
export async function applyPaymentSucceeded(
  args: { dealId: number; paymentId: number; kind: 'prepayment' | 'final' },
  now = new Date(),
): Promise<ServiceResult> {
  return runTransition(
    {
      dealId: args.dealId,
      action: args.kind === 'prepayment' ? 'prepayment_succeeded' : 'final_succeeded',
      actor: { userId: 0, role: 'seller' },
      system: true,
      mutate: async ({ now: at, to }) => ({
        patch: to === 'paid' ? { paidAt: at } : {},
        events: [{ type: 'payment.succeeded', payload: { kind: args.kind, payment_id: args.paymentId } }],
      }),
    },
    now,
  );
}

/** T15 при tax_mode='none': чек не нужен, закрываем сразу после полной оплаты. */
export async function closeAutomatically(dealId: number, now = new Date()): Promise<ServiceResult> {
  return runTransition(
    {
      dealId,
      action: 'close_without_receipt',
      actor: { userId: 0, role: 'seller' },
      system: true,
      mutate: async ({ now: at }) => ({
        patch: { closedAt: at },
        events: [{ type: 'deal.closed', payload: { reason: 'tax_mode_none' } }],
      }),
    },
    now,
  );
}

// ─────────────────────── T15: чек и закрытие ───────────────────────

export async function attachReceipt(
  args: {
    publicId: string;
    actor: Actor;
    attachmentType: 'image' | 'file';
    maxToken: string;
    maxUrl: string | null;
    fileName: string | null;
  },
  now = new Date(),
): Promise<ServiceResult> {
  return runTransition(
    {
      publicId: args.publicId,
      action: 'attach_receipt',
      actor: args.actor,
      mutate: async ({ c, deal, now: at, actor }) => {
        await receiptsRepo.create(c, {
          dealId: deal.id,
          uploadedByUserId: actor.userId,
          attachmentType: args.attachmentType,
          maxToken: args.maxToken,
          maxUrl: args.maxUrl,
          fileName: args.fileName,
        });
        return {
          patch: { closedAt: at },
          events: [{ type: 'receipt.attached' }, { type: 'deal.closed', payload: { with_receipt: true } }],
        };
      },
    },
    now,
  );
}

export function closeWithoutReceipt(publicId: string, actor: Actor, now = new Date()): Promise<ServiceResult> {
  return runTransition(
    {
      publicId,
      action: 'close_without_receipt',
      actor,
      mutate: async ({ now: at }) => ({
        patch: { closedAt: at },
        events: [{ type: 'deal.closed_without_receipt' }, { type: 'deal.closed', payload: { with_receipt: false } }],
      }),
    },
    now,
  );
}

// ─────────────────────── T16, T17: отмена ───────────────────────

export function cancel(publicId: string, actor: Actor, reason: string | null, now = new Date()): Promise<ServiceResult> {
  if (reason && reason.length > 300) throw new ValidationError('Причина — до 300 символов', 'reason');
  return runTransition(
    {
      publicId,
      action: 'cancel',
      actor,
      mutate: async ({ c, deal, version, now: at, actor: a }) => {
        const payments = await paymentsRepo.listByDeal(c, deal.id);
        const prepaymentSucceeded = payments.some((p) => p.kind === 'prepayment' && p.status === 'succeeded');
        const expected = refundExpected({
          cancelRule: version.cancelRule,
          cancelledBy: a.role,
          scheduledAt: version.scheduledAt,
          prepaymentSucceeded,
          now: at,
        });
        // Живые ссылочные платежи помечаем отменёнными локально: у провайдера ссылка просто истечёт (SPEC §5.2 T16).
        for (const p of payments) {
          if (p.status === 'pending' || p.status === 'claimed') {
            await paymentsRepo.update(c, p.id, { status: 'canceled', canceledAt: at });
          }
        }
        return {
          patch: { cancelledAt: at, cancelledByRole: a.role, cancelReason: reason, cancelRefundExpected: expected },
          events: [{ type: 'deal.cancelled', payload: { by: a.role, reason, refund_expected: expected } }],
        };
      },
    },
    now,
  );
}

/**
 * Что станет с предоплатой, если отменить сейчас — чтобы сказать об этом ДО подтверждения отмены
 * (найдено прогоном 1, S5: клиент узнавал о потере предоплаты только после). null — предоплаты не было.
 */
export function refundIfCancelled(bundle: DealBundle, by: 'seller' | 'client', now = new Date()): boolean | null {
  return refundExpected({
    cancelRule: bundle.version.cancelRule,
    cancelledBy: by,
    scheduledAt: bundle.version.scheduledAt,
    prepaymentSucceeded: bundle.payments.some((p) => p.kind === 'prepayment' && p.status === 'succeeded'),
    now,
  });
}

// ─────────────────────── T8: истечение срока (system) ───────────────────────

export function expire(dealId: number, now = new Date()): Promise<ServiceResult> {
  return runTransition(
    {
      dealId,
      action: 'expire',
      actor: { userId: 0, role: 'seller' },
      system: true,
      mutate: async () => ({ events: [{ type: 'deal.expired' }] }),
    },
    now,
  );
}

// ─────────────────────── карточки ───────────────────────

export async function rememberCard(a: {
  dealId: number;
  userId: number;
  role: 'seller' | 'client' | 'client_demo';
  chatId: number;
  mid: string;
}): Promise<void> {
  await inTx(async (c) => {
    await cardsRepo.upsert(c, a);
  });
}

export async function cardsOf(dealId: number) {
  return inTx((c) => cardsRepo.byDeal(c, dealId));
}

export async function updateCardMid(cardId: number, mid: string): Promise<void> {
  await inTx(async (c) => {
    await cardsRepo.updateMid(c, cardId, mid);
  });
}
