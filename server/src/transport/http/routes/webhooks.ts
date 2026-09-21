// Вебхуки платёжных провайдеров (SPEC §9.2, §9.6; CONTRACTS §2.5).
//
// Главное правило ЮKassa: подписи у уведомлений нет, поэтому телу уведомления мы не верим.
// Принять → записать доставку → ответить 200 → и только потом спросить GET /v3/payments/{id}
// и применить статус **из GET**. IP-фильтр — предупреждение в лог, а не отказ: источник истины GET,
// и ложное срабатывание (новая подсеть провайдера) не должно стоить нам пропущенной оплаты.
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { inTx } from '../../../db/pool.js';
import * as paymentsRepo from '../../../db/repos/payments.js';
import * as webhooksRepo from '../../../db/repos/webhooks.js';
import { log } from '../../../logger.js';
import type { MaxGateway } from '../../../integrations/max/gateway.js';
import * as rails from '../../../domain/payment/rails.js';
import * as dealService from '../../../domain/deal/service.js';
import { syncCards } from '../../bot/cards.js';
import { notifyForEvents } from '../../bot/notify.js';

/** CONTRACTS §2.5 — дословный список сетей ЮKassa. */
export const YOOKASSA_NETWORKS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11',
  '77.75.156.35',
  '77.75.154.128/25',
  '2a02:5180::/32',
] as const;

type Notification = { type?: string; event?: string; object?: { id?: string; status?: string } };

export function registerWebhooks(app: FastifyInstance, deps: { max: MaxGateway | null }): void {
  app.post('/webhooks/yookassa', async (req, reply) => {
    const body = req.body as Notification | null;
    const externalId = typeof body?.object?.id === 'string' ? body.object.id : null;
    // Идемпотентность по (provider, external_id, event) — колонку provider_status в схеме
    // заменяет `event`, договорённость зафиксирована в docs/ДОПУЩЕНИЯ.md.
    const event = typeof body?.event === 'string' ? body.event : null;

    const logId = await inTx((c) => webhooksRepo.record(c, { provider: 'yookassa', externalId, event, payload: body })).catch(
      (e: Error) => {
        log.error({ err: e.message }, 'вебхук ЮKassa: не удалось записать доставку');
        return null;
      },
    );

    if (!ipAllowed(req.ip)) {
      // Не отказ: GET у провайдера всё равно скажет правду (SPEC §9.2).
      log.warn({ ip: req.ip, provider: 'yookassa' }, 'вебхук ЮKassa: IP вне списка провайдера');
    }

    // Отвечаем немедленно: у ЮKassa на ответ 30 секунд, а GET + переход сделки могут занять дольше.
    reply.code(200).send({ ok: true });

    if (!externalId || !event) {
      if (logId) await mark(logId, 'ignored:malformed');
      return reply;
    }
    setImmediate(() => void handle({ externalId, event, logId, max: deps.max }));
    return reply;
  });
}

async function handle(a: { externalId: string; event: string; logId: number | null; max: MaxGateway | null }): Promise<void> {
  try {
    const duplicate = await inTx((c) => webhooksRepo.alreadyProcessed(c, 'yookassa', a.externalId, a.event));
    if (duplicate) {
      await mark(a.logId, 'ignored:duplicate');
      return;
    }

    const payment = await inTx((c) => paymentsRepo.byProviderPaymentId(c, 'yookassa', a.externalId));
    if (!payment) {
      // Уведомление от другого магазина или платёж, которого у нас нет (SPEC §14 п. 3).
      await mark(a.logId, 'ignored:foreign');
      log.warn({ provider: 'yookassa', external: a.externalId }, 'вебхук ЮKassa: платёж не наш');
      return;
    }

    // Источник истины — GET, а не тело уведомления (CONTRACTS §2.5, последний абзац).
    const fresh = await rails.yookassa().getPayment(a.externalId);
    if (fresh.metadata?.deal) {
      const bundle = await dealService.getBundleById(payment.dealId);
      if (fresh.metadata.deal !== bundle.deal.publicId) {
        await mark(a.logId, 'ignored:foreign');
        log.warn({ provider: 'yookassa', external: a.externalId }, 'вебхук ЮKassa: metadata.deal не совпадает со сделкой платежа');
        return;
      }
    }

    const result = await rails.applyProviderStatus(payment.id, rails.outcomeOf(fresh));
    await mark(a.logId, result.changed ? 'ok' : 'ignored:no_change');

    if (!a.max) return;
    if (result.transition) {
      await syncCards(a.max, result.transition.bundle);
      await notifyForEvents(a.max, result.transition.bundle, result.transition.events);
      return;
    }
    if (result.changed) {
      // Отмена провайдером: перехода сделки нет, но карточка обязана это показать.
      await syncCards(a.max, await dealService.getBundleById(payment.dealId));
    }
  } catch (e) {
    // Ошибка не считается обработкой: ЮKassa повторит доставку, и alreadyProcessed её пропустит дальше.
    await mark(a.logId, `error:${(e as Error).message}`.slice(0, 500));
    log.error({ err: (e as Error).message, external: a.externalId }, 'вебхук ЮKassa: обработка упала');
  }
}

async function mark(logId: number | null, result: string): Promise<void> {
  if (logId === null) return;
  await inTx((c) => webhooksRepo.markResult(c, logId, result)).catch((e: Error) =>
    log.warn({ err: e.message }, 'вебхук: не удалось записать result'),
  );
}

/** Проверка IP по списку сетей провайдера. Fastify отдаёт req.ip уже с учётом trustProxy. */
export function ipAllowed(ip: string, networks: readonly string[] = YOOKASSA_NETWORKS): boolean {
  const addr = normalize(ip);
  if (!addr) return false;
  return networks.some((n) => inNetwork(addr, n));
}

/** ::ffff:1.2.3.4 → 1.2.3.4; всё нераспознанное → null. */
function normalize(ip: string): string | null {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = v4mapped ? v4mapped[1] : ip;
  return isIP(addr) ? addr : null;
}

function inNetwork(addr: string, network: string): boolean {
  const [base, bitsRaw] = network.split('/');
  if (isIP(base) !== isIP(addr)) return false;
  const a = toBits(addr);
  const b = toBits(base);
  if (!a || !b) return false;
  const bits = bitsRaw === undefined ? a.length : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > a.length) return false;
  return a.slice(0, bits) === b.slice(0, bits);
}

/** Адрес → строка битов; сравнение префиксов по строке проще и безопаснее арифметики на 128 битах. */
function toBits(addr: string): string | null {
  if (isIP(addr) === 4) {
    return addr
      .split('.')
      .map((o) => Number(o).toString(2).padStart(8, '0'))
      .join('');
  }
  if (isIP(addr) !== 6) return null;
  const groups = expandV6(addr);
  if (!groups) return null;
  return groups.map((g) => g.toString(2).padStart(16, '0')).join('');
}

function expandV6(addr: string): number[] | null {
  const [headRaw, tailRaw] = addr.split('::');
  const head = headRaw ? headRaw.split(':').filter(Boolean) : [];
  const tail = tailRaw !== undefined ? (tailRaw ? tailRaw.split(':').filter(Boolean) : []) : null;
  const parts = tail === null ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => parseInt(p, 16));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}
