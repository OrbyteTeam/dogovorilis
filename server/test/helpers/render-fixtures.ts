// Каталог сделок для рендера карточек и уведомлений во всех статусах (ЗАДАЧА_07, DESIGN_BRIEF §9 п. 3, п. 7).
// Только данные и типы: модуль не трогает БД и конфиг, поэтому его же использует снимок «до/после» для отчёта.
// Время фиксировано: «сейчас» = FIXED_NOW, визит = SCHEDULED (вс 27 сен, 14:00 МСК).
import type {
  CardRole,
  Deal,
  DealBundle,
  DealEvent,
  DealEventType,
  DealStatus,
  DealVersion,
  Payment,
  PaymentKind,
  PaymentProvider,
  PaymentRail,
  PaymentStatus,
  SellerProfile,
  TaxMode,
  User,
} from '../../src/types.js';

export const FIXED_NOW = new Date('2026-09-20T09:00:00Z');
export const SCHEDULED = new Date('2026-09-27T11:00:00Z');
export const PUBLIC_ID = 'K7P2QmX9aB';

const at = (iso: string) => new Date(iso);

const SELLER: User = {
  maxUserId: 1001,
  firstName: 'Анна',
  lastName: 'Аксёнова',
  username: 'anna',
  dialogChatId: 5001,
  locale: 'ru',
  phone: null,
  phoneVerifiedAt: null,
};

const CLIENT: User = {
  maxUserId: 2002,
  firstName: 'Саша',
  lastName: null,
  username: null,
  dialogChatId: 6002,
  locale: 'ru',
  phone: null,
  phoneVerifiedAt: null,
};

function profile(taxMode: TaxMode = 'npd'): SellerProfile {
  return {
    userId: SELLER.maxUserId,
    displayName: 'Анна Аксёнова',
    taxMode,
    payoutDetails: '+7 900 000-00-00, Т-Банк, получатель Анна А.',
    transferEnabled: true,
    linkEnabled: true,
    defaultCancelRule: 'free_24h',
    digestTime: 480,
    showReliability: false,
  };
}

let paymentSeq = 0;

export function payment(a: {
  kind?: PaymentKind;
  rail: PaymentRail;
  provider?: PaymentProvider;
  status: PaymentStatus;
  amountKopecks: number;
  claimedAt?: Date | null;
  succeededAt?: Date | null;
  canceledAt?: Date | null;
  expiresAt?: Date | null;
  cancellationReason?: string | null;
}): Payment {
  paymentSeq += 1;
  const provider = a.provider ?? (a.rail === 'transfer' ? 'manual' : 'yookassa');
  return {
    id: paymentSeq,
    dealId: 1,
    kind: a.kind ?? 'prepayment',
    rail: a.rail,
    provider,
    status: a.status,
    amountKopecks: a.amountKopecks,
    idempotenceKey: `00000000-0000-0000-0000-${String(paymentSeq).padStart(12, '0')}`,
    providerPaymentId: a.rail === 'link' ? `2f${String(paymentSeq).padStart(6, '0')}-000f-5000-9000-1b2c3d4e5f60` : null,
    providerStatus: null,
    confirmationUrl: a.rail === 'link' && a.status === 'pending' ? 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=test' : null,
    qrPayload: null,
    cancellationReason: a.cancellationReason ?? null,
    claimedAt: a.claimedAt ?? null,
    succeededAt: a.succeededAt ?? null,
    canceledAt: a.canceledAt ?? null,
    expiresAt: a.expiresAt ?? null,
    createdAt: at('2026-09-20T08:00:00Z'),
    updatedAt: at('2026-09-20T08:00:00Z'),
  };
}

export type BundleOptions = {
  status: DealStatus;
  client?: boolean;
  demo?: boolean;
  version?: number;
  prepaymentKopecks?: number;
  totalKopecks?: number;
  scheduledAt?: Date | null;
  description?: string | null;
  photo?: boolean;
  payments?: Payment[];
  taxMode?: TaxMode;
  receipt?: boolean;
  cancel?: { by: 'seller' | 'client' | 'system'; reason: string | null; refundExpected: boolean | null; sentAt?: Date | null; receivedAt?: Date | null };
  paidAt?: Date | null;
};

export function bundle(o: BundleOptions): DealBundle {
  const total = o.totalKopecks ?? 300_000;
  const prepayment = o.prepaymentKopecks ?? 90_000;
  const hasClient = o.client ?? true;
  const version: DealVersion = {
    id: 10 + (o.version ?? 1),
    dealId: 1,
    version: o.version ?? 1,
    title: 'Маникюр с покрытием',
    description: o.description === undefined ? 'ул. Ленина 5, материалы мои' : o.description,
    scheduledAt: o.scheduledAt === undefined ? SCHEDULED : o.scheduledAt,
    totalKopecks: total,
    prepaymentKopecks: prepayment,
    cancelRule: 'free_24h',
    photoMaxToken: o.photo ? 'photo-token' : null,
    changeRequestText: null,
    createdByUserId: SELLER.maxUserId,
    createdAt: (o.version ?? 1) > 1 ? at('2026-09-19T07:15:00Z') : at('2026-09-18T09:00:00Z'),
    confirmedAt: null,
    confirmedByUserId: null,
  };
  const deal: Deal = {
    id: 1,
    publicId: PUBLIC_ID,
    sellerUserId: SELLER.maxUserId,
    clientUserId: o.demo ? SELLER.maxUserId : hasClient ? CLIENT.maxUserId : null,
    demo: o.demo ?? false,
    template: 'beauty',
    currentVersion: version.version,
    status: o.status,
    statusChangedAt: at('2026-09-19T10:00:00Z'),
    clientJoinedAt: hasClient ? at('2026-09-18T10:00:00Z') : null,
    confirmedAt: ['awaiting_confirmation', 'changes_requested', 'declined', 'expired'].includes(o.status) ? null : at('2026-09-18T11:00:00Z'),
    doneAt: ['awaiting_acceptance', 'remarks', 'awaiting_payment', 'paid', 'closed'].includes(o.status) ? at('2026-09-27T12:30:00Z') : null,
    acceptedAt: ['awaiting_payment', 'paid', 'closed'].includes(o.status) ? at('2026-09-27T13:00:00Z') : null,
    paidAt: o.paidAt !== undefined ? o.paidAt : ['paid', 'closed'].includes(o.status) ? at('2026-09-27T13:10:00Z') : null,
    closedAt: o.status === 'closed' ? at('2026-09-27T16:40:00Z') : null,
    cancelledAt: o.status === 'cancelled' ? at('2026-09-19T12:05:00Z') : null,
    cancelledByRole: o.cancel?.by ?? null,
    cancelReason: o.cancel?.reason ?? null,
    serviceId: null,
    durationMin: null,
    cancelRefundExpected: o.cancel?.refundExpected ?? null,
    refundSentAt: o.cancel?.sentAt ?? null,
    refundReceivedAt: o.cancel?.receivedAt ?? null,
    expiresAt: at('2026-09-21T09:00:00Z'),
    createdAt: at('2026-09-18T09:00:00Z'),
    updatedAt: at('2026-09-19T10:00:00Z'),
  };
  return {
    deal,
    version,
    payments: o.payments ?? [],
    seller: SELLER,
    sellerProfile: profile(o.taxMode),
    client: o.demo ? SELLER : hasClient ? CLIENT : null,
    receipt: o.receipt
      ? {
          id: 1,
          dealId: 1,
          uploadedByUserId: SELLER.maxUserId,
          attachmentType: 'file',
          maxToken: 'receipt-token',
          maxUrl: null,
          fileName: 'chek.pdf',
          createdAt: at('2026-09-27T16:30:00Z'),
        }
      : null,
  };
}

/** Предоплата 900 ₽ получена по тестовой ссылке ЮKassa. */
export const prepaidByLink = () =>
  payment({ rail: 'link', status: 'succeeded', amountKopecks: 90_000, succeededAt: at('2026-09-18T11:07:00Z') });
/** Предоплата 900 ₽ получена переводом, исполнитель подтвердил. */
export const prepaidByTransfer = () =>
  payment({ rail: 'transfer', status: 'succeeded', amountKopecks: 90_000, claimedAt: at('2026-09-18T11:07:00Z'), succeededAt: at('2026-09-18T11:30:00Z') });
/** Остаток 2 100 ₽ получен по ссылке. */
export const finalByLink = () =>
  payment({ kind: 'final', rail: 'link', status: 'succeeded', amountKopecks: 210_000, succeededAt: at('2026-09-27T13:10:00Z') });

export type CardCase = { id: string; title: string; bundle: DealBundle; roles: CardRole[] };

const BOTH: CardRole[] = ['seller', 'client'];

/** Карточки: 12 статусов и их варианты по платежам, возврату, версии, демо. */
export function cardCases(): CardCase[] {
  paymentSeq = 0;
  return [
    { id: 'awaiting_confirmation-new', title: 'awaiting_confirmation, клиент ещё не открыл ссылку', bundle: bundle({ status: 'awaiting_confirmation', client: false }), roles: ['seller'] },
    { id: 'awaiting_confirmation', title: 'awaiting_confirmation, клиент открыл', bundle: bundle({ status: 'awaiting_confirmation' }), roles: BOTH },
    { id: 'awaiting_confirmation-v2', title: 'awaiting_confirmation, версия 2, есть макет', bundle: bundle({ status: 'awaiting_confirmation', version: 2, photo: true }), roles: BOTH },
    { id: 'changes_requested', title: 'changes_requested', bundle: bundle({ status: 'changes_requested' }), roles: BOTH },
    { id: 'declined', title: 'declined', bundle: bundle({ status: 'declined' }), roles: BOTH },
    { id: 'expired', title: 'expired', bundle: bundle({ status: 'expired' }), roles: BOTH },
    { id: 'awaiting_prepayment', title: 'awaiting_prepayment, способ оплаты не выбран', bundle: bundle({ status: 'awaiting_prepayment' }), roles: BOTH },
    {
      id: 'awaiting_prepayment-link',
      title: 'awaiting_prepayment, живая ссылка на оплату',
      bundle: bundle({ status: 'awaiting_prepayment', payments: [payment({ rail: 'link', status: 'pending', amountKopecks: 90_000, expiresAt: at('2026-09-20T10:00:00Z') })] }),
      roles: BOTH,
    },
    {
      id: 'awaiting_prepayment-link-expired',
      title: 'awaiting_prepayment, ссылка истекла',
      bundle: bundle({ status: 'awaiting_prepayment', payments: [payment({ rail: 'link', status: 'expired', amountKopecks: 90_000, expiresAt: at('2026-09-20T08:00:00Z') })] }),
      roles: BOTH,
    },
    {
      id: 'awaiting_prepayment-link-canceled',
      title: 'awaiting_prepayment, провайдер отменил оплату',
      bundle: bundle({
        status: 'awaiting_prepayment',
        payments: [payment({ rail: 'link', status: 'canceled', amountKopecks: 90_000, canceledAt: at('2026-09-20T08:30:00Z'), cancellationReason: 'insufficient_funds' })],
      }),
      roles: BOTH,
    },
    {
      id: 'awaiting_prepayment-transfer',
      title: 'awaiting_prepayment, клиент выбрал перевод',
      bundle: bundle({ status: 'awaiting_prepayment', payments: [payment({ rail: 'transfer', status: 'pending', amountKopecks: 90_000 })] }),
      roles: BOTH,
    },
    {
      id: 'awaiting_prepayment-claimed',
      title: 'awaiting_prepayment, клиент сообщил о переводе',
      bundle: bundle({ status: 'awaiting_prepayment', payments: [payment({ rail: 'transfer', status: 'claimed', amountKopecks: 90_000, claimedAt: at('2026-09-20T08:07:00Z') })] }),
      roles: BOTH,
    },
    { id: 'scheduled', title: 'scheduled, предоплата по ссылке ЮKassa', bundle: bundle({ status: 'scheduled', payments: [prepaidByLink()] }), roles: BOTH },
    { id: 'scheduled-transfer', title: 'scheduled, предоплата переводом', bundle: bundle({ status: 'scheduled', payments: [prepaidByTransfer()] }), roles: BOTH },
    { id: 'scheduled-noprepay', title: 'scheduled, без предоплаты и без даты', bundle: bundle({ status: 'scheduled', prepaymentKopecks: 0, scheduledAt: null, description: null }), roles: BOTH },
    { id: 'awaiting_acceptance', title: 'awaiting_acceptance', bundle: bundle({ status: 'awaiting_acceptance', payments: [prepaidByLink()] }), roles: BOTH },
    { id: 'remarks', title: 'remarks', bundle: bundle({ status: 'remarks', payments: [prepaidByLink()] }), roles: BOTH },
    { id: 'awaiting_payment', title: 'awaiting_payment, способ не выбран', bundle: bundle({ status: 'awaiting_payment', payments: [prepaidByLink()] }), roles: BOTH },
    {
      id: 'awaiting_payment-link',
      title: 'awaiting_payment, живая ссылка на остаток',
      bundle: bundle({
        status: 'awaiting_payment',
        payments: [prepaidByLink(), payment({ kind: 'final', rail: 'link', status: 'pending', amountKopecks: 210_000, expiresAt: at('2026-09-27T14:00:00Z') })],
      }),
      roles: BOTH,
    },
    { id: 'paid', title: 'paid, нужен чек (самозанятый)', bundle: bundle({ status: 'paid', payments: [prepaidByLink(), finalByLink()] }), roles: BOTH },
    { id: 'closed', title: 'closed, чек приложен', bundle: bundle({ status: 'closed', payments: [prepaidByLink(), finalByLink()], receipt: true }), roles: BOTH },
    { id: 'closed-nocheck', title: 'closed, исполнитель без чека', bundle: bundle({ status: 'closed', payments: [prepaidByTransfer(), finalByLink()], taxMode: 'none' }), roles: BOTH },
    {
      id: 'cancelled-refund',
      title: 'cancelled клиентом, возврат ожидается',
      bundle: bundle({ status: 'cancelled', payments: [prepaidByLink()], cancel: { by: 'client', reason: 'Заболела', refundExpected: true } }),
      roles: BOTH,
    },
    {
      id: 'cancelled-refund-sent',
      title: 'cancelled, исполнитель отметил возврат',
      bundle: bundle({
        status: 'cancelled',
        payments: [prepaidByTransfer()],
        cancel: { by: 'seller', reason: null, refundExpected: true, sentAt: at('2026-09-20T06:10:00Z') },
      }),
      roles: BOTH,
    },
    {
      id: 'cancelled-nonrefund',
      title: 'cancelled, предоплата не возвращается',
      bundle: bundle({ status: 'cancelled', payments: [prepaidByLink()], cancel: { by: 'client', reason: null, refundExpected: false } }),
      roles: BOTH,
    },
    {
      id: 'cancelled-after-claim',
      title: 'cancelled после «Я перевёл(а)» без подтверждения',
      bundle: bundle({
        status: 'cancelled',
        payments: [
          payment({ rail: 'transfer', status: 'canceled', amountKopecks: 90_000, claimedAt: at('2026-09-19T11:07:00Z'), canceledAt: at('2026-09-19T12:05:00Z'), cancellationReason: 'deal_cancelled_after_claim' }),
        ],
        cancel: { by: 'client', reason: null, refundExpected: true },
      }),
      roles: BOTH,
    },
    { id: 'demo-awaiting_confirmation', title: 'демо, клиентская сторона ещё не открыта', bundle: bundle({ status: 'awaiting_confirmation', demo: true, client: false }), roles: ['seller'] },
    {
      id: 'demo-transfer',
      title: 'демо, перевод по реквизитам',
      bundle: bundle({ status: 'awaiting_prepayment', demo: true, payments: [payment({ rail: 'transfer', status: 'pending', amountKopecks: 90_000 })] }),
      roles: ['seller', 'client_demo'],
    },
    {
      id: 'demo-closed',
      title: 'демо, закрыта с чеком',
      bundle: bundle({ status: 'closed', demo: true, payments: [prepaidByLink(), finalByLink()], receipt: true }),
      roles: ['seller', 'client_demo'],
    },
  ];
}

let eventSeq = 0;
export function event(type: DealEventType, payload: Record<string, unknown> = {}): DealEvent {
  eventSeq += 1;
  return { id: eventSeq, dealId: 1, seq: eventSeq, type, actorUserId: null, actorRole: 'system', payload, createdAt: FIXED_NOW };
}

export type NoticeCase = { id: string; title: string; bundle: DealBundle; event: DealEvent };

/** Уведомления N1–N15 через notify.noticesFor: событие и сделка в том статусе, в который событие её перевело. */
export function noticeCases(): NoticeCase[] {
  paymentSeq = 0;
  eventSeq = 0;
  return [
    { id: 'N1', title: 'N1 клиент открыл карточку', bundle: bundle({ status: 'awaiting_confirmation' }), event: event('client.joined') },
    { id: 'N2', title: 'N2 клиент подтвердил, ждём предоплату', bundle: bundle({ status: 'awaiting_prepayment' }), event: event('version.confirmed') },
    { id: 'N2-noprepay', title: 'N2 без предоплаты', bundle: bundle({ status: 'scheduled', prepaymentKopecks: 0 }), event: event('version.confirmed') },
    { id: 'N3', title: 'N3 клиент предлагает изменения', bundle: bundle({ status: 'changes_requested' }), event: event('version.change_requested', { text: 'Давайте в 15:00 и без предоплаты' }) },
    {
      id: 'N4',
      title: 'N4 исполнитель изменил условия',
      bundle: bundle({ status: 'awaiting_confirmation', version: 2, totalKopecks: 300_000, prepaymentKopecks: 60_000 }),
      event: event('version.created', { version: 2, changed: ['scheduled_at', 'total', 'prepayment'] }),
    },
    { id: 'N5', title: 'N5 условия оставлены как есть', bundle: bundle({ status: 'awaiting_confirmation' }), event: event('version.created', { kept_as_is: true, version: 1 }) },
    { id: 'N6', title: 'N6 клиент отказался', bundle: bundle({ status: 'declined' }), event: event('deal.declined') },
    { id: 'N7', title: 'N7 срок подтверждения истёк', bundle: bundle({ status: 'expired' }), event: event('deal.expired') },
    { id: 'N8', title: 'N8 предоплата по ссылке ЮKassa', bundle: bundle({ status: 'scheduled', payments: [prepaidByLink()] }), event: event('payment.succeeded', { kind: 'prepayment' }) },
    { id: 'N8-transfer', title: 'N8 предоплата переводом', bundle: bundle({ status: 'scheduled', payments: [prepaidByTransfer()] }), event: event('payment.succeeded', { kind: 'prepayment' }) },
    { id: 'N9', title: 'N9 исполнитель отметил выполнение', bundle: bundle({ status: 'awaiting_acceptance', payments: [prepaidByLink()] }), event: event('deal.done') },
    { id: 'N10', title: 'N10 клиент принял работу', bundle: bundle({ status: 'awaiting_payment', payments: [prepaidByLink()] }), event: event('deal.accepted') },
    { id: 'N11', title: 'N11 клиент оставил замечания', bundle: bundle({ status: 'remarks', payments: [prepaidByLink()] }), event: event('deal.remarks', { text: 'Скол на безымянном пальце' }) },
    { id: 'N12', title: 'N12 замечания исправлены', bundle: bundle({ status: 'awaiting_acceptance', payments: [prepaidByLink()] }), event: event('deal.fixed') },
    { id: 'N13', title: 'N13 оплачено полностью, нужен чек', bundle: bundle({ status: 'paid', payments: [prepaidByLink(), finalByLink()] }), event: event('payment.succeeded', { kind: 'final' }) },
    {
      id: 'N15-client',
      title: 'N15 отменена клиентом, возврат ожидается',
      bundle: bundle({ status: 'cancelled', payments: [prepaidByLink()], cancel: { by: 'client', reason: 'Заболела', refundExpected: true } }),
      event: event('deal.cancelled', { by: 'client', reason: 'Заболела' }),
    },
    {
      id: 'N15-claim',
      title: 'N15 отменена после «Я перевёл(а)»',
      bundle: bundle({
        status: 'cancelled',
        payments: [
          payment({ rail: 'transfer', status: 'canceled', amountKopecks: 90_000, claimedAt: at('2026-09-19T11:07:00Z'), canceledAt: at('2026-09-19T12:05:00Z'), cancellationReason: 'deal_cancelled_after_claim' }),
        ],
        cancel: { by: 'seller', reason: null, refundExpected: true },
      }),
      event: event('deal.cancelled', { by: 'seller', reason: null }),
    },
    {
      id: 'refund-sent',
      title: 'Исполнитель отметил возврат',
      bundle: bundle({ status: 'cancelled', payments: [prepaidByLink()], cancel: { by: 'client', reason: null, refundExpected: true, sentAt: at('2026-09-20T06:10:00Z') } }),
      event: event('refund.confirmed', { by: 'seller' }),
    },
    {
      id: 'refund-received',
      title: 'Клиент подтвердил возврат',
      bundle: bundle({
        status: 'cancelled',
        payments: [prepaidByLink()],
        cancel: { by: 'client', reason: null, refundExpected: true, sentAt: at('2026-09-20T06:10:00Z'), receivedAt: at('2026-09-20T08:00:00Z') },
      }),
      event: event('refund.confirmed', { by: 'client' }),
    },
    {
      id: 'late-payment',
      title: 'Поздняя оплата по отменённой сделке',
      bundle: bundle({ status: 'cancelled', payments: [prepaidByLink()], cancel: { by: 'client', reason: null, refundExpected: true } }),
      event: event('payment.succeeded_late', { refund_required: true, amount: 90_000, reason: 'deal_cancelled' }),
    },
    { id: 'N2-demo', title: 'Демо: N2 с пометкой получателя', bundle: bundle({ status: 'awaiting_prepayment', demo: true }), event: event('version.confirmed') },
  ];
}
