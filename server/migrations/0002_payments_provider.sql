-- 0002: подключение провайдера оплаты по ссылке (ЗАДАЧА_02, SPEC §9.2, §10.3).
--
-- Схема `payments` из 0001 уже содержит всё, что нужно ЮKassa: provider_payment_id, provider_status,
-- confirmation_url, expires_at, raw и UNIQUE (provider, provider_payment_id). Поэтому здесь — только
-- то, без чего новый код работает хуже, и ни одной колонки «на будущее».
--
-- Две развилки из docs/ДОПУЩЕНИЯ.md закрыты решением «ничего не менять», обе записаны там же:
--   • webhook_log.provider_status НЕ добавляем — его роль играет колонка `event`, на неё уже
--     опирается webhooks.alreadyProcessed; две колонки с одним смыслом хуже, чем одна.
--   • UNIQUE (receipts.deal_id) НЕ добавляем — повторная загрузка чека это законный сценарий
--     (исполнитель прислал не тот файл), читается последняя строка.

-- SPEC §9.2 требует показать в карточке «Оплата отменена: {cancellation_details.reason}».
-- Причина приходит внутри объекта платежа, то есть в payments.raw — но raw наружу из репозитория
-- не отдаётся (он для разбора инцидентов, а не для рендера) и вытаскивать её JSON-путём в карточке
-- значило бы протащить формат провайдера в транспорт. Отдельная колонка — честнее и дешевле.
ALTER TABLE payments ADD COLUMN cancellation_reason TEXT;
COMMENT ON COLUMN payments.cancellation_reason IS
  'cancellation_details.reason ЮKassa / причина отказа Т-Банка; человеческий текст — в texts.cancelReasonText';

-- Задание planner'а `payments-poll` (SPEC §10.3) на каждом тике ищет link-платежи в статусе pending,
-- которые давно не опрашивались. Без этого индекса — seq scan по всей таблице каждые 30 секунд.
CREATE INDEX payments_poll_idx
  ON payments (updated_at)
  WHERE rail = 'link' AND status = 'pending';

-- Вебхук ЮKassa приходит с object.id и ищет платёж по (provider, provider_payment_id).
-- UNIQUE (provider, provider_payment_id) из 0001 такой индекс уже даёт, отдельный не нужен.

-- Идемпотентность вебхука проверяется по (provider, external_id, event) среди обработанных доставок
-- (SPEC §9.6). Индекс webhook_log_ext_idx из 0001 покрывает (provider, external_id, …) — достаточно.
