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
  description?: string;
  scheduled_at?: string | null;
  total_rub: number;
  prepayment_rub: number;
  cancel_rule: CancelRule;
  photo_max_token?: string | null;
  /** Передаётся только если профиля исполнителя ещё нет (SPEC §7.2, первый блок). */
  profile?: SellerProfile;
}

export interface CreateDealResponse {
  deal: DealView;
  link: string;
  share_text: string;
  card_sent: boolean;
}

export interface ProfileResponse {
  profile: SellerProfile;
}
