-- 0001_init.sql — схема БД «Договорились». Первичный источник — docs/SPEC.md §8.
-- Правило: статусы хранятся текстом с CHECK-ограничениями (проще мигрировать, чем ENUM).
-- Деньги — BIGINT в копейках. Время — TIMESTAMPTZ (UTC в базе, Europe/Moscow при показе).

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Пользователи MAX, которые хоть раз взаимодействовали с ботом или мини-приложением.
CREATE TABLE users (
  max_user_id        BIGINT PRIMARY KEY,                 -- User.user_id из MAX
  first_name         TEXT NOT NULL DEFAULT '',
  last_name          TEXT,
  username           TEXT,
  dialog_chat_id     BIGINT,                             -- chat_id диалога с ботом (из bot_started / message_created). NULL, пока не открыл бота
  locale             TEXT,
  phone              TEXT,                               -- E.164 без «+», как отдаёт MAX; только после проверки HMAC
  phone_verified_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Профиль исполнителя (мастера). Создаётся при первой сделке или из «Настройки».
CREATE TABLE seller_profiles (
  user_id              BIGINT PRIMARY KEY REFERENCES users(max_user_id) ON DELETE CASCADE,
  display_name         TEXT NOT NULL,                    -- как подписываться в карточке и квитанции
  tax_mode             TEXT NOT NULL DEFAULT 'npd'
                       CHECK (tax_mode IN ('npd', 'ip_kkt', 'none')),   -- npd = самозанятый (чек в «Мой налог»), ip_kkt = ИП с кассой (чек через провайдера/кассу), none = без чека (B2B/договор)
  payout_details       TEXT,                             -- текст для рейла «перевод»: «СБП по номеру +7…, Т-Банк» / «карта 2200 …». Показывается клиенту как есть
  transfer_enabled     BOOLEAN NOT NULL DEFAULT true,    -- разрешать рейл «перевод»
  link_enabled         BOOLEAN NOT NULL DEFAULT true,    -- разрешать рейл «ссылка» (работает только если на сервере настроен провайдер)
  default_cancel_rule  TEXT NOT NULL DEFAULT 'free_24h'
                       CHECK (default_cancel_rule IN ('free_24h', 'free_48h', 'nonrefundable', 'full_refund')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Сделка: одна договорённость между исполнителем и клиентом.
CREATE TABLE deals (
  id                   BIGSERIAL PRIMARY KEY,
  public_id            TEXT NOT NULL UNIQUE,             -- 10 символов [A-Za-z0-9], часть диплинка d_<public_id>
  seller_user_id       BIGINT NOT NULL REFERENCES users(max_user_id),
  client_user_id       BIGINT REFERENCES users(max_user_id),   -- NULL до перехода клиента по ссылке; в демо = seller_user_id
  demo                 BOOLEAN NOT NULL DEFAULT false,   -- «Открыть как клиент»: клиент = сам исполнитель
  template             TEXT NOT NULL
                       CHECK (template IN ('beauty', 'lesson', 'repair', 'custom_order', 'freelance', 'free')),
  current_version      INT NOT NULL DEFAULT 1,           -- указывает на deal_versions.version
  status               TEXT NOT NULL DEFAULT 'awaiting_confirmation'
                       CHECK (status IN (
                         'awaiting_confirmation', 'changes_requested', 'declined', 'expired',
                         'awaiting_prepayment', 'scheduled', 'awaiting_acceptance', 'remarks',
                         'awaiting_payment', 'paid', 'closed', 'cancelled')),
  status_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_joined_at     TIMESTAMPTZ,
  confirmed_at         TIMESTAMPTZ,
  done_at              TIMESTAMPTZ,
  accepted_at          TIMESTAMPTZ,
  paid_at              TIMESTAMPTZ,
  closed_at            TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  cancelled_by_role    TEXT CHECK (cancelled_by_role IN ('seller', 'client', 'system')),
  cancel_reason        TEXT,
  cancel_refund_expected BOOLEAN,                        -- расчёт по правилу отмены на момент отмены (NULL, если предоплаты не было)
  expires_at           TIMESTAMPTZ,                      -- срок ожидания подтверждения клиентом (created_at + 72 ч)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deals_seller_idx ON deals (seller_user_id, status, updated_at DESC);
CREATE INDEX deals_client_idx ON deals (client_user_id, status, updated_at DESC);
CREATE INDEX deals_status_idx ON deals (status, status_changed_at);

-- Версии условий. Новая версия создаётся при «Предложить изменения» → «Изменить условия».
CREATE TABLE deal_versions (
  id                   BIGSERIAL PRIMARY KEY,
  deal_id              BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  version              INT NOT NULL,
  title                TEXT NOT NULL,                    -- «Маникюр с покрытием», ≤ 80 символов
  description          TEXT,                             -- уточнения, ≤ 1000 символов
  scheduled_at         TIMESTAMPTZ,                      -- дата/время оказания услуги или выдачи; NULL = «без даты»
  total_kopecks        BIGINT NOT NULL CHECK (total_kopecks >= 100),
  prepayment_kopecks   BIGINT NOT NULL DEFAULT 0 CHECK (prepayment_kopecks >= 0 AND prepayment_kopecks <= total_kopecks),
  cancel_rule          TEXT NOT NULL
                       CHECK (cancel_rule IN ('free_24h', 'free_48h', 'nonrefundable', 'full_refund')),
  photo_max_token      TEXT,                             -- token изображения в MAX (макет/фото), если приложено
  change_request_text  TEXT,                             -- текст клиента «Предложить изменения», из-за которого появилась эта версия (для v ≥ 2)
  created_by_user_id   BIGINT NOT NULL REFERENCES users(max_user_id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at         TIMESTAMPTZ,                      -- когда клиент нажал «Подтверждаю» именно эту версию
  confirmed_by_user_id BIGINT REFERENCES users(max_user_id),
  UNIQUE (deal_id, version)
);

-- Платежи по сделке: предоплата и остаток, каждый по своему рейлу.
CREATE TABLE payments (
  id                   BIGSERIAL PRIMARY KEY,
  deal_id              BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('prepayment', 'final')),
  rail                 TEXT NOT NULL CHECK (rail IN ('link', 'transfer')),
  provider             TEXT NOT NULL CHECK (provider IN ('yookassa', 'tbank', 'manual')),
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'claimed', 'succeeded', 'canceled', 'expired')),
  amount_kopecks       BIGINT NOT NULL CHECK (amount_kopecks > 0),
  idempotence_key      UUID NOT NULL DEFAULT gen_random_uuid(),  -- Idempotence-Key ЮKassa / OrderId Т-Банка
  provider_payment_id  TEXT,                             -- ЮKassa payment.id / Т-Банк PaymentId
  provider_status      TEXT,                             -- последний статус провайдера как есть (succeeded / CONFIRMED / …)
  confirmation_url     TEXT,                             -- ЮKassa confirmation_url / Т-Банк PaymentURL
  qr_payload           TEXT,                             -- Т-Банк GetQr Data (ссылка СБП)
  claimed_at           TIMESTAMPTZ,                      -- рейл «перевод»: клиент нажал «Я перевёл(а)»
  succeeded_at         TIMESTAMPTZ,
  canceled_at          TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,                      -- срок жизни ссылки/QR (ЮKassa: 1 ч; Т-Банк: RedirectDueDate)
  raw                  JSONB,                            -- последний ответ провайдера
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);
-- В каждый момент по паре (сделка, вид платежа) не более одного «живого» платежа.
CREATE UNIQUE INDEX payments_one_live_idx ON payments (deal_id, kind) WHERE status IN ('pending', 'claimed', 'succeeded');

-- Журнал событий сделки (аудит; источник для истории в карточке и квитанции PDF).
CREATE TABLE deal_events (
  id                   BIGSERIAL PRIMARY KEY,
  deal_id              BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  seq                  INT NOT NULL,                     -- порядковый номер внутри сделки, с 1
  type                 TEXT NOT NULL,                    -- см. SPEC §5.4: deal.created, client.joined, version.confirmed, …
  actor_user_id        BIGINT,
  actor_role           TEXT NOT NULL CHECK (actor_role IN ('seller', 'client', 'client_demo', 'system')),
  payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deal_id, seq)
);

-- Сообщения-карточки, отправленные каждой стороне, чтобы обновлять их на месте (PUT /messages).
CREATE TABLE card_messages (
  id                   BIGSERIAL PRIMARY KEY,
  deal_id              BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id              BIGINT NOT NULL REFERENCES users(max_user_id),
  role                 TEXT NOT NULL CHECK (role IN ('seller', 'client', 'client_demo')),
  chat_id              BIGINT NOT NULL,
  mid                  TEXT NOT NULL,                    -- message.body.mid
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deal_id, user_id, role)
);

-- Напоминания: материализуются при смене статуса, отправляются планировщиком (SPEC §10).
CREATE TABLE reminders (
  id                   BIGSERIAL PRIMARY KEY,
  deal_id              BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,                    -- client_not_opened, confirmation_expired, prepayment_due, prepayment_overdue, event_tomorrow, event_passed, acceptance_due, payment_due, payment_overdue, receipt_due, receipt_deadline
  recipient_role       TEXT NOT NULL CHECK (recipient_role IN ('seller', 'client')),
  due_at               TIMESTAMPTZ NOT NULL,
  dedupe_key           TEXT NOT NULL UNIQUE,             -- <deal_id>:<kind>:<status_changed_at ISO> — гарантия однократности
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  attempts             INT NOT NULL DEFAULT 0,
  last_error           TEXT,
  sent_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due_idx ON reminders (status, due_at) WHERE status = 'pending';

-- Чек (фото/PDF из «Мой налог» или кассы), приложенный исполнителем к сделке.
CREATE TABLE receipts (
  id                   BIGSERIAL PRIMARY KEY,
  deal_id              BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  uploaded_by_user_id  BIGINT NOT NULL REFERENCES users(max_user_id),
  attachment_type      TEXT NOT NULL CHECK (attachment_type IN ('image', 'file')),
  max_token            TEXT NOT NULL,                    -- token вложения MAX для пересылки клиенту
  max_url              TEXT,                             -- url вложения (image.url / file.url), если есть
  file_name            TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ожидаемый текстовый/файловый ввод от пользователя (замена in-memory session SDK; переживает рестарт).
CREATE TABLE user_inputs (
  user_id              BIGINT PRIMARY KEY REFERENCES users(max_user_id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL
                       CHECK (kind IN ('change_request', 'remarks', 'receipt', 'cancel_reason', 'payout_details', 'display_name')),
  deal_id              BIGINT REFERENCES deals(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL              -- created_at + 30 мин; просроченный ввод игнорируется с подсказкой
);

-- Входящие вебхуки провайдеров: идемпотентность и разбор инцидентов.
CREATE TABLE webhook_log (
  id                   BIGSERIAL PRIMARY KEY,
  provider             TEXT NOT NULL CHECK (provider IN ('yookassa', 'tbank', 'max')),
  external_id          TEXT,                             -- payment.id / PaymentId / update marker
  event                TEXT,
  payload              JSONB NOT NULL,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at         TIMESTAMPTZ,
  result               TEXT                              -- ok | ignored:<reason> | error:<text>
);
CREATE INDEX webhook_log_ext_idx ON webhook_log (provider, external_id, received_at DESC);
