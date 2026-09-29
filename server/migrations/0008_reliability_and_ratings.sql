-- 0008: надёжность исполнителя и оценка клиента (ЗАДАЧА_08 E, SPEC §7.11).
--
-- Показатели надёжности считаются из фактов сделок (закрыто, без споров, чек в срок, отмены исполнителем) — отдельной
-- таблицы для них нет. Здесь только то, чего в фактах нет: необязательная оценка клиента и выбор исполнителя,
-- показывать ли строку надёжности клиентам. Публичного рейтинга и профиля нет.

-- Одна оценка на сделку: PRIMARY KEY по сделке держит «оценить можно один раз» и при двойном нажатии.
CREATE TABLE deal_ratings (
  deal_id        BIGINT PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  client_user_id BIGINT NOT NULL REFERENCES users(max_user_id),
  score          SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment        TEXT CHECK (comment IS NULL OR char_length(comment) <= 500),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  commented_at   TIMESTAMPTZ
);

-- «Показывать надёжность клиентам» — строкой в карточке клиента; по умолчанию выключено.
ALTER TABLE seller_profiles ADD COLUMN show_reliability BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN seller_profiles.show_reliability IS 'строка «N сделок, M % без споров» в карточке клиента (ЗАДАЧА_08 E)';

-- Комментарий к оценке ждётся как любой ввод (user_inputs, 30 минут): новый вид ввода.
ALTER TABLE user_inputs DROP CONSTRAINT user_inputs_kind_check;
ALTER TABLE user_inputs ADD CONSTRAINT user_inputs_kind_check
  CHECK (kind IN ('change_request', 'remarks', 'receipt', 'cancel_reason', 'payout_details', 'display_name', 'rating_comment'));
