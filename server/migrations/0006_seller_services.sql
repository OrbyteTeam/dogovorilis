-- 0006: «Мои услуги» исполнителя (ЗАДАЧА_08 C, SPEC §7.6a, §8).
--
-- Услуга — сохранённые условия, из которых исполнитель собирает карточку одним нажатием. Клиент список услуг не видит
-- нигде (это не витрина): услуга только заполняет форму исполнителя. Удаления нет — на услугу ссылаются сделки,
-- поэтому вместо удаления «скрыть» (active = false).
CREATE TABLE seller_services (
  id               BIGSERIAL PRIMARY KEY,
  seller_user_id   BIGINT NOT NULL REFERENCES users(max_user_id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 80),
  description      TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  price_kopecks    BIGINT NOT NULL CHECK (price_kopecks BETWEEN 100 AND 100000000),
  -- длительность визита: нужна расчёту занятости исполнителя (часть D); шаг 15 минут, до 12 часов
  duration_min     INT NOT NULL DEFAULT 60 CHECK (duration_min BETWEEN 15 AND 720 AND duration_min % 15 = 0),
  -- предоплата: нет / процент от цены / фиксированная сумма в копейках
  prepayment_kind  TEXT NOT NULL DEFAULT 'none' CHECK (prepayment_kind IN ('none', 'percent', 'amount')),
  prepayment_value BIGINT NOT NULL DEFAULT 0,
  cancel_rule      TEXT NOT NULL CHECK (cancel_rule IN ('free_24h', 'free_48h', 'nonrefundable', 'full_refund')),
  -- ниша-шаблон, из которого услуга выросла (для deals.template); своя — 'free'
  template         TEXT NOT NULL DEFAULT 'free'
                   CHECK (template IN ('beauty', 'lesson', 'repair', 'custom_order', 'freelance', 'free')),
  sort_order       INT NOT NULL DEFAULT 0,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT seller_services_prepayment_chk CHECK (
    (prepayment_kind = 'none' AND prepayment_value = 0)
    OR (prepayment_kind = 'percent' AND prepayment_value BETWEEN 1 AND 100)
    OR (prepayment_kind = 'amount' AND prepayment_value BETWEEN 100 AND price_kopecks)
  )
);
-- Список «Мои услуги» и блок «Выбрать услугу» читают услуги одного исполнителя по порядку.
CREATE INDEX seller_services_seller_idx ON seller_services (seller_user_id, sort_order, id);

-- Сделка помнит, из какой услуги собрана («Повторить» берёт её же) и сколько длится визит. Длительность — снимок на
-- момент создания (или правки T5 со сменой услуги): правка услуги потом не сдвигает занятость уже договорённых
-- визитов. NULL — «по умолчанию 60 минут» (SPEC §7.10).
ALTER TABLE deals ADD COLUMN service_id BIGINT REFERENCES seller_services(id) ON DELETE SET NULL;
ALTER TABLE deals ADD COLUMN duration_min INT CHECK (duration_min IS NULL OR duration_min BETWEEN 15 AND 720);
COMMENT ON COLUMN deals.service_id IS 'услуга исполнителя, из которой собрана карточка (ЗАДАЧА_08 C)';
COMMENT ON COLUMN deals.duration_min IS 'длительность визита в минутах на момент создания; NULL — 60 (занятость, ЗАДАЧА_08 D)';
