// HTTP API мини-приложения (SPEC §7.8). Внутренний: авторизация только по initData, внешних потребителей нет.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cfg } from '../../../config.js';
import { inTx } from '../../../db/pool.js';
import * as dealsRepo from '../../../db/repos/deals.js';
import * as usersRepo from '../../../db/repos/users.js';
import { AppError, UnauthorizedError } from '../../../errors.js';
import type { MaxGateway } from '../../../integrations/max/gateway.js';
import { log } from '../../../logger.js';
import * as texts from '../../../texts.js';
import type { DealBundle, User } from '../../../types.js';
import { PUBLIC_ID_RE } from '../../../domain/ids.js';
import { rublesToKopecks } from '../../../domain/money.js';
import { templateByKey } from '../../../domain/templates.js';
import * as dealService from '../../../domain/deal/service.js';
import { rescheduleDigest } from '../../../domain/reminder/digest.js';
import { serviceForDeal } from '../../../domain/services.js';
import { sellerReliability } from '../../../domain/ratings.js';
import { displayName, sendCard } from '../../bot/cards.js';
import { publishNewVersion, sendRepeatToClient } from '../../bot/outcome.js';
import { verifyInitData } from '../auth.js';
import { checkedPublicId, fail, firstIssue, me, sendError, viewerRole, type AuthedRequest } from '../common.js';
import { createDealSchema, dealListQuerySchema, profileSchema, updateDealSchema, type CreateDealBody } from '../schemas.js';
import { dealEditView, dealListItemView, dealView, profileView, reliabilityView, shareText, templatesView, userView } from '../views.js';

/** Простой счётчик запросов на пользователя: 60/мин (SPEC §17). */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<number, { count: number; resetAt: number }>();

function rateLimited(userId: number): boolean {
  const now = Date.now();
  const entry = hits.get(userId);
  if (!entry || entry.resetAt <= now) {
    hits.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

class RateLimitedError extends AppError {
  constructor() {
    super('rate_limited', 'Слишком много запросов, попробуйте через минуту');
  }
}

export type ApiDeps = { max: MaxGateway | null };

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  // Возврат значения из onRequest-хука НЕ завершает запрос (нужен reply.send или исключение),
  // поэтому хук бросает типизированную ошибку, а формат ответа задаёт errorHandler в server.ts.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const user = await authenticate(req);
    if (rateLimited(user.maxUserId)) throw new RateLimitedError();
    (req as AuthedRequest).appUser = user;
  });

  app.get('/api/me', async (req) => {
    const user = me(req);
    const profile = await inTx((c) => usersRepo.getProfile(c, user.maxUserId));
    const c = cfg();
    // Надёжность — исполнителю с профилем (ЗАДАЧА_08 E, SPEC §7.11): «Настройки» показывают её всегда, клиентам — по переключателю.
    const reliability = profile ? reliabilityView(await sellerReliability(user.maxUserId, c.APP_TIMEZONE)) : null;
    return {
      user: userView(user),
      profile: profileView(profile),
      reliability,
      config: { provider: c.PAYMENT_PROVIDER, demo: c.DEMO_MODE, bot_username: c.MAX_BOT_USERNAME || 'bot' },
    };
  });

  app.get('/api/templates', async () => ({ items: templatesView() }));

  app.get('/api/deals', async (req, reply) => {
    const user = me(req);
    const parsed = dealListQuerySchema.safeParse(req.query);
    if (!parsed.success) return fail(reply, 400, 'validation', firstIssue(parsed.error.issues));
    // Расписание группирует сделки по дням на клиенте — отдаём до 200 строк (ЗАДАЧА_04 C3).
    const items = await inTx((c) => dealsRepo.listItemsForUser(c, user.maxUserId, { ...parsed.data, limit: 200 }));
    return { items: items.map(dealListItemView) };
  });

  // Карточка сделки для форм правки и повтора — только участнику (SPEC §7.8).
  app.get<{ Params: { publicId: string } }>('/api/deals/:publicId', async (req, reply) => {
    const user = me(req);
    try {
      const bundle = await dealService.getBundle(checkedPublicId(req.params.publicId));
      return dealEditView(bundle, viewerRole(bundle, user.maxUserId));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // T5: новая версия условий — только исполнитель, только до подтверждения клиентом (SPEC §5.2, §7.8).
  app.put<{ Params: { publicId: string } }>('/api/deals/:publicId', async (req, reply) => {
    const user = me(req);
    const parsed = updateDealSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'validation', firstIssue(parsed.error.issues));
    try {
      const actor = { userId: user.maxUserId, role: 'seller' as const };
      const service = await serviceOf(user.maxUserId, parsed.data.service_id);
      const result = await dealService.newVersion(checkedPublicId(req.params.publicId), actor, { ...termsOf(parsed.data), service });
      const { clientNotified } = deps.max ? await publishNewVersion(deps.max, result) : { clientNotified: false };
      return { deal: dealView(result.bundle), version: result.bundle.deal.currentVersion, client_notified: clientNotified };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.put('/api/me/profile', async (req, reply) => {
    const user = me(req);
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'validation', firstIssue(parsed.error.issues));
    const profile = await inTx((c) =>
      usersRepo.upsertProfile(c, {
        userId: user.maxUserId,
        displayName: parsed.data.display_name,
        taxMode: parsed.data.tax_mode,
        payoutDetails: parsed.data.payout_details ?? null,
        transferEnabled: parsed.data.transfer_enabled,
        linkEnabled: parsed.data.link_enabled,
        defaultCancelRule: parsed.data.default_cancel_rule,
        digestTime: parsed.data.digest_time,
        showReliability: parsed.data.show_reliability,
      }),
    );
    // Сменили время сводки — сегодняшняя переносится или гасится (ЗАДАЧА_04 B2); нет поля — сводку не трогаем.
    if (parsed.data.digest_time !== undefined) {
      await rescheduleDigest(user.maxUserId, parsed.data.digest_time, new Date(), cfg().APP_TIMEZONE);
    }
    return { profile: profileView(profile) };
  });

  app.post('/api/deals', async (req, reply) => {
    const user = me(req);
    const parsed = createDealSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'validation', firstIssue(parsed.error.issues));
    const body = parsed.data;

    let profile = await inTx((c) => usersRepo.getProfile(c, user.maxUserId));
    if (!profile) {
      if (!body.profile) return fail(reply, 400, 'validation', 'Заполните, как вас подписать в карточке');
      profile = await inTx((c) =>
        usersRepo.upsertProfile(c, {
          userId: user.maxUserId,
          displayName: body.profile!.display_name,
          taxMode: body.profile!.tax_mode,
          payoutDetails: body.profile!.payout_details ?? null,
          transferEnabled: body.profile!.transfer_enabled,
          linkEnabled: body.profile!.link_enabled,
          defaultCancelRule: body.profile!.default_cancel_rule,
          digestTime: body.profile!.digest_time,
        }),
      );
    }

    if (!templateByKey(body.template)) return fail(reply, 400, 'validation', 'Неизвестный шаблон');

    try {
      // «🔁 Повторить» (ЗАДАЧА_04 F): своя сделка, не демо; «тот же клиент» — сразу с ним, если у него есть диалог.
      const repeat = body.repeat_of ? await dealService.resolveRepeat(user.maxUserId, body.repeat_of, body.same_client === true) : null;
      const service = await serviceOf(user.maxUserId, body.service_id);
      const result = await dealService.createDeal({
        sellerUserId: user.maxUserId,
        template: body.template,
        title: body.title,
        description: body.description ?? null,
        scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : null,
        totalKopecks: rublesToKopecks(body.total_rub),
        prepaymentKopecks: rublesToKopecks(body.prepayment_rub),
        cancelRule: body.cancel_rule,
        photoMaxToken: body.photo_max_token ?? null,
        clientUserId: repeat?.attachClientId ?? undefined,
        repeatOf: body.repeat_of,
        service: service ?? null,
      });

      // Карточку отправляем в чат исполнителя; если он ещё не нажимал «Начать», диалога нет — сообщаем это экрану «Готово».
      let cardSent = false;
      if (deps.max && user.dialogChatId) {
        const mid = await sendCard(deps.max, result.bundle, 'seller', { userId: user.maxUserId, chatId: user.dialogChatId });
        cardSent = mid !== null;
      }
      const clientCardSent = deps.max && repeat?.attachClientId ? await sendRepeatToClient(deps.max, result.bundle) : false;
      return {
        deal: dealView(result.bundle),
        link: dealView(result.bundle).link,
        share_text: shareText(result.bundle),
        card_sent: cardSent,
        client_card_sent: clientCardSent,
        client: repeat?.client ? { name: displayName(repeat.client.firstName, repeat.client.lastName) } : null,
        client_no_dialog: repeat?.clientNoDialog ?? false,
      };
    } catch (e) {
      return sendError(reply, e);
    }
  });
}

export { RateLimitedError };

// ─────────────────────────── авторизация ───────────────────────────

async function authenticate(req: FastifyRequest): Promise<User> {
  const c = cfg();
  const initData = req.headers['x-max-init-data'];

  // Разработка мини-приложения в браузере без Bridge: подмена пользователя разрешена только в development (SPEC §4.3).
  if (!initData && c.isDevelopment && c.devFakeUserId) {
    const user = await inTx((cl) =>
      usersRepo.upsertFromMax(cl, { maxUserId: c.devFakeUserId!, firstName: 'Разработчик', lastName: null, username: null }),
    );
    log.warn({ user: user.maxUserId }, 'API: использована dev-подмена пользователя (DEV_FAKE_USER_ID)');
    return user;
  }

  if (typeof initData !== 'string' || !initData) throw new UnauthorizedError('нет заголовка X-Max-Init-Data');
  const payload = verifyInitData(initData, c.MAX_BOT_TOKEN);
  return inTx((cl) =>
    usersRepo.upsertFromMax(cl, {
      maxUserId: payload.user.id,
      firstName: payload.user.firstName,
      lastName: payload.user.lastName,
      username: payload.user.username,
      locale: payload.user.languageCode,
    }),
  );
}

/**
 * Услуга из формы (ЗАДАЧА_08 C): только своя (в т. ч. скрытая — «Повторить»), чужая — 404 через NotFoundError.
 * undefined — поля в запросе нет (при правке: не менять), null — без услуги.
 */
async function serviceOf(sellerUserId: number, id: number | null | undefined): Promise<{ id: number; durationMin: number } | null | undefined> {
  if (id === undefined || id === null) return id;
  const s = await serviceForDeal(sellerUserId, id);
  return { id: s.id, durationMin: s.durationMin };
}

/** Тело формы → условия новой версии (рубли → копейки); пустые «Уточнения» — null. */
function termsOf(body: Omit<CreateDealBody, 'template'>): dealService.NewVersionInput {
  return {
    title: body.title,
    description: body.description ?? null,
    scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : null,
    totalKopecks: rublesToKopecks(body.total_rub),
    prepaymentKopecks: rublesToKopecks(body.prepayment_rub),
    cancelRule: body.cancel_rule,
    photoMaxToken: body.photo_max_token,
  };
}

