-- 0007: «Другое время» — предложения времени от клиента (ЗАДАЧА_08 D, SPEC §7.10).
--
-- Машина состояний не меняется: предложение — это T4 (или событие без перехода, если изменения уже запрошены), а
-- принятие — обычная новая версия условий T5. Таблица нужна, чтобы кнопка «Принять» знала, какое время принимается,
-- чтобы устаревшее предложение нельзя было принять и чтобы принятое время удерживалось, пока клиент подтверждает версию.
CREATE TABLE time_proposals (
  id                  BIGSERIAL PRIMARY KEY,
  deal_id             BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  proposed_by_user_id BIGINT NOT NULL REFERENCES users(max_user_id),
  scheduled_at        TIMESTAMPTZ NOT NULL,
  -- версия условий, к которой относилось предложение: сменилась — предложение устарело
  base_version        INT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'accepted', 'taken', 'superseded')),
  -- версия, созданная принятием (для удержания времени до подтверждения клиентом)
  accepted_version    INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ
);
-- Не больше одного ожидающего предложения на сделку: новое вытесняет прежнее (superseded) в той же транзакции.
CREATE UNIQUE INDEX time_proposals_one_pending_idx ON time_proposals (deal_id) WHERE status = 'pending';
CREATE INDEX time_proposals_deal_idx ON time_proposals (deal_id, id DESC);

-- Занятость исполнителя (SPEC §7.10) выбирает его сделки по статусу и дате текущей версии: индекс по исполнителю
-- и статусу уже есть (deals_seller_idx из 0001), версия берётся по UNIQUE (deal_id, version).
