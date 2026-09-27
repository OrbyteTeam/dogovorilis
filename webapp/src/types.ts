// Типы контракта API мини-приложения — docs/SPEC.md §7.8 (таблица) и §7.6 (шаблоны).

export type TaxMode = 'npd' | 'ip_kkt' | 'none';

export type CancelRule = 'free_24h' | 'free_48h' | 'nonrefundable' | 'full_refund';

export type TemplateKey = 'beauty' | 'lesson' | 'repair' | 'custom_order' | 'freelance' | 'free';

export type PaymentProvider = 'none' | 'yookassa' | 'tbank';

/** Статусы сделки — SPEC §5.1. */
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

export interface SellerProfile {
  display_name: string;
  tax_mode: TaxMode;
  payout_details: string | null;
  transfer_enabled: boolean;
  link_enabled: boolean;
  default_cancel_rule: CancelRule;
  /**
   * Время утренней сводки — минуты от полуночи по МСК (360…720, шаг 30); null — сводка выключена.
   * undefined — сервер старше этого поля: экран показывает значение по умолчанию (08:00).
   */
  digest_time?: number | null;
}

export interface MeUser {
  id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  phone_verified: boolean;
}

export interface AppConfig {
  provider: PaymentProvider;
  demo: boolean;
  bot_username: string;
}

export interface MeResponse {
  user: MeUser;
  profile: SellerProfile | null;
  config: AppConfig;
}

export interface Template {
  key: TemplateKey;
  label: string;
  title: string;
  prepayment_percent: number;
  cancel_rule: CancelRule;
  date_required: boolean;
  hint: string | null;
}

export interface TemplatesResponse {
  items: Template[];
}

export interface DealVersionView {
  version: number;
  title: string;
  description: string | null;
  scheduled_at: string | null;
  total_kopecks: number;
  prepayment_kopecks: number;
  cancel_rule: CancelRule;
  photo_max_token: string | null;
}

export interface DealTimestamps {
  created_at: string | null;
  confirmed_at: string | null;
  done_at: string | null;
  accepted_at: string | null;
  paid_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
}

export interface DealView {
  public_id: string;
  status: DealStatus;
  status_text: string;
  template: TemplateKey;
  demo: boolean;
  seller: { name: string };
  client: { name: string } | null;
  version: DealVersionView;
  remaining_kopecks: number;
  paid_kopecks: number;
  link: string;
  timestamps: DealTimestamps;
}

export interface CreateDealRequest {
  template: TemplateKey;
  title: string;
  description?: string | null;
  scheduled_at?: string | null;
  total_rub: number;
  prepayment_rub: number;
  cancel_rule: CancelRule;
  photo_max_token?: string | null;
  /** Передаётся только если профиля исполнителя ещё нет (SPEC §7.2, первый блок). */
  profile?: SellerProfile;
  /** «Повторить сделку»: public_id прежней сделки (ЗАДАЧА_04 F). */
  repeat_of?: string;
  /** Отправить новую карточку тому же клиенту сразу, без ссылки (только вместе с repeat_of). */
  same_client?: boolean;
}

/** Строка списка «Мои сделки» — SPEC §7.4, §7.8 (`GET /api/deals`). */
export interface DealListItem {
  public_id: string;
  status: DealStatus;
  status_text: string;
  /** Статус одним-двумя словами для строк списка и расписания: «ждём предоплату» (ЗАДАЧА_04 A2). */
  status_short: string;
  demo: boolean;
  role: 'seller' | 'client';
  title: string;
  scheduled_at: string | null;
  total_kopecks: number;
  prepayment_kopecks: number;
  paid_kopecks: number;
  updated_at: string;
}

export interface DealsResponse {
  items: DealListItem[];
}

export type DealsRole = 'seller' | 'client' | 'all';
export type DealsFilter = 'active' | 'awaiting_payment' | 'done' | 'all';

export interface CreateDealResponse {
  deal: DealView;
  link: string;
  share_text: string;
  /** Карточка дошла до исполнителя (есть диалог с ботом). */
  card_sent: boolean;
  /** Повтор с тем же клиентом: карточка уже у клиента — ссылка не нужна. Нет у сервера старше ЗАДАЧА_04 F. */
  client_card_sent?: boolean;
  /** Клиент новой сделки (при повторе с тем же клиентом). */
  client?: { name: string } | null;
  /** Тот же клиент запрошен, но у него нет диалога с ботом — сделка обычная, со ссылкой. */
  client_no_dialog?: boolean;
}

/**
 * `GET /api/deals/:publicId` — данные для предзаполнения формы правки (T5) и повтора (ЗАДАЧА_04 E, F).
 * 403 `forbidden` — не участник; 404 `not_found`.
 */
export interface DealDetails {
  public_id: string;
  status: DealStatus;
  version: number;
  role: 'seller' | 'client';
  demo: boolean;
  template: TemplateKey;
  title: string;
  description: string | null;
  scheduled_at: string | null;
  total_rub: number;
  prepayment_rub: number;
  cancel_rule: CancelRule;
  client: { name: string } | null;
  /** Исполнитель и статус `awaiting_confirmation` / `changes_requested`. */
  can_edit: boolean;
  /** Исполнитель, статус терминальный, не демо. */
  can_repeat: boolean;
  /** У прежней сделки был настоящий клиент — можно отправить новую ему напрямую. */
  same_client_available: boolean;
}

/** `PUT /api/deals/:publicId` — тело как у создания, без профиля (T5). */
export type UpdateDealRequest = Omit<CreateDealRequest, 'profile'>;

/** 409 `deal_not_editable` — клиент уже подтвердил и т.п.; 409 `no_changes` — условия те же. */
export interface UpdateDealResponse {
  deal: DealView;
  version: number;
  /** Клиенту ушло уведомление с перечнем изменений. */
  client_notified: boolean;
}

export interface ProfileResponse {
  profile: SellerProfile;
}
