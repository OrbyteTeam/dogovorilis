// HTTP API мини-приложения (SPEC §7.8). Внутренний: авторизация только по initData, внешних потребителей нет.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cfg } from '../../../config.js';
import { inTx } from '../../../db/pool.js';
import * as usersRepo from '../../../db/repos/users.js';
import { AppError, UnauthorizedError, ValidationError } from '../../../errors.js';
import type { MaxGateway } from '../../../integrations/max/gateway.js';
import { log } from '../../../logger.js';
import type { User } from '../../../types.js';
import { rublesToKopecks } from '../../../domain/money.js';
import { templateByKey } from '../../../domain/templates.js';
import * as dealService from '../../../domain/deal/service.js';
import { sendCard } from '../../bot/cards.js';
import { verifyInitData } from '../auth.js';
import { createDealSchema, profileSchema } from '../schemas.js';
import { dealView, profileView, shareText, templatesView, userView } from '../views.js';

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

export type ApiDeps = { max: MaxGateway | null };

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    try {
      const user = await authenticate(req);
      if (rateLimited(user.maxUserId)) return fail(reply, 429, 'rate_limited', 'Слишком много запросов, попробуйте через минуту');
      (req as AuthedRequest).appUser = user;
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/me', async (req) => {
    const user = me(req);
    const profile = await inTx((c) => usersRepo.getProfile(c, user.maxUserId));
    const c = cfg();
    return {
      user: userView(user),
      profile: profileView(profile),
      config: { provider: c.PAYMENT_PROVIDER, demo: c.DEMO_MODE, bot_username: c.MAX_BOT_USERNAME || 'bot' },
    };
  });

  app.get('/api/templates', async () => ({ items: templatesView() }));

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
      }),
    );
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
        }),
      );
    }

    if (!templateByKey(body.template)) return fail(reply, 400, 'validation', 'Неизвестный шаблон');

    try {
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
      });

      // Карточку отправляем в чат исполнителя; если он ещё не нажимал «Начать», диалога нет — сообщаем это экрану «Готово».
      let cardSent = false;
      if (deps.max && user.dialogChatId) {
        const mid = await sendCard(deps.max, result.bundle, 'seller', { userId: user.maxUserId, chatId: user.dialogChatId });
        cardSent = mid !== null;
      }
      return {
        deal: dealView(result.bundle),
        link: dealView(result.bundle).link,
        share_text: shareText(result.bundle),
        card_sent: cardSent,
      };
    } catch (e) {
      return sendError(reply, e);
    }
  });
}

// ─────────────────────────── авторизация и ошибки ───────────────────────────

type AuthedRequest = FastifyRequest & { appUser?: User };

function me(req: FastifyRequest): User {
  const user = (req as AuthedRequest).appUser;
  if (!user) throw new UnauthorizedError('запрос без проверенного пользователя');
  return user;
}

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

function firstIssue(issues: { message: string; path: (string | number | symbol)[] }[]): string {
  const i = issues[0];
  return i ? i.message : 'Проверьте заполнение полей';
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  reply.code(status);
  return { error: { code, message } };
}

function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof UnauthorizedError) return fail(reply, 401, e.code, 'Откройте мини-приложение внутри MAX');
  if (e instanceof ValidationError) return fail(reply, 400, 'validation', e.message);
  if (e instanceof AppError) {
    const status = e.code === 'forbidden' ? 403 : e.code === 'deal_not_found' ? 404 : e.code === 'invalid_transition' ? 409 : 500;
    return fail(reply, status, e.code, status === 500 ? 'Внутренняя ошибка, попробуйте позже' : e.message);
  }
  log.error({ err: (e as Error).message }, 'API: необработанная ошибка');
  return fail(reply, 500, 'internal', 'Внутренняя ошибка, попробуйте позже');
}
