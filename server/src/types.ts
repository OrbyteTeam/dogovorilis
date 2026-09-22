// Доменные типы. Зеркало server/migrations/0001_init.sql (SPEC §8), но в camelCase:
// репозитории (db/repos/*) — единственное место, где живёт snake_case из БД.
// Деньги — целые копейки в number (до 10^11, безопасно для Number); BIGINT из pg парсится в number в db/pool.ts.

export type DealStatus =
  | 'awaiting_confirmation'
  | 'changes_requested'
  | 'declined'
  | 'expired'
  | 'awaiting_prepayment'
  | 'scheduled'
  | 'awaiting_acceptance'
  | 'remarks'
  | 'awaiting_payment'
  | 'paid'
  | 'closed'
  | 'cancelled';

export const TERMINAL_STATUSES = ['declined', 'expired', 'closed', 'cancelled'] as const satisfies readonly DealStatus[];
export function isTerminal(s: DealStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

/** Роль в сделке. `system` — планировщик и вебхуки. */
export type Role = 'seller' | 'client' | 'system';
/** Роль в журнале событий и в карточках: демо-клиент отличается от настоящего (SPEC §12). */
export type ActorRole = 'seller' | 'client' | 'client_demo' | 'system';
/** Роль, для которой рендерится карточка. */
export type CardRole = 'seller' | 'client' | 'client_demo';

export type CancelRule = 'free_24h' | 'free_48h' | 'nonrefundable' | 'full_refund';
export type TaxMode = 'npd' | 'ip_kkt' | 'none';
export type TemplateKey = 'beauty' | 'lesson' | 'repair' | 'custom_order' | 'freelance' | 'free';
export type PaymentKind = 'prepayment' | 'final';
export type PaymentRail = 'link' | 'transfer';
export type PaymentProvider = 'yookassa' | 'tbank' | 'manual';
export type PaymentStatus = 'pending' | 'claimed' | 'succeeded' | 'canceled' | 'expired';
export type ReminderStatus = 'pending' | 'sent' | 'cancelled' | 'failed';
export type InputKind = 'change_request' | 'remarks' | 'receipt' | 'cancel_reason' | 'payout_details' | 'display_name';

export type ReminderKind =
  | 'client_not_opened'
  | 'confirmation_expired'
  | 'prepayment_due'
  | 'prepayment_overdue'
  | 'event_tomorrow'
  | 'event_passed'
  | 'acceptance_due'
  | 'payment_due'
  | 'payment_overdue'
  | 'receipt_due'
  | 'receipt_deadline';

/** Типы событий сделки (SPEC §5.4). */
export type DealEventType =
  | 'deal.created'
  | 'client.joined'
  | 'version.created'
  | 'version.confirmed'
  | 'version.change_requested'
  | 'deal.declined'
  | 'deal.expired'
  | 'payment.created'
  | 'payment.claimed'
  | 'payment.not_received'
  | 'payment.succeeded'
  | 'payment.canceled'
  | 'deal.done'
  | 'deal.accepted'
  | 'deal.remarks'
  | 'deal.fixed'
  | 'receipt.attached'
  | 'deal.closed_without_receipt'
  | 'deal.closed'
  | 'deal.cancelled'
  | 'reminder.sent'
  | 'reminder.skipped'
  | 'demo.opened';

/** Действия над сделкой = триггеры переходов T2–T17 (SPEC §5.2). */
export type DealAction =
  | 'join'
  | 'confirm'
  | 'request_changes'
  | 'new_version'
  | 'keep_as_is'
  | 'decline'
  | 'expire'
  | 'prepayment_succeeded'
  | 'done'
  | 'accept'
  | 'remarks'
  | 'fixed'
  | 'final_succeeded'
  | 'attach_receipt'
  | 'close_without_receipt'
  | 'cancel';

export type User = {
  maxUserId: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  dialogChatId: number | null;
  locale: string | null;
  phone: string | null;
  phoneVerifiedAt: Date | null;
};

export type SellerProfile = {
  userId: number;
  displayName: string;
  taxMode: TaxMode;
  payoutDetails: string | null;
  transferEnabled: boolean;
  linkEnabled: boolean;
  defaultCancelRule: CancelRule;
};

/** Строка списка «Мои сделки» (SPEC §7.4): плоская, без версий, платежей и событий. */
export type DealListItem = {
  publicId: string;
  status: DealStatus;
  demo: boolean;
  /** роль смотрящего в этой сделке */
  role: 'seller' | 'client';
  title: string;
  scheduledAt: Date | null;
  totalKopecks: number;
  prepaymentKopecks: number;
  paidKopecks: number;
  updatedAt: Date;
};

export type Deal = {
  id: number;
  publicId: string;
  sellerUserId: number;
  clientUserId: number | null;
  demo: boolean;
  template: TemplateKey;
  currentVersion: number;
  status: DealStatus;
  statusChangedAt: Date;
  clientJoinedAt: Date | null;
  confirmedAt: Date | null;
  doneAt: Date | null;
  acceptedAt: Date | null;
  paidAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  cancelledByRole: 'seller' | 'client' | 'system' | null;
  cancelReason: string | null;
  cancelRefundExpected: boolean | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DealVersion = {
  id: number;
  dealId: number;
  version: number;
  title: string;
  description: string | null;
  scheduledAt: Date | null;
  totalKopecks: number;
  prepaymentKopecks: number;
  cancelRule: CancelRule;
  photoMaxToken: string | null;
  changeRequestText: string | null;
  createdByUserId: number;
  createdAt: Date;
  confirmedAt: Date | null;
  confirmedByUserId: number | null;
};

export type Payment = {
  id: number;
  dealId: number;
  kind: PaymentKind;
  rail: PaymentRail;
  provider: PaymentProvider;
  status: PaymentStatus;
  amountKopecks: number;
  idempotenceKey: string;
  providerPaymentId: string | null;
  providerStatus: string | null;
  confirmationUrl: string | null;
  qrPayload: string | null;
  /** cancellation_details.reason провайдера; человеческий текст — texts.cancelReasonText (SPEC §9.2). */
  cancellationReason: string | null;
  claimedAt: Date | null;
  succeededAt: Date | null;
  canceledAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DealEvent = {
  id: number;
  dealId: number;
  seq: number;
  type: DealEventType;
  actorUserId: number | null;
  actorRole: ActorRole;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type CardMessage = {
  id: number;
  dealId: number;
  userId: number;
  role: CardRole;
  chatId: number;
  mid: string;
};

export type Reminder = {
  id: number;
  dealId: number;
  kind: ReminderKind;
  recipientRole: 'seller' | 'client';
  dueAt: Date;
  dedupeKey: string;
  status: ReminderStatus;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
};

export type Receipt = {
  id: number;
  dealId: number;
  uploadedByUserId: number;
  attachmentType: 'image' | 'file';
  maxToken: string;
  maxUrl: string | null;
  fileName: string | null;
  createdAt: Date;
};

export type UserInput = {
  userId: number;
  kind: InputKind;
  dealId: number | null;
  createdAt: Date;
  expiresAt: Date;
};

/** Сделка вместе со всем, что нужно для рендера карточки и для переходов. */
export type DealBundle = {
  deal: Deal;
  version: DealVersion;
  payments: Payment[];
  seller: User;
  sellerProfile: SellerProfile | null;
  client: User | null;
  receipt: Receipt | null;
};

/** Вычисляемые величины (SPEC §5.1). */
export function paidTotal(payments: Payment[]): number {
  return payments.filter((p) => p.status === 'succeeded').reduce((s, p) => s + p.amountKopecks, 0);
}
export function remaining(version: Pick<DealVersion, 'totalKopecks' | 'prepaymentKopecks'>): number {
  return version.totalKopecks - version.prepaymentKopecks;
}
/**
 * cancellation_reason перевода, о котором клиент сообщил («Я перевёл(а)»), но сделку отменили раньше, чем
 * исполнитель подтвердил поступление (ЗАДАЧА_03 F7). Деньги могли прийти — продукт этого не видит.
 */
export const CANCELLED_AFTER_CLAIM = 'deal_cancelled_after_claim';

/** Заявленный клиентом перевод, оборванный отменой сделки, — по нему стороны должны свериться сами. */
export function claimedTransferAtCancel(payments: Payment[]): Payment | null {
  return (
    payments.find((p) => p.rail === 'transfer' && p.status === 'canceled' && p.cancellationReason === CANCELLED_AFTER_CLAIM) ?? null
  );
}

/** Живой платёж по виду: не более одного (частичный уникальный индекс в 0001_init.sql). */
export function livePayment(payments: Payment[], kind: PaymentKind): Payment | null {
  return payments.find((p) => p.kind === kind && ['pending', 'claimed', 'succeeded'].includes(p.status)) ?? null;
}
