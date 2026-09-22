-- 0003: оживить зависшие напоминания confirmation_expired (ЗАДАЧА_03 часть D, аудит 22.09 п. 3).
--
-- Баг до этой миграции: переход без смены статуса (T2 «клиент открыл ссылку», демо «Открыть как клиент») гасил
-- ВСЕ pending-напоминания сделки (last_error = 'replanned') и планировал набор заново через
-- ON CONFLICT (dedupe_key) DO NOTHING. Статус не менялся → ключ confirmation_expired тот же → вставка молча
-- не проходила → T8 не наступал никогда: настоящая сделка, где клиент открыл ссылку и не ответил, висела вечно.
-- Код исправлен (replanReminders гасит только то, чего нет в новом наборе; planMany оживляет 'replanned'),
-- а уже зависшие строки поднимает эта миграция.
--
-- Оживляется только строка, которая соответствует ТЕКУЩЕМУ статусу сделки. Ключ строится так же, как в
-- domain/reminder/plan.ts: <deal_id>:confirmation_expired:seller:<status_changed_at в ISO, UTC, миллисекунды>.
-- JS Date.toISOString() отбрасывает микросекунды, date_trunc('milliseconds') — тоже.
-- Причина 'sending_disabled' включена на случай, если такая строка когда-то прошла через ветку «отправка
-- выключена»; строки, погашенные по делу (state_changed, no_chat), не трогаем.
-- Срок (due_at) остаётся прежним: если он уже прошёл, планировщик выполнит T8 на первом же тике и пришлёт N7 обеим.
--
-- Идемпотентна: после первого прогона эти строки уже pending/sent, повторный ничего не находит.
UPDATE reminders r
SET status = 'pending', attempts = 0, last_error = NULL
FROM deals d
WHERE r.deal_id = d.id
  AND r.kind = 'confirmation_expired'
  AND r.status = 'cancelled'
  AND r.last_error IN ('replanned', 'sending_disabled')
  AND d.status IN ('awaiting_confirmation', 'changes_requested')
  AND r.dedupe_key = d.id || ':confirmation_expired:seller:'
      || to_char(date_trunc('milliseconds', d.status_changed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  -- dedupe_key уникален, так что pending-строки с тем же ключом быть не может; а если у сделки уже есть
  -- другой живой confirmation_expired — второй не нужен.
  AND NOT EXISTS (
    SELECT 1 FROM reminders p
    WHERE p.deal_id = d.id AND p.kind = 'confirmation_expired' AND p.status = 'pending'
  );
