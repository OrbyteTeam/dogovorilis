// Уведомления второй стороне (SPEC §6.5). Правило: событие домена → сообщение N1–N15.
// Отдельное сообщение нужно затем, что правка карточки на месте не даёт push-уведомления (SPEC §19).
// В демо-режиме оба уведомления приходят в один чат с префиксом «🧪 (клиенту)» / «🧪 (исполнителю)» (§12).
import { cfg } from '../../config.js';
import { inTx } from '../../db/pool.js';
import * as eventsRepo from '../../db/repos/events.js';
import * as usersRepo from '../../db/repos/users.js';
import type { AttachmentRequest, MaxGateway } from '../../integrations/max/gateway.js';
import { log } from '../../logger.js';
import * as texts from '../../texts.js';
import { claimedTransferAtCancel, livePayment, remaining, TERMS_FIELDS, type DealBundle, type DealEvent, type TermsField } from '../../types.js';
import { receiptDeadline } from '../../domain/time.js';
import { taxModeOf } from '../../domain/deal/service.js';
import { displayName, refundLinesFor } from './cards.js';
import { n11Keyboard, n13Keyboard, n3Keyboard, n3tKeyboard, newDealKeyboard, openKeyboard } from './keyboards.js';

type Side = 'seller' | 'client';

type Notice = { to: Side; text: string; keyboard?: AttachmentRequest };

/** Как называть клиента в текстах второй стороне: в демо — «демо-клиент», до входа по ссылке — «клиент». */
export function clientName(bundle: DealBundle): string {
  if (bundle.deal.demo) return 'демо-клиент';
  return bundle.client ? displayName(bundle.client.firstName, bundle.client.lastName) : 'клиент';
}

/** Что отправить по каждому событию. Пустой массив — событие уведомления не порождает. */
export function noticesFor(bundle: DealBundle, event: DealEvent): Notice[] {
  const id = bundle.deal.publicId;
  const client = clientName(bundle);

  switch (event.type) {
    case 'client.joined':
      return [{ to: 'seller', text: texts.N1({ client, id }), keyboard: openKeyboard(id) }];

    case 'version.confirmed':
      return [
        {
          to: 'seller',
          text: texts.N2({
            client,
            id,
            prepaymentKopecks: bundle.version.prepaymentKopecks,
            scheduledAt: bundle.version.scheduledAt,
          }),
          keyboard: openKeyboard(id),
        },
      ];

    case 'version.change_requested':
      // Время из календаря (ЗАДАЧА_08 D) уведомляется своим N3T по событию time.proposed — без дубля N3.
      if (event.payload.proposal_id !== undefined) return [];
      return [
        {
          to: 'seller',
          text: texts.N3({ client, id, text: String(event.payload.text ?? '') }),
          keyboard: n3Keyboard(id),
        },
      ];

    case 'version.created': {
      if (event.payload.kept_as_is) return [{ to: 'client', text: texts.N5({ id }), keyboard: openKeyboard(id) }];
      // N4 перечисляет только изменившиеся поля (T5); значения — из новой версии, она уже текущая.
      const changed = Array.isArray(event.payload.changed)
        ? (event.payload.changed as unknown[]).filter((f): f is TermsField => TERMS_FIELDS.includes(f as TermsField))
        : [];
      const text = texts.N4({ id, version: Number(event.payload.version ?? bundle.deal.currentVersion), changed, terms: bundle.version });
      return [{ to: 'client', text, keyboard: openKeyboard(id) }];
    }

    case 'time.proposed': {
      const proposalId = Number(event.payload.proposal_id);
      const at = new Date(String(event.payload.scheduled_at));
      if (!Number.isFinite(proposalId) || Number.isNaN(at.getTime())) return [];
      return [{ to: 'seller', text: texts.N3T({ client, id, at }), keyboard: n3tKeyboard(id, { id: proposalId, scheduledAt: at }) }];
    }

    case 'deal.declined':
      return [{ to: 'seller', text: texts.N6({ client, id }), keyboard: newDealKeyboard() }];

    // Новую сделку создаёт исполнитель; клиенту кнопка «Новая сделка» ни к чему, ему подсказка в тексте.
    case 'deal.expired':
      return [
        { to: 'seller', text: texts.N7({ id, to: 'seller' }), keyboard: newDealKeyboard() },
        { to: 'client', text: texts.N7({ id, to: 'client' }) },
      ];

    case 'payment.succeeded': {
      const kind = event.payload.kind === 'final' ? 'final' : 'prepayment';
      if (kind === 'prepayment') {
        const p = livePayment(bundle.payments, 'prepayment');
        const n8 = (to: Side) =>
          texts.N8({
            id,
            sumKopecks: p?.amountKopecks ?? bundle.version.prepaymentKopecks,
            rail: p?.rail ?? 'transfer',
            provider: p?.provider ?? 'manual',
            to,
          });
        return [
          { to: 'seller', text: n8('seller'), keyboard: openKeyboard(id) },
          { to: 'client', text: n8('client'), keyboard: openKeyboard(id) },
        ];
      }
      // Остаток пришёл: чек нужен только при npd/ip_kkt; при tax_mode=none сделка закроется сама (T15).
      if (taxModeOf(bundle) === 'none') return [];
      const deadline = receiptDeadline(bundle.deal.paidAt ?? new Date(), cfg().APP_TIMEZONE);
      return [{ to: 'seller', text: texts.N13({ id, deadline }), keyboard: n13Keyboard(id) }];
    }

    case 'payment.succeeded_late': {
      // Поздняя оплата, которую сделка приняла, уведомляется обычным N8/N13 по переходу. Здесь — только
      // оплата, которую сделка принять уже не может: вернуть её может только исполнитель (ЗАДАЧА_03 F1).
      if (!event.payload.refund_required) return [];
      const late = (to: Side) =>
        texts.LATE_PAYMENT_REFUND({
          id,
          sumKopecks: Number(event.payload.amount ?? 0),
          dealCancelled: event.payload.reason === 'deal_cancelled',
          to,
        });
      return [
        { to: 'seller', text: late('seller'), keyboard: openKeyboard(id) },
        { to: 'client', text: late('client'), keyboard: openKeyboard(id) },
      ];
    }

    case 'deal.done':
      return [{ to: 'client', text: texts.N9({ id }), keyboard: openKeyboard(id) }];

    case 'deal.accepted':
      return [
        {
          to: 'seller',
          text: texts.N10({ client, id, remainingKopecks: remaining(bundle.version) }),
          keyboard: openKeyboard(id),
        },
      ];

    case 'deal.remarks':
      return [{ to: 'seller', text: texts.N11({ client, id, text: String(event.payload.text ?? '') }), keyboard: n11Keyboard(id) }];

    case 'deal.fixed':
      return [{ to: 'client', text: texts.N12({ id }), keyboard: openKeyboard(id) }];

    // N14 уходит ОДИН раз — подписью к квитанции PDF (transport/bot/receipt.ts), после пересланного чека.
    // Отдельным сообщением отсюда он дублировался и говорил «чек — выше» раньше, чем чек был переслан
    // (найдено прогоном 1, S7). Все пути закрытия сделки отправляют квитанцию.
    case 'deal.closed':
      return [];

    case 'refund.confirmed': {
      const sum = refundSumOf(bundle);
      return event.payload.by === 'seller'
        ? [{ to: 'client', text: texts.REFUND_SENT_NOTICE({ id, sumKopecks: sum }), keyboard: openKeyboard(id) }]
        : [{ to: 'seller', text: texts.REFUND_RECEIVED_NOTICE({ client, id, sumKopecks: sum }), keyboard: openKeyboard(id) }];
    }

    case 'deal.cancelled': {
      const by = (event.payload.by as 'seller' | 'client' | 'system') ?? 'system';
      // Уведомляем другую сторону. В демо обе «стороны» один чат, поэтому отправим оба варианта с префиксами.
      const other: Side = by === 'seller' ? 'client' : 'seller';
      const { refund, claim } = refundLinesFor(bundle, other);
      const text = texts.N15({
        id,
        by,
        reason: (event.payload.reason as string | null) ?? null,
        refundLine: refund,
        claimLine: claim,
      });
      // «Открыть сделку»: в карточке отменённой сделки отметки возврата и квитанция (DESIGN_BRIEF §4, N15).
      const out: Notice[] = [{ to: other, text, keyboard: openKeyboard(id) }];
      // Клиент сообщал о переводе: сверить поступление должны обе стороны, в том числе отменившая (ЗАДАЧА_03 F7).
      const claimed = claim ? claimedTransferAtCancel(bundle.payments) : null;
      if (claimed) {
        const self: Side = other === 'client' ? 'seller' : 'client';
        const text = texts.CLAIM_AFTER_CANCEL({ id, sumKopecks: claimed.amountKopecks, at: claimed.claimedAt, to: self });
        out.push({ to: self, text, keyboard: openKeyboard(id) });
      }
      return out;
    }

    default:
      return [];
  }
}

/** Сумма к возврату: полученная предоплата, иначе заявленный клиентом перевод (отмена при claimed, F7). */
function refundSumOf(bundle: DealBundle): number {
  const received = bundle.payments.find((p) => p.kind === 'prepayment' && p.status === 'succeeded');
  if (received) return received.amountKopecks;
  const claimed = bundle.payments.filter((p) => p.rail === 'transfer' && p.claimedAt).sort((a, b) => b.id - a.id)[0];
  return claimed?.amountKopecks ?? bundle.version.prepaymentKopecks;
}

/** Отправить уведомления по списку событий одного перехода. Возвращает, кому что дошло (T5: `client_notified`). */
export async function notifyForEvents(
  max: MaxGateway,
  bundle: DealBundle,
  events: DealEvent[],
): Promise<Array<{ to: Side; delivered: boolean }>> {
  const out: Array<{ to: Side; delivered: boolean }> = [];
  for (const event of events) {
    for (const notice of noticesFor(bundle, event)) {
      out.push({ to: notice.to, delivered: await deliver(max, bundle, notice) });
    }
  }
  return out;
}

/** Ручное напоминание клиенту (кнопка «Напомнить клиенту», N16). */
export async function notifyManualReminder(max: MaxGateway, bundle: DealBundle, context: string): Promise<boolean> {
  return deliver(max, bundle, { to: 'client', text: texts.N16({ id: bundle.deal.publicId, context }), keyboard: openKeyboard(bundle.deal.publicId) });
}

/**
 * Отправить уведомление стороне. false — писать некуда (нет клиента или диалога с ботом) либо отправка упала.
 * `rethrow` — ошибку отправки не глотать: планировщику напоминаний нужен повтор (SPEC §10.1 «3 попытки»),
 * а «писать некуда» повтором не лечится и по-прежнему возвращает false.
 */
export async function deliver(max: MaxGateway, bundle: DealBundle, notice: Notice, opts?: { rethrow?: boolean }): Promise<boolean> {
  const userId = notice.to === 'seller' ? bundle.deal.sellerUserId : bundle.deal.clientUserId;
  if (!userId) {
    await skip(bundle, notice.to, 'no_client');
    return false;
  }
  const user = await inTx((c) => usersRepo.byId(c, userId));
  if (!user?.dialogChatId) {
    // Бот не может написать первым: пока сторона не открыла диалог, уведомления невозможны (MAX_API §1 п. 5).
    await skip(bundle, notice.to, 'no_chat');
    return false;
  }
  const prefix = bundle.deal.demo ? texts.demoNotifyPrefix(notice.to) : '';
  try {
    await max.send({ chatId: user.dialogChatId }, prefix + notice.text, notice.keyboard ? [notice.keyboard] : undefined);
    return true;
  } catch (e) {
    log.warn({ deal: bundle.deal.publicId, to: notice.to, err: (e as Error).message }, 'уведомление не доставлено');
    if (opts?.rethrow) throw e;
    return false;
  }
}

async function skip(bundle: DealBundle, to: Side, reason: string): Promise<void> {
  log.info({ deal: bundle.deal.publicId, to, reason }, 'уведомление пропущено');
  await inTx((c) =>
    eventsRepo.append(c, {
      dealId: bundle.deal.id,
      type: 'reminder.skipped',
      actorUserId: null,
      actorRole: 'system',
      payload: { to, reason },
    }),
  );
}
