-- 0004: подтверждение возврата предоплаты сторонами (ЗАДАЧА_03 H1, SPEC §5.3 «Возвраты»).
--
-- Продукт деньги не возвращает — он фиксирует обязательство (cancel_refund_expected, по правилу отмены) и ФАКТ:
-- исполнитель нажимает «Вернул(а)», клиент — «Возврат получил(а)». Статус сделки остаётся cancelled, машина
-- состояний не меняется; события — refund.confirmed {by} в deal_events, а время — здесь, чтобы карточка и
-- квитанция рисовали строку без чтения журнала.
ALTER TABLE deals ADD COLUMN refund_sent_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN refund_received_at TIMESTAMPTZ;
COMMENT ON COLUMN deals.refund_sent_at IS 'исполнитель отметил «Вернул(а)» (H1)';
COMMENT ON COLUMN deals.refund_received_at IS 'клиент отметил «Возврат получил(а)» (H1)';
