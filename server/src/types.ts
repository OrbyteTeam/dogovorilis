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
export type InputKind = 'change_request' | 'remarks' | 'receipt' | 'cancel_reason' | 'payout_details' | 'display_name' | 'rating_comment';

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
  | 'receipt_deadline'
  | 'refund_due'
  /** За 30 минут до срока — обеим сторонам (ЗАДАЧА_04 B1). */
  | 'event_soon'
  /** Утренняя сводка исполнителю: напоминание не по сделке, а по пользователю (reminders.user_id, ЗАДАЧА_04 B2). */
  | 'daily_digest';

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
  /** Провайдер подтвердил оплату, которую мы локально уже считали expired/canceled (ЗАДАЧА_03 F1). */
  | 'payment.succeeded_late'
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
  | 'demo.opened'
  | 'refund.confirmed'
  /** Клиент предложил другое время из календаря (ЗАДАЧА_08 D, SPEC §7.10). */
  | 'time.proposed';

/** Поля условий, которые исполнитель меняет новой версией (T5); по ним N4 перечисляет, что изменилось. */
export type TermsField = 'title' | 'description' | 'scheduled_at' | 'total' | 'prepayment' | 'cancel_rule';
export const TERMS_FIELDS: readonly TermsField[] = ['title', 'description', 'scheduled_at', 'total', 'prepayment', 'cancel_rule'];

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
  /** Утренняя сводка: минуты от полуночи по МСК (360…720, шаг 30); null — выключена (ЗАДАЧА_04 B2). */
  digestTime: number | null;
  /** Строка надёжности в карточке клиента (ЗАДАЧА_08 E, SPEC §7.11); по умолчанию выключена. */
  showReliability: boolean;
};

/** Показатели надёжности исполнителя из фактов сделок (SPEC §7.11); доли — проценты, null — нет данных. */
export type Reliability = {
  /** сделок закрыто */
  closed: number;
  /** без спора среди дошедших до «Выполнено», % */
  noDisputePercent: number | null;
  /** чек до 9-го числа месяца после оплаты среди закрытых с нужным чеком, % */
  chequeOnTimePercent: number | null;
  /** отменено исполнителем среди подтверждённых клиентом, % */
  sellerCancelPercent: number | null;
  /** средняя оценка клиентов (до десятых) и число оценок */
  rating: { average: number; count: number } | null;
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
  /** Имя клиента для строки расписания (ЗАДАЧА_04 C2); null — клиента нет или сделка демо. */
  clientName: string | null;
};

/** Запись дня для утренней сводки исполнителя (ЗАДАЧА_04 B2): сделка с датой в пределах суток по МСК. */
export type DayScheduleItem = {
  publicId: string;
  status: DealStatus;
  demo: boolean;
  title: string;
  scheduledAt: Date;
  prepaymentKopecks: number;
  /** имя клиента из профиля MAX; null — клиент ещё не открыл ссылку */
  clientName: string | null;
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
  /** Исполнитель отметил «Вернул(а)» / клиент — «Возврат получил(а)» (SPEC §5.3, ЗАДАЧА_03 H1). */
  refundSentAt: Date | null;
  refundReceivedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Услуга исполнителя, из которой собрана карточка (ЗАДАЧА_08 C); null — без услуги. */
  serviceId: number | null;
  /** Длительность визита в минутах на момент создания; null — 60 (занятость, ЗАДАЧА_08 D). */
  durationMin: number | null;
};

/** Предоплата услуги: нет / процент от цены / фиксированная сумма (ЗАДАЧА_08 C). */
export type PrepaymentKind = 'none' | 'percent' | 'amount';

/** Услуга исполнителя — сохранённые условия для формы сделки (SPEC §7.6a). Клиенту не показывается. */
export type SellerService = {
  id: number;
  sellerUserId: number;
  title: string;
  description: string | null;
  priceKopecks: number;
  durationMin: number;
  prepaymentKind: PrepaymentKind;
  /** процент (1–100) или сумма в копейках — по prepaymentKind */
  prepaymentValue: number;
  cancelRule: CancelRule;
  template: TemplateKey;
  sortOrder: number;
  active: boolean;
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
  /** null — у напоминания нет сделки (daily_digest): получатель тогда в userId. */
  dealId: number | null;
  userId: number | null;
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
  /** Ожидающее предложение времени от клиента (ЗАДАЧА_08 D): кнопка «Принять» в карточке исполнителя. */
  timeProposal?: TimeProposal | null;
  /** Надёжность исполнителя — только если он показывает её клиентам (ЗАДАЧА_08 E): строка в карточке клиента. */
  sellerReliability?: Reliability | null;
};

export type TimeProposalStatus = 'pending' | 'accepted' | 'taken' | 'superseded';

/** «Другое время» от клиента (SPEC §7.10): принимается исполнителем одной кнопкой как новая версия условий (T5). */
export type TimeProposal = {
  id: number;
  dealId: number;
  proposedByUserId: number;
  scheduledAt: Date;
  /** версия условий на момент предложения: сменилась — предложение устарело */
  baseVersion: number;
  status: TimeProposalStatus;
  /** версия, созданная принятием: пока клиент её не подтвердил, время удерживается за ним */
  acceptedVersion: number | null;
  createdAt: Date;
  resolvedAt: Date | null;
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
