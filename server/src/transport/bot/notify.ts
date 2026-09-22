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
import { livePayment, remaining, type DealBundle, type DealEvent } from '../../types.js';
import { receiptDeadline } from '../../domain/time.js';
import { taxModeOf } from '../../domain/deal/service.js';
import { displayName } from './cards.js';
import { n11Keyboard, n13Keyboard, n3Keyboard, openKeyboard } from './keyboards.js';

type Side = 'seller' | 'client';

type Notice = { to: Side; text: string; keyboard?: AttachmentRequest };

function clientName(bundle: DealBundle): string {
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
      return [
        {
          to: 'seller',
          text: texts.N3({ client, id, text: String(event.payload.text ?? '') }),
          keyboard: n3Keyboard(id),
        },
      ];

    case 'version.created':
      return event.payload.kept_as_is
        ? [{ to: 'client', text: texts.N5({ id }), keyboard: openKeyboard(id) }]
        : [{ to: 'client', text: texts.N4({ id, version: Number(event.payload.version ?? bundle.deal.currentVersion) }), keyboard: openKeyboard(id) }];

    case 'deal.declined':
      return [{ to: 'seller', text: texts.N6({ client, id }) }];

    case 'deal.expired':
      return [
        { to: 'seller', text: texts.N7({ id }) },
        { to: 'client', text: texts.N7({ id }) },
      ];

    case 'payment.succeeded': {
      const kind = event.payload.kind === 'final' ? 'final' : 'prepayment';
      if (kind === 'prepayment') {
        const p = livePayment(bundle.payments, 'prepayment');
        const text = texts.N8({
          id,
          sumKopecks: p?.amountKopecks ?? bundle.version.prepaymentKopecks,
          rail: p?.rail ?? 'transfer',
          provider: p?.provider ?? 'manual',
        });
        return [
          { to: 'seller', text, keyboard: openKeyboard(id) },
          { to: 'client', text, keyboard: openKeyboard(id) },
        ];
      }
      // Остаток пришёл: чек нужен только при npd/ip_kkt; при tax_mode=none сделка закроется сама (T15).
      if (taxModeOf(bundle) === 'none') return [];
      const deadline = receiptDeadline(bundle.deal.paidAt ?? new Date(), cfg().APP_TIMEZONE);
      return [{ to: 'seller', text: texts.N13({ id, deadline }), keyboard: n13Keyboard(id) }];
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

    case 'deal.closed': {
      const text = texts.N14({ id, withReceipt: Boolean(bundle.receipt) });
      return [
        { to: 'seller', text },
        { to: 'client', text },
      ];
    }

    case 'deal.cancelled': {
      const by = (event.payload.by as 'seller' | 'client' | 'system') ?? 'system';
      const text = texts.N15({
        id,
        by,
        reason: (event.payload.reason as string | null) ?? null,
        refundLine: texts.refundLine({
          prepaymentKopecks: bundle.version.prepaymentKopecks,
          expected: bundle.deal.cancelRefundExpected,
        }),
      });
      // Уведомляем другую сторону. В демо обе «стороны» — один чат, поэтому отправим оба варианта с префиксами.
      const other: Side = by === 'seller' ? 'client' : 'seller';
      return [{ to: other, text }];
    }

    default:
      return [];
  }
}

/** Отправить уведомления по списку событий одного перехода. */
export async function notifyForEvents(max: MaxGateway, bundle: DealBundle, events: DealEvent[]): Promise<void> {
  for (const event of events) {
    for (const notice of noticesFor(bundle, event)) {
      await deliver(max, bundle, notice);
    }
  }
}

/** Ручное напоминание клиенту (кнопка «Напомнить клиенту», N16). */
export async function notifyManualReminder(max: MaxGateway, bundle: DealBundle, context: string): Promise<boolean> {
  return deliver(max, bundle, { to: 'client', text: texts.N16({ id: bundle.deal.publicId, context }), keyboard: openKeyboard(bundle.deal.publicId) });
}

export async function deliver(max: MaxGateway, bundle: DealBundle, notice: Notice): Promise<boolean> {
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
