// Сервис сделок: ЕДИНСТВЕННОЕ место, где меняется состояние сделки.
// Каждый переход — в транзакции с `SELECT … FOR UPDATE` строки deals (SPEC §5.2 «Конкурентность»),
// с записью события (§5.4) и пересозданием набора напоминаний (§10.1).
// Транспорт (бот, HTTP) не знает про SQL, а домен не знает про SDK MAX: сервис возвращает список
// добавленных событий, а какие уведомления N1–N15 из них следуют — решает transport/bot/notify.
import {
  DealNotEditableError,
  ForbiddenError,
  InvalidTransition,
  NoChangesError,
  NotFoundError,
  NotYourDealError,
  SlotBusyError,
  TrialLimitError,
  ValidationError,
  VersionMismatchError,
} from '../../errors.js';
import { inTx, type DbClient } from '../../db/pool.js';
import * as cardsRepo from '../../db/repos/cards.js';
import * as dealsRepo from '../../db/repos/deals.js';
import * as eventsRepo from '../../db/repos/events.js';
import * as paymentsRepo from '../../db/repos/payments.js';
import * as proposalsRepo from '../../db/repos/proposals.js';
import * as ratingsRepo from '../../db/repos/ratings.js';
import * as receiptsRepo from '../../db/repos/receipts.js';
import * as remindersRepo from '../../db/repos/reminders.js';
import * as usersRepo from '../../db/repos/users.js';
import * as versionsRepo from '../../db/repos/versions.js';
import { log } from '../../logger.js';
import {
  CANCELLED_AFTER_CLAIM,
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
  type TermsField,
  type TimeProposal,
  type User,
} from '../../types.js';
import { checkSlot } from '../schedule/availability.js';
import { computeReliability } from '../reliability.js';
import { assertAmounts } from '../money.js';
import { addHours, addMinutes, DEFAULT_TZ } from '../time.js';
import { newPublicId } from '../ids.js';
import { planReminders } from '../reminder/plan.js';
import { refundExpected } from './rules.js';
import { canTransition, EDITABLE_STATUSES } from './state-machine.js';

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
  const timeProposal = await proposalsRepo.pendingForDeal(c, deal.id);
  // Надёжность считаем, только если исполнитель показывает её клиентам (ЗАДАЧА_08 E): иначе карточке она не нужна.
  const sellerReliability = sellerProfile?.showReliability
    ? computeReliability(await ratingsRepo.finishedFacts(c, deal.sellerUserId), DEFAULT_TZ)
    : null;
  return { deal, version, payments, seller, sellerProfile, client, receipt, timeProposal, sellerReliability };
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

/**
 * Кнопку чужой сделки нажал посторонний (пересланная карточка, подобранный payload): дальше этой проверки
 * он не проходит — ни карточки, ни действия, ни строки card_messages (ЗАДАЧА_03 G1).
 */
export function ensureParticipant(deal: Deal, userId: number): void {
  if (participantRole(deal, userId).length === 0) throw new NotYourDealError();
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
  /**
   * Подтверждение оплаты идемпотентно в широком смысле: если сделка уже ушла из статуса, в котором
   * этот платёж что-то двигает (оплата применена раньше, сделка дальше или отменена), — это не ошибка,
   * а «уже сделано». Нужно, чтобы любое повторное применение succeeded могло без риска вызывать
   * переход (ЗАДАЧА_03 F4). Деньги по отменённой сделке ловит rails.applyProviderStatus раньше.
   */
  idempotentIfMoved?: boolean;
  /**
   * Проверка под блокировкой строки, ДО машины состояний: бросает — перехода нет. Нужна «Подтверждаю»:
   * версия на кнопке сверяется с текущей в той же транзакции, где исполнитель мог её поднять (T5).
   */
  guard?: (deal: Deal) => void;
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
    spec.guard?.(deal);

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
      if (verdict.reason === 'already_done' || spec.idempotentIfMoved) {
        if (verdict.reason !== 'already_done') {
          log.info({ deal: deal.publicId, status: deal.status, action: spec.action }, 'оплата уже учтена: сделка ушла дальше, переход не нужен');
        }
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
  // Терминальные статусы план возвращает пустым, кроме отменённой сделки с ожидаемым возвратом (refund_due, H1).
  const items = planReminders({ deal: bundle.deal, version: bundle.version, taxMode: taxModeOf(bundle), now });
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
  /**
   * «Повторить» с тем же клиентом (ЗАДАЧА_04 F): клиент привязывается сразу, как при входе по ссылке (T2) —
   * карточку ему отправит транспорт. Проверяет право на это resolveRepeat.
   */
  clientUserId?: number;
  /** public_id сделки, которую повторяют — для журнала событий. */
  repeatOf?: string;
  /** Услуга исполнителя, из которой собрана карточка, и её длительность на этот момент (ЗАДАЧА_08 C). */
  service?: { id: number; durationMin: number } | null;
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
      serviceId: input.service?.id ?? null,
      durationMin: input.service?.durationMin ?? null,
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
      payload: {
        template: input.template,
        total: input.totalKopecks,
        prepayment: input.prepaymentKopecks,
        source: input.trial ?? (input.repeatOf ? 'repeat' : 'app'),
        ...(input.repeatOf ? { repeat_of: input.repeatOf } : {}),
      },
    });

    const events: DealEvent[] = [created];
    let current = deal;
    if (input.demo) {
      current = await dealsRepo.update(c, deal.id, { demo: true, clientUserId: input.sellerUserId, clientJoinedAt: now });
    } else if (input.clientUserId !== undefined) {
      // Тот же T2, что при входе по ссылке, — в той же транзакции: сделки «без клиента» не бывает ни на миг,
      // и напоминание client_not_opened не планируется вовсе.
      if (input.clientUserId === input.sellerUserId) throw new ForbiddenError('self_is_seller');
      // В журнале — кто привязал: исполнитель, повторив сделку, а не клиент по ссылке.
      const bound = await bindClient(c, deal, input.clientUserId, now, {
        actorUserId: input.sellerUserId,
        actorRole: 'seller',
        payload: { source: 'repeat', repeat_of: input.repeatOf ?? null },
      });
      current = bound.deal;
      events.push(bound.event);
    }
    const bundle = await loadBundle(c, current);
    await replanReminders(c, bundle, now);
    return { bundle, previousStatus: 'awaiting_confirmation', statusChanged: true, events, alreadyDone: false };
  });
}

export type RepeatPlan = {
  /** настоящий клиент прежней сделки, если просили «тот же клиент» */
  client: User | null;
  /** кого привязать к новой сделке сразу — только если у клиента есть диалог с ботом (бот не пишет первым) */
  attachClientId: number | null;
  /** «тот же клиент» просили, но диалога с ботом у него нет — новая сделка будет обычной, со ссылкой */
  clientNoDialog: boolean;
};

/**
 * «🔁 Повторить» (ЗАДАЧА_04 F): повторять можно только свою сделку (иначе 403 — и для несуществующей, чтобы
 * не подсказывать чужие id), демо — нельзя (в ней клиент — сам исполнитель). «Тот же клиент» — только если у
 * прежней сделки был настоящий клиент: так исполнитель не отправит карточку постороннему.
 */
export async function resolveRepeat(sellerUserId: number, repeatOf: string, sameClient: boolean): Promise<RepeatPlan> {
  return inTx(async (c) => {
    const source = await dealsRepo.byPublicId(c, repeatOf);
    if (!source || source.sellerUserId !== sellerUserId) throw new ForbiddenError('repeat_not_yours');
    if (source.demo) throw new ValidationError('Демо-сделку повторить нельзя — создайте новую сделку', 'repeat_of');
    if (!sameClient) return { client: null, attachClientId: null, clientNoDialog: false };
    const clientId = source.clientUserId;
    if (clientId === null || clientId === sellerUserId) throw new ForbiddenError('repeat_no_client');
    const client = await usersRepo.byId(c, clientId);
    if (!client) throw new ForbiddenError('repeat_no_client');
    const hasDialog = client.dialogChatId !== null;
    return { client, attachClientId: hasDialog ? clientId : null, clientNoDialog: !hasDialog };
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
  args: { sellerUserId: number; template: TemplateKey; expiresAt: Date; serviceId: number | null; durationMin: number | null },
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

    const { deal: updated, event } = await bindClient(c, deal, args.userId, now, { actorUserId: args.userId, actorRole: 'client', payload: {} });
    const bundle = await loadBundle(c, updated);
    await replanReminders(c, bundle, now);
    return { bundle, previousStatus: deal.status, statusChanged: false, events: [event], alreadyDone: false };
  });
}

/** Эффект T2 (SPEC §5.2): клиент привязан, время входа, событие client.joined. Вход по ссылке и «Повторить». */
async function bindClient(
  c: DbClient,
  deal: Deal,
  userId: number,
  now: Date,
  by: { actorUserId: number; actorRole: ActorRole; payload: Record<string, unknown> },
): Promise<{ deal: Deal; event: DealEvent }> {
  const updated = await dealsRepo.update(c, deal.id, { clientUserId: userId, clientJoinedAt: now });
  const event = await eventsRepo.append(c, { dealId: deal.id, type: 'client.joined', ...by });
  return { deal: updated, event };
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

/**
 * T3 «Подтверждаю». `version` — номер версии с кнопки (`cf:<id>:<v>`): клиент подтверждает то, что видел.
 * Исполнитель успел изменить условия (T5) — перехода нет, VersionMismatchError («Условия изменились»).
 * Кнопка старого формата без версии (карточки до ЗАДАЧА_04) считается кнопкой версии 1.
 */
export function confirm(publicId: string, actor: Actor, now = new Date(), version = 1): Promise<ServiceResult> {
  return runTransition(
    {
      publicId,
      action: 'confirm',
      actor,
      guard: (deal) => {
        if (deal.currentVersion !== version) throw new VersionMismatchError(version, deal.currentVersion);
      },
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
      mutate: async ({ c, deal, version, now: at }) => {
        // «Оставить как есть» отклоняет и предложенное время (ЗАДАЧА_08 D): кнопка «Принять» больше не нужна.
        await proposalsRepo.supersedePending(c, deal.id, at);
        return {
          patch: { expiresAt: addHours(at, CONFIRMATION_TTL_HOURS) },
          // Отдельного типа события в SPEC §5.4 для T6 нет; помечаем флагом, чтобы транспорт выбрал N5, а не N4.
          events: [{ type: 'version.created', payload: { version: version.version, kept_as_is: true } }],
        };
      },
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
  /** undefined — оставить макет текущей версии, null — убрать */
  photoMaxToken?: string | null;
  /**
   * Услуга (ЗАДАЧА_08 C): undefined — не менять, null — отвязать, объект — сменить (и длительность вместе с ней).
   * В «что изменилось» не входит: клиент услугу не видит, для него это те же условия.
   */
  service?: { id: number; durationMin: number } | null;
  /** Версия создаётся принятием предложения времени (ЗАДАЧА_08 D): предложение становится `accepted`. */
  acceptProposalId?: number;
};

/** Пустые «Уточнения» — это null: форма шлёт и null, и '', и пробелы (как при создании — с обрезкой). */
function normalizeDescription(d: string | null | undefined): string | null {
  const t = (d ?? '').trim();
  return t ? t : null;
}

/** Какие поля условий новая версия меняет — по ним N4 перечисляет изменения клиенту (SPEC §6.5). */
export function changedTerms(
  current: Pick<DealVersion, 'title' | 'description' | 'scheduledAt' | 'totalKopecks' | 'prepaymentKopecks' | 'cancelRule'>,
  next: Pick<NewVersionInput, 'title' | 'description' | 'scheduledAt' | 'totalKopecks' | 'prepaymentKopecks' | 'cancelRule'>,
): TermsField[] {
  const out: TermsField[] = [];
  if (current.title.trim() !== next.title.trim()) out.push('title');
  if (normalizeDescription(current.description) !== normalizeDescription(next.description)) out.push('description');
  if ((current.scheduledAt?.getTime() ?? null) !== (next.scheduledAt?.getTime() ?? null)) out.push('scheduled_at');
  if (current.totalKopecks !== next.totalKopecks) out.push('total');
  if (current.prepaymentKopecks !== next.prepaymentKopecks) out.push('prepayment');
  if (current.cancelRule !== next.cancelRule) out.push('cancel_rule');
  return out;
}

/**
 * T5: новая версия условий (SPEC §5.2). Старая версия не редактируется — добавляется следующая (§8).
 * Разрешено из awaiting_confirmation и changes_requested, иначе DealNotEditableError; ничего не изменилось —
 * NoChangesError (клиента зря не беспокоим). Всё сравнение — под блокировкой строки, с текущей версией.
 * `status_changed_at` сдвигается и без смены статуса: напоминания (client_not_opened +24 ч от версии,
 * confirmation_expired по новому expires_at) перепланируются от новой версии — их ключи строятся от этого времени.
 */
export async function newVersion(publicId: string, actor: Actor, input: NewVersionInput, now = new Date()): Promise<ServiceResult> {
  assertAmounts(input.totalKopecks, input.prepaymentKopecks);
  const title = input.title.trim();
  if (title.length < 2 || title.length > 80) throw new ValidationError('Название — от 2 до 80 символов', 'title');
  const description = normalizeDescription(input.description);
  if (description && description.length > 1000) throw new ValidationError('Уточнения — до 1000 символов', 'description');

  try {
    return await runTransition(
      {
        publicId,
        action: 'new_version',
        actor,
        mutate: async ({ c, deal, version, now: at, actor: a }) => {
          const next = { ...input, title, description };
          const changed = changedTerms(version, next);
          if (changed.length === 0) throw new NoChangesError();
          // Прежнюю дату, даже если она уже близко, не проверяем: исполнитель мог менять только сумму.
          if (changed.includes('scheduled_at') && next.scheduledAt && next.scheduledAt.getTime() < addMinutes(at, 30).getTime()) {
            throw new ValidationError('Дата не раньше чем через 30 минут', 'scheduled_at');
          }
          const nextVersion = (await versionsRepo.maxVersion(c, deal.id)) + 1;
          const lastChangeRequest = (await eventsRepo.listByDeal(c, deal.id, 50))
            .filter((e) => e.type === 'version.change_requested')
            .at(-1);
          await versionsRepo.create(c, {
            dealId: deal.id,
            version: nextVersion,
            title,
            description,
            scheduledAt: next.scheduledAt,
            totalKopecks: next.totalKopecks,
            prepaymentKopecks: next.prepaymentKopecks,
            cancelRule: next.cancelRule,
            photoMaxToken: input.photoMaxToken === undefined ? version.photoMaxToken : input.photoMaxToken,
            changeRequestText: deal.status === 'changes_requested' ? ((lastChangeRequest?.payload?.text as string | undefined) ?? null) : null,
            createdByUserId: a.userId,
          });
          // Предложение времени: принятое — `accepted` (время удерживается, пока клиент подтверждает версию, §7.10),
          // остальные ожидающие устарели — новая версия их перекрывает.
          if (input.acceptProposalId) await proposalsRepo.resolve(c, input.acceptProposalId, 'accepted', at, nextVersion);
          await proposalsRepo.supersedePending(c, deal.id, at);
          const servicePatch =
            input.service === undefined ? {} : { serviceId: input.service?.id ?? null, durationMin: input.service?.durationMin ?? null };
          return {
            patch: { currentVersion: nextVersion, statusChangedAt: at, expiresAt: addHours(at, CONFIRMATION_TTL_HOURS), confirmedAt: null, ...servicePatch },
            events: [{ type: 'version.created', payload: { version: nextVersion, changed } }],
          };
        },
      },
      now,
    );
  } catch (e) {
    // Машина состояний отказала: условия уже подтверждены (или сделка завершена) — править нельзя.
    if (e instanceof InvalidTransition) throw new DealNotEditableError(e.status);
    throw e;
  }
}

// ─────────────────────── «Другое время» (ЗАДАЧА_08 D, SPEC §7.10) ───────────────────────

const OFF_GRID_MESSAGE = 'Выберите время из сетки: с 08:00 до 21:30, не раньше чем через 30 минут и не дальше 30 дней';

/**
 * Клиент предлагает другое время. Машина состояний не меняется: из `awaiting_confirmation` это T4 «Предложить
 * изменения» (текст запроса — `text`, его готовит транспорт), из `changes_requested` — только событие. В обоих
 * случаях — строка `time_proposals` (прежнее ожидающее предложение вытесняется) и событие `time.proposed`.
 * Время проверяется на сетке и по занятости; окончательно — ещё раз при принятии, под блокировкой исполнителя.
 */
export async function proposeTime(
  publicId: string,
  actor: Actor,
  scheduledAt: Date,
  a: { tz: string; text: string },
  now = new Date(),
): Promise<{ result: ServiceResult; proposal: TimeProposal }> {
  if (actor.role !== 'client') throw new ForbiddenError('время предлагает клиент');
  const current = await getBundle(publicId);
  if (current.version.scheduledAt?.getTime() === scheduledAt.getTime()) {
    throw new ValidationError('Это и так текущее время. Выберите другое', 'scheduled_at');
  }

  /** Проверка и запись предложения — внутри транзакции перехода или своей. */
  const record = async (c: DbClient, deal: Deal): Promise<TimeProposal> => {
    const slot = await checkSlot(c, { sellerUserId: deal.sellerUserId, dealId: deal.id, start: scheduledAt, durationMin: deal.durationMin, now, tz: a.tz });
    if (slot === 'off_grid') throw new ValidationError(OFF_GRID_MESSAGE, 'scheduled_at');
    if (slot === 'busy') throw new SlotBusyError();
    await proposalsRepo.supersedePending(c, deal.id, now);
    return proposalsRepo.create(c, { dealId: deal.id, proposedByUserId: actor.userId, scheduledAt, baseVersion: deal.currentVersion });
  };
  const proposedEvent = (p: TimeProposal) => ({
    type: 'time.proposed' as const,
    payload: { proposal_id: p.id, scheduled_at: p.scheduledAt.toISOString() },
  });

  if (current.deal.status === 'awaiting_confirmation') {
    let proposal: TimeProposal | null = null;
    const result = await runTransition(
      {
        publicId,
        action: 'request_changes',
        actor,
        mutate: async ({ c, deal }) => {
          proposal = await record(c, deal);
          return {
            events: [{ type: 'version.change_requested', payload: { text: a.text, proposal_id: proposal.id } }, proposedEvent(proposal)],
          };
        },
      },
      now,
    );
    return { result, proposal: proposal! };
  }

  return inTx(async (c) => {
    const deal = await dealsRepo.lockByPublicId(c, publicId);
    if (!deal) throw new NotFoundError(`сделка ${publicId}`);
    assertParticipant(deal, actor);
    if (deal.status !== 'changes_requested') throw new InvalidTransition(deal.status, 'request_changes', 'client', 'forbidden');
    const proposal = await record(c, deal);
    const event = await eventsRepo.append(c, { dealId: deal.id, actorUserId: actor.userId, actorRole: actorRoleFor(deal, actor), ...proposedEvent(proposal) });
    const bundle = await loadBundle(c, deal);
    return { result: { bundle, previousStatus: deal.status, statusChanged: false, events: [event], alreadyDone: false }, proposal };
  });
}

export type AcceptTimeOutcome =
  | { kind: 'accepted'; result: ServiceResult }
  /** время уже занято другой записью: предложение снято */
  | { kind: 'taken'; bundle: DealBundle; proposal: TimeProposal }
  /** предложение устарело: другое предложение, новая версия, сделка ушла дальше или время уже прошло */
  | { kind: 'stale'; bundle: DealBundle };

/**
 * Исполнитель принимает предложенное время одной кнопкой: новая версия условий тем же T5, остальные условия прежние.
 * Принятия одного исполнителя идут строго по очереди (блокировка его строки `users`): второе видит удержание первого
 * и получает «время уже занято» — так закрыта гонка «два клиента на одно время».
 */
export async function acceptTimeProposal(
  publicId: string,
  actor: Actor,
  proposalId: number,
  tz: string,
  now = new Date(),
): Promise<AcceptTimeOutcome> {
  return inTx(async (c) => {
    const found = await dealsRepo.byPublicId(c, publicId);
    if (!found) throw new NotFoundError(`сделка ${publicId}`);
    assertParticipant(found, actor);
    if (actor.role !== 'seller') throw new ForbiddenError('время принимает исполнитель');
    // FOR NO KEY UPDATE, а не FOR UPDATE: версия пишется своей транзакцией, и её проверка внешнего ключа на users
    // (FOR KEY SHARE) не должна ждать эту блокировку — иначе взаимная блокировка. Принятия между собой всё равно по очереди.
    await c.query('SELECT 1 FROM users WHERE max_user_id = $1 FOR NO KEY UPDATE', [found.sellerUserId]);

    const deal = (await dealsRepo.byId(c, found.id))!;
    const proposal = await proposalsRepo.byId(c, proposalId);
    if (!proposal || proposal.dealId !== deal.id) throw new NotFoundError(`предложение ${proposalId}`);
    const stale = proposal.status !== 'pending' || deal.currentVersion !== proposal.baseVersion || !EDITABLE_STATUSES.includes(deal.status);
    if (stale) return { kind: 'stale', bundle: await loadBundle(c, deal) };

    const slot = await checkSlot(c, { sellerUserId: deal.sellerUserId, dealId: deal.id, start: proposal.scheduledAt, durationMin: deal.durationMin, now, tz });
    if (slot === 'off_grid') return { kind: 'stale', bundle: await loadBundle(c, deal) };
    if (slot === 'busy') {
      await proposalsRepo.resolve(c, proposal.id, 'taken', now);
      return { kind: 'taken', bundle: await loadBundle(c, deal), proposal };
    }

    const version = await versionsRepo.byVersion(c, deal.id, deal.currentVersion);
    if (!version) throw new Error(`у сделки ${deal.publicId} нет версии ${deal.currentVersion}`);
    // Версия пишется своей транзакцией (тот же T5, что из формы); блокировка исполнителя держится до её конца.
    const result = await newVersion(
      publicId,
      actor,
      {
        title: version.title,
        description: version.description,
        scheduledAt: proposal.scheduledAt,
        totalKopecks: version.totalKopecks,
        prepaymentKopecks: version.prepaymentKopecks,
        cancelRule: version.cancelRule,
        acceptProposalId: proposal.id,
      },
      now,
    );
    return { kind: 'accepted', result };
  });
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
 * (SPEC §5.2 T11: «если сразу paid — выполняются эффекты T14»), а при tax_mode='none' — ещё и T15:
 * его доводит finishIfNoReceiptNeeded отдельной транзакцией со своим событием и перепланированием.
 */
export async function accept(publicId: string, actor: Actor, now = new Date()): Promise<ServiceResult> {
  const accepted = await runTransition(
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
  return finishIfNoReceiptNeeded(accepted, now);
}

// ─────────────────────── T9, T14: деньги пришли (system) ───────────────────────

/**
 * Платёж подтверждён: вебхуком, опросом, кнопкой «Проверить оплату» или «Получил(а)».
 * Идемпотентно: сделка уже сдвинута (или ушла дальше) — alreadyDone без побочных эффектов, поэтому
 * вызывать можно при каждом применении succeeded — так самовосстанавливается «платёж succeeded, а сделка
 * не сдвинулась» после падения между транзакциями (ЗАДАЧА_03 F4).
 * При tax_mode='none' сделка после T14 сразу закрывается (T15) — на любом пути подтверждения (F5);
 * результат несёт события обоих переходов, транспорт по deal.closed отправляет квитанцию.
 */
export async function applyPaymentSucceeded(
  args: { dealId: number; paymentId: number; kind: 'prepayment' | 'final' },
  now = new Date(),
): Promise<ServiceResult> {
  const moved = await runTransition(
    {
      dealId: args.dealId,
      action: args.kind === 'prepayment' ? 'prepayment_succeeded' : 'final_succeeded',
      actor: { userId: 0, role: 'seller' },
      system: true,
      idempotentIfMoved: true,
      mutate: async ({ now: at, to }) => ({
        patch: to === 'paid' ? { paidAt: at } : {},
        events: [{ type: 'payment.succeeded', payload: { kind: args.kind, payment_id: args.paymentId } }],
      }),
    },
    now,
  );
  return finishIfNoReceiptNeeded(moved, now);
}

/**
 * T14 → T15 (SPEC §5.2): при tax_mode='none' чек не нужен — полностью оплаченная сделка закрывается сразу.
 * Сделка уже `paid` от прошлого раза (процесс упал между переходами) — тоже закрываем: это та же цепочка.
 * События обоих переходов объединяются, чтобы вызывающий отправил и N-уведомления, и квитанцию.
 */
async function finishIfNoReceiptNeeded(result: ServiceResult, now: Date): Promise<ServiceResult> {
  if (result.bundle.deal.status !== 'paid' || taxModeOf(result.bundle) !== 'none') return result;
  const closed = await closeAutomatically(result.bundle.deal.id, now);
  return {
    bundle: closed.bundle,
    previousStatus: result.previousStatus,
    statusChanged: result.statusChanged || closed.statusChanged,
    events: [...result.events, ...closed.events],
    alreadyDone: result.alreadyDone && closed.alreadyDone,
  };
}

/** T15 при tax_mode='none': чек не нужен, закрываем сразу после полной оплаты. */
async function closeAutomatically(dealId: number, now: Date): Promise<ServiceResult> {
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
        const byRule = refundExpected({
          cancelRule: version.cancelRule,
          cancelledBy: a.role,
          scheduledAt: version.scheduledAt,
          prepaymentSucceeded,
          now: at,
        });
        // Клиент сообщил о переводе, а исполнитель ещё не подтвердил: деньги могли прийти, продукт этого не видит.
        // Возврат ожидается в любом случае, а обе стороны получают предупреждение сверить поступление (ЗАДАЧА_03 F7).
        const claimed = payments.find((p) => p.rail === 'transfer' && p.status === 'claimed') ?? null;
        const expected = claimed ? true : byRule;
        // Живые платежи помечаем отменёнными локально: у провайдера ссылка просто истечёт (SPEC §5.2 T16).
        for (const p of payments) {
          if (p.status === 'pending' || p.status === 'claimed') {
            await paymentsRepo.update(c, p.id, {
              status: 'canceled',
              canceledAt: at,
              ...(p.status === 'claimed' ? { cancellationReason: CANCELLED_AFTER_CLAIM } : {}),
            });
          }
        }
        const claimedTransfer = claimed
          ? { payment_id: claimed.id, kind: claimed.kind, amount: claimed.amountKopecks, claimed_at: claimed.claimedAt?.toISOString() ?? null }
          : null;
        return {
          patch: { cancelledAt: at, cancelledByRole: a.role, cancelReason: reason, cancelRefundExpected: expected },
          events: [
            {
              type: 'deal.cancelled',
              payload: { by: a.role, reason, refund_expected: expected, ...(claimedTransfer ? { claimed_transfer: claimedTransfer } : {}) },
            },
          ],
        };
      },
    },
    now,
  );
}

// ─────────────────────── возврат после отмены (SPEC §5.3, ЗАДАЧА_03 H1) ───────────────────────

/**
 * «✅ Вернул(а)» (исполнитель) и «✅ Возврат получил(а)» (клиент) у отменённой сделки с ожидаемым возвратом.
 * Статус не меняется (машина состояний тут ни при чём) — фиксируется факт: время в сделке и событие
 * refund.confirmed {by}. Повторное нажатие — «уже сделано». Напоминание refund_due перепланируется.
 */
export async function confirmRefund(publicId: string, actor: Actor, now = new Date()): Promise<ServiceResult> {
  return inTx(async (c) => {
    const deal = await dealsRepo.lockByPublicId(c, publicId);
    if (!deal) throw new NotFoundError(`сделка ${publicId}`);
    assertParticipant(deal, actor);
    if (deal.status !== 'cancelled' || deal.cancelRefundExpected !== true) {
      throw new InvalidTransition(deal.status, 'cancel', actor.role, 'forbidden');
    }
    const field = actor.role === 'seller' ? 'refundSentAt' : 'refundReceivedAt';
    if (deal[field]) {
      const bundle = await loadBundle(c, deal);
      return { bundle, previousStatus: deal.status, statusChanged: false, events: [], alreadyDone: true };
    }
    const updated = await dealsRepo.update(c, deal.id, { [field]: now });
    const event = await eventsRepo.append(c, {
      dealId: deal.id,
      type: 'refund.confirmed',
      actorUserId: actor.userId,
      actorRole: actorRoleFor(deal, actor),
      payload: { by: actor.role },
    });
    const bundle = await loadBundle(c, updated);
    await replanReminders(c, bundle, now);
    log.info({ deal: deal.publicId, by: actor.role }, 'возврат отмечен');
    return { bundle, previousStatus: deal.status, statusChanged: false, events: [event], alreadyDone: false };
  });
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
