-- 0005: напоминание за 30 минут (event_soon) и утренняя сводка исполнителю (daily_digest) — ЗАДАЧА_04 B, SPEC §10.2–10.3.
--
-- event_soon — обычное напоминание по сделке: новой колонки не нужно, вид — просто текст в reminders.kind.
--
-- daily_digest — напоминание НЕ по одной сделке, а по исполнителю: «сегодня у вас 3 записи». Поэтому:
--   • reminders.deal_id становится необязательным, а получатель — reminders.user_id;
--   • CHECK не даёт появиться строке без адресата: либо сделка, либо сводка с пользователем.
-- Однократность сводки в день держит тот же UNIQUE dedupe_key: `digest:<seller_id>:<YYYY-MM-DD по МСК>`.

-- Время сводки — минуты от полуночи по APP_TIMEZONE (МСК): 360…720 с шагом 30 (06:00–12:00), NULL — выключена.
-- DEFAULT 480 (08:00) действует и для уже существующих профилей: сводка включена у всех, выключается в «Настройках».
ALTER TABLE seller_profiles ADD COLUMN digest_time SMALLINT DEFAULT 480
  CHECK (digest_time IS NULL OR (digest_time BETWEEN 360 AND 720 AND digest_time % 30 = 0));
COMMENT ON COLUMN seller_profiles.digest_time IS
  'утренняя сводка: минуты от полуночи по МСК (360…720, шаг 30); NULL — выключена';

ALTER TABLE reminders ALTER COLUMN deal_id DROP NOT NULL;
ALTER TABLE reminders ADD COLUMN user_id BIGINT REFERENCES users(max_user_id);
ALTER TABLE reminders ADD CONSTRAINT reminders_target_chk
  CHECK (deal_id IS NOT NULL OR (kind = 'daily_digest' AND user_id IS NOT NULL));
COMMENT ON COLUMN reminders.user_id IS 'получатель напоминания без сделки (daily_digest); у напоминаний по сделке — NULL';

-- Планирование сводки идёт каждым тиком (30 с): «у кого сегодня есть записи в scheduled / awaiting_prepayment /
-- awaiting_acceptance». Выборка начинается с deals по статусу — её покрывает deals_status_idx (status, …) из 0001,
-- а текущая версия берётся по UNIQUE (deal_id, version). Отдельный индекс по deal_versions.scheduled_at не нужен:
-- активных сделок на порядки меньше, чем версий, и фильтр по дате применяется уже к ним.
