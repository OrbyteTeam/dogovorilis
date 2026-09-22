// Режим MAX_MODE=webhook: обработчик и подписка MAX (SPEC §4.4 п. 5, CONTRACTS §1.3; ЗАДАЧА_03 часть E).
//
// Подписка живёт всегда:
//   1) обработчик встраивается в Fastify БЕЗ подписки (`webhookCallback`), а подписываемся (`register`) только
//      после `app.listen`. Раньше `createWebhook` подписывал до старта HTTP — первые доставки MAX получали 502;
//   2) сами мы её не снимаем никогда: shutdown не зовёт `stopWebhook` (см. server/src/shutdown.ts);
//   3) сторож (`check`, из тика планировщика раз в 5 минут) возвращает подписку, если её сняли: чужой polling с тем же
//      токеном (SDK при старте polling удаляет ВСЕ подписки) или сам MAX после 8 ч неудачных доставок.
// Чужие подписки этого токена снимаются только при старте — как делал `createWebhook`; свою — никогда.
import { Webhook, type Api, type Bot } from '@maxhub/max-bot-api';
import type { UpdateType } from '@maxhub/max-bot-api/types';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { log } from '../../logger.js';
import { MAX_WEBHOOK_PATH, registerMaxWebhookRoute } from '../http/routes/max-webhook.js';
import { ALLOWED_UPDATES } from './index.js';

/** Как часто сторож сверяет подписку с MAX: тик планировщика — 30 с, столько запросов к MAX не нужно. */
export const SUBSCRIPTION_CHECK_MS = 5 * 60_000;

export type SubscriptionCheck = 'skipped' | 'present' | 'restored' | 'failed';

export interface SubscriptionKeeper {
  /** Наш адрес доставки: https://<host PUBLIC_BASE_URL>/webhooks/max. */
  readonly url: string;
  /** Есть ли наша подписка у MAX по последней проверке; null — ещё не проверяли. Для /readyz. */
  state(): boolean | null;
  /** Старт (после app.listen): снять чужие подписки токена и поставить свою. Не бросает — при сбое вернёт сторож. */
  register(now?: Date): Promise<void>;
  /** Сторож: не чаще раза в SUBSCRIPTION_CHECK_MS — GET /subscriptions, нашей нет → POST. Не бросает. */
  check(now?: Date): Promise<SubscriptionCheck>;
}

type SubscriptionsApi = Pick<Api, 'getSubscriptions' | 'subscribe' | 'unsubscribe'>;

export function createSubscriptionKeeper(
  api: SubscriptionsApi,
  opts: { url: string; secret: string; updateTypes: UpdateType[] },
): SubscriptionKeeper {
  let present: boolean | null = null;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  const subscribe = () => api.subscribe(opts.url, opts.secret || undefined, opts.updateTypes);

  return {
    url: opts.url,
    state: () => present,

    async register(now = new Date()) {
      lastCheckAt = now.getTime();
      try {
        const foreign = (await api.getSubscriptions()).filter((s) => s.url !== opts.url);
        for (const s of foreign) await api.unsubscribe(s.url);
        if (foreign.length) log.warn({ removed: foreign.length }, 'сняты чужие подписки этого токена');
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'не удалось проверить чужие подписки MAX — продолжаем');
      }
      try {
        await subscribe();
        present = true;
        log.info({ url: opts.url }, 'бот: подписка MAX зарегистрирована');
      } catch (e) {
        present = false;
        log.error({ err: (e as Error).message }, 'подписка MAX не зарегистрирована — сторож повторит в течение 5 минут');
      }
    },

    async check(now = new Date()) {
      if (now.getTime() - lastCheckAt < SUBSCRIPTION_CHECK_MS) return 'skipped';
      lastCheckAt = now.getTime();
      try {
        const subs = await api.getSubscriptions();
        if (subs.some((s) => s.url === opts.url)) {
          present = true;
          return 'present';
        }
        present = false;
        await subscribe();
        present = true;
        log.warn({ url: opts.url }, 'подписка MAX восстановлена');
        return 'restored';
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'сторож подписки MAX: проверка не удалась, повтор через 5 минут');
        return 'failed';
      }
    },
  };
}

/**
 * Шаг 1 режима webhook (до app.listen): маршрут POST /webhooks/max с обработчиком SDK — без подписки,
 * без сети. Шаг 2 — `register()` возвращённого сторожа, когда HTTP уже слушает (server/src/index.ts).
 */
export async function mountWebhook(app: FastifyInstance, bot: Bot, config: Config): Promise<SubscriptionKeeper> {
  const domain = new URL(config.PUBLIC_BASE_URL).host;
  const handler = bot.webhookCallback({ domain, path: MAX_WEBHOOK_PATH, secret: config.MAX_WEBHOOK_SECRET });
  await app.register(registerMaxWebhookRoute(handler));
  return createSubscriptionKeeper(bot.api, {
    url: Webhook.getWebhookUrl(domain, MAX_WEBHOOK_PATH), // тот же адрес, что построил бы SDK
    secret: config.MAX_WEBHOOK_SECRET,
    updateTypes: ALLOWED_UPDATES,
  });
}
