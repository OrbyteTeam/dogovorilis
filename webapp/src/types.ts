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
  /** Строка надёжности в карточке клиента (§7.11); undefined — сервер старше поля (считаем выключенной). */
  show_reliability?: boolean;
}

/** Показатели надёжности исполнителя из фактов сделок (§7.11); доли в процентах, null — пока нет данных. */
export interface Reliability {
  closed: number;
  no_dispute_percent: number | null;
  cheque_on_time_percent: number | null;
  seller_cancel_percent: number | null;
  rating: { average: number; count: number } | null;
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
  /** Надёжность — исполнителю с профилем (§7.11); null — профиля нет. */
  reliability?: Reliability | null;
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
  /**
   * Услуга, из которой собрана сделка (§7.6a). POST: число или поля нет. PUT: число — сменить, null — отвязать,
   * поля нет — не менять. Чужая или несуществующая — 404.
   */
  service_id?: number | null;
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
  /** Имя клиента для строки исполнителя; null — клиент ещё не открыл ссылку; нет поля — сервер старше (ЗАДАЧА_04 C). */
  client_name?: string | null;
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
  /** Услуга сделки (§7.6a) — только исполнителю, клиенту null; нет поля — сервер старше ЗАДАЧА_08 C. */
  service_id?: number | null;
  /** Длительность визита на момент создания, минуты — только исполнителю. */
  duration_min?: number | null;
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

// ─────────────── Экран сделки (`#/deals/:id`) — SPEC §7.9, §7.8 (`/full`, `/actions`, `/receipt`), ЗАДАЧА_08 B ───────────────

/** Чьими глазами собран экран сделки. */
export type DealRole = 'seller' | 'client';

/**
 * Коды действий — ровно кнопки карточки этой роли в этом статусе (SPEC §7.9, таблица). Последние семь мини-приложение
 * выполняет само, а не через `POST …/actions`: переход на форму, выбор файла, шеринг, «оплата — в чате».
 * `accept_time` — исполнитель принимает время, выбранное клиентом в календаре (§7.10, ЗАДАЧА_08 D).
 */
export type ActionCode =
  | 'confirm'
  | 'request_changes'
  | 'decline'
  | 'accept'
  | 'remarks'
  | 'cancel'
  | 'keep_as_is'
  | 'done'
  | 'fixed'
  | 'close_without_receipt'
  | 'remind_client'
  | 'refund_confirmed'
  | 'receipt_pdf'
  | 'accept_time'
  | 'edit'
  | 'repeat'
  | 'attach_receipt'
  | 'share'
  | 'pay'
  | 'confirm_transfer'
  | 'open_as_client';

/** Действия, которые идут через `POST /api/deals/:id/actions`. */
export type PostActionCode = Exclude<
  ActionCode,
  'edit' | 'repeat' | 'attach_receipt' | 'share' | 'pay' | 'confirm_transfer' | 'open_as_client'
>;

export interface DealFullTerms {
  version: number;
  title: string;
  description: string | null;
  /** ISO UTC; null — без даты. */
  scheduled_at: string | null;
  total_kopecks: number;
  prepayment_kopecks: number;
  /** total − prepayment */
  remaining_kopecks: number;
  cancel_rule: CancelRule;
  /** Готовый текст правила отмены. */
  cancel_rule_text: string;
  /** Когда создана текущая версия. */
  created_at: string;
  /** Когда клиент подтвердил текущую версию. */
  confirmed_at: string | null;
}

export interface DealFullVersion {
  version: number;
  created_at: string;
  confirmed_at: string | null;
  title: string;
  scheduled_at: string | null;
  total_kopecks: number;
  prepayment_kopecks: number;
  cancel_rule: CancelRule;
  /** Что просил клиент перед этой версией. */
  change_request_text: string | null;
}

export type DealPaymentStatus = 'pending' | 'claimed' | 'succeeded' | 'canceled' | 'expired';

export interface DealPayment {
  kind: 'prepayment' | 'final';
  rail: 'link' | 'transfer';
  status: DealPaymentStatus;
  amount_kopecks: number;
  /** succeeded_at ?? claimed_at ?? created_at */
  at: string | null;
  /** Готовая строка: «Предоплата 500 ₽ · ссылка ЮKassa (тест) · оплачено». */
  label: string;
}

export interface DealTimelineItem {
  at: string;
  actor: 'seller' | 'client' | 'system';
  /** Готовый текст события (server/src/texts.ts). */
  text: string;
}

/** Ожидающее предложение времени от клиента (SPEC §7.10): подпись «Принять …» и строка «Клиент предлагает …». */
export interface DealTimeProposal {
  id: number;
  /** ISO UTC. */
  scheduled_at: string;
}

/** `GET /api/deals/:id/full[?as=client]` — всё для экрана сделки одним ответом. */
export interface DealFull {
  public_id: string;
  role: DealRole;
  /** Демо: исполнитель он же клиент — можно переключиться «Как видит клиент». */
  can_view_as_client: boolean;
  demo: boolean;
  status: DealStatus;
  /** Статус для роли словами, готов к показу. */
  status_text: string;
  /** Коротко: «ждём предоплату». */
  status_short: string;
  /** https://max.ru/<bot>?start=d_<id> */
  link: string;
  /** Приглашение без ссылки — для shareDeal({ text, link }). */
  share_text: string;
  terms: DealFullTerms;
  /** По возрастанию, включая текущую; блок истории — если версий больше одной. */
  versions: DealFullVersion[];
  seller: { name: string };
  /** null — клиент ещё не открыл ссылку. */
  client: { name: string } | null;
  money: {
    paid_kopecks: number;
    /** Сколько ждём сейчас (предоплата или остаток), иначе 0. */
    due_kopecks: number;
    payments: DealPayment[];
  };
  /** От старых к новым, текст готов. */
  timeline: DealTimelineItem[];
  documents: {
    /** Квитанцию можно запросить (терминальный статус). */
    receipt_pdf: boolean;
    /** «Чек приложен 22.09» / «Чек: до 9 октября» / «Чек не требуется» / null. */
    cheque_text: string | null;
  };
  /** Кнопки карточки этой роли в этом статусе, в порядке карточки. */
  actions: ActionCode[];
  /** Для диалога отмены: что станет с предоплатой. */
  cancel_consequence: string | null;
  /** Клиент выбрал время и ждёт ответа исполнителя; нет поля — сервер старше ЗАДАЧА_08 D. */
  time_proposal?: DealTimeProposal | null;
  /** «3 сделки, 100 % без споров»: исполнителю — своя, клиенту — если исполнитель показывает (§7.11). */
  reliability_line?: string | null;
  /** Оценка клиента: исполнителю и её автору (§7.11). */
  rating?: { score: number; comment: string | null } | null;
}

/** `POST /api/deals/:id/actions`. */
export interface DealActionRequest {
  action: PostActionCode;
  /** Роль, под которой открыт экран (важно для демо). */
  as?: DealRole;
  /** Для `confirm` — обязательно: версия условий, которую видит клиент. */
  version?: number;
  /** `request_changes`, `remarks` — 1–500 символов. */
  text?: string;
  /** `cancel` исполнителем — необязательно, ≤ 300. */
  reason?: string;
  /** `accept_time` — какое предложение времени принять (`time_proposal.id`). */
  proposal_id?: number;
}

export interface DealActionResponse {
  deal: DealFull;
  result: 'done' | 'already_done';
  /** Показать тостом, если не null: «Напоминание отправлено». */
  notice: string | null;
}

/** `POST /api/deals/:id/receipt` — тело сам файл. */
export interface ReceiptUploadResponse {
  deal: DealFull;
  /** Сервер B-srv отдаёт готовый текст «Чек приложен, квитанция ушла обеим сторонам»; в контракте его нет — необязателен. */
  notice?: string | null;
}

// ─────────────── «Другое время» (`#/deals/:id/time`) — SPEC §7.10, §7.8 (`/busy`, `/time-proposals`), ЗАДАЧА_08 D ───────────────

/** Занятый интервал исполнителя `[start, end)`, ISO UTC; интервалы уже слиты, без названий и клиентов. */
export interface BusyInterval {
  start: string;
  end: string;
}

/** `GET /api/deals/:id/busy` — сетка выбора времени и занятость исполнителя (без этой сделки). */
export interface BusyResponse {
  /** Длительность визита этой сделки, минуты (по умолчанию 60). */
  duration_min: number;
  /** Шаг сетки, минуты (30). */
  step_min: number;
  /** Первый слот дня по МСК, «08:00». */
  first_slot: string;
  /** Последний слот дня по МСК — начинается в это время, «21:30». */
  last_slot: string;
  /** Сколько дней вперёд можно выбрать (30). */
  horizon_days: number;
  /** Слот не раньше чем через столько минут от `now` (30). */
  min_lead_min: number;
  /** Время сервера, ISO. */
  now: string;
  /** Текущее время сделки — отметка «сейчас»; null — без даты. */
  current: string | null;
  busy: BusyInterval[];
}

/** `POST /api/deals/:id/time-proposals`. `as: 'client'` — демо: исполнитель смотрит как клиент. */
export interface TimeProposalRequest {
  scheduled_at: string;
  as?: 'client';
}

export interface TimeProposalResponse {
  proposal: { id: number; scheduled_at: string; status: 'pending' };
  deal: DealFull;
}

// ─────────────── «Мои услуги» исполнителя — SPEC §7.6a, §7.8 (`/api/services`), ЗАДАЧА_08 C ───────────────

/** Предоплата услуги: процент (1–100) от цены, сумма в рублях (1…цена) или без предоплаты (value 0). */
export type PrepaymentKind = 'none' | 'percent' | 'amount';

export interface ServicePrepayment {
  kind: PrepaymentKind;
  value: number;
}

/**
 * Услуга — сохранённые условия, из которых исполнитель собирает карточку. Не витрина: клиент её не видит нигде.
 * Суммы — целые рубли, как у сделок.
 */
export interface Service {
  id: number;
  title: string;
  description: string | null;
  price_rub: number;
  /** 15…720 минут, шаг 15; по умолчанию 60. */
  duration_min: number;
  prepayment: ServicePrepayment;
  cancel_rule: CancelRule;
  /** Ниша, из которой выросла; своя — 'free'. */
  template: TemplateKey;
  /** false — скрыта: в форме сделки не предлагается. */
  active: boolean;
  sort_order: number;
}

/** Тело `POST /api/services` и `PUT /api/services/:id`. */
export interface ServiceBody {
  title: string;
  description?: string | null;
  price_rub: number;
  duration_min?: number;
  prepayment: ServicePrepayment;
  cancel_rule: CancelRule;
  template?: TemplateKey;
  /** Только PUT; нет поля — видимость не меняется. */
  active?: boolean;
}

export interface ServicesResponse {
  items: Service[];
}

export interface ServiceResponse {
  service: Service;
}
