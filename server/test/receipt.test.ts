// Квитанция PDF по DESIGN_BRIEF §8 (чек-лист §9 п. 14): хронология и прошлые версии из журнала событий,
// строка статуса, сборка файла для закрытой, отменённой и демо-сделки. Текст внутри PDF закодирован глифами
// шрифта, поэтому строки проверяются на функциях, из которых он собран, а файл проверяется как PDF.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig, setConfig } from '../src/config.js';
import { buildHistory } from '../src/domain/receipt/history.js';
import { renderReceiptPdf, statusLine } from '../src/domain/receipt/pdf.js';
import { buildReceiptData } from '../src/transport/bot/receipt.js';
import type { DealEvent, DealVersion } from '../src/types.js';
import { bundle, event, finalByLink, prepaidByLink, prepaidByTransfer } from './helpers/render-fixtures.js';

setConfig(
  loadConfig({
    NODE_ENV: 'test',
    MAX_MODE: 'off',
    PUBLIC_BASE_URL: 'http://localhost:8080',
    DATABASE_URL: 'postgres://unused@localhost:5432/unused',
    PAYMENT_PROVIDER: 'none',
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv),
);

const at = (iso: string) => new Date(iso);
const withTime = (e: DealEvent, iso: string): DealEvent => ({ ...e, createdAt: at(iso) });

describe('хронология и прошлые версии (DESIGN_BRIEF §8 п. 4, п. 6)', () => {
  const b = bundle({ status: 'closed', payments: [prepaidByLink(), finalByLink()], receipt: true, version: 2 });
  const prepayment = b.payments[0];
  const events: DealEvent[] = [
    withTime(event('deal.created'), '2026-09-18T09:00:00Z'),
    withTime(event('client.joined'), '2026-09-18T10:00:00Z'),
    withTime(event('reminder.sent'), '2026-09-18T10:30:00Z'),
    withTime(event('version.change_requested', { text: 'позже' }), '2026-09-18T10:40:00Z'),
    withTime(event('version.created', { version: 2, changed: ['total'] }), '2026-09-19T07:15:00Z'),
    withTime(event('version.confirmed', { version: 2 }), '2026-09-19T08:00:00Z'),
    withTime(event('payment.succeeded', { kind: 'prepayment', payment_id: prepayment.id }), '2026-09-19T08:07:00Z'),
    withTime(event('deal.done'), '2026-09-27T12:30:00Z'),
    withTime(event('deal.accepted'), '2026-09-27T13:00:00Z'),
    withTime(event('receipt.attached'), '2026-09-27T16:30:00Z'),
    withTime(event('deal.closed', { with_receipt: true }), '2026-09-27T16:30:00Z'),
  ];
  const v1: DealVersion = { ...b.version, version: 1, totalKopecks: 280_000, prepaymentKopecks: 84_000, createdAt: at('2026-09-18T09:00:00Z') };

  it('события строками по времени, служебные напоминания не попадают', () => {
    const h = buildHistory(events, [v1, b.version], b.payments);
    expect(h.entries.map((e) => e.text)).toEqual([
      'Исполнитель создал сделку',
      'Клиент открыл карточку',
      'Клиент предложил изменения',
      'Исполнитель изменил условия, версия 2',
      'Клиент подтвердил условия, версия 2',
      'Предоплата 900\u00A0₽ получена по ссылке ЮKassa (тест)',
      'Исполнитель отметил выполнение',
      'Клиент принял работу',
      'Исполнитель приложил чек',
      'Сделка закрыта',
    ]);
  });

  it('прошлая версия: дата и что в ней было иначе', () => {
    const h = buildHistory(events, [b.version, v1], b.payments);
    expect(h.pastVersions).toEqual([{ version: 1, createdAt: v1.createdAt, changes: 'сумма 2 800 ₽, предоплата 840 ₽' }]);
  });

  it('отмена с причиной и отметки возврата', () => {
    const h = buildHistory(
      [event('deal.cancelled', { by: 'client', reason: 'Заболела' }), event('refund.confirmed', { by: 'seller' }), event('refund.confirmed', { by: 'client' })],
      [b.version],
      [],
    );
    expect(h.entries.map((e) => e.text)).toEqual([
      'Сделка отменена клиентом: Заболела',
      'Исполнитель отметил возврат предоплаты',
      'Клиент подтвердил получение возврата',
    ]);
  });
});

describe('строка статуса (§8 п. 2)', () => {
  it('закрыта и отменена словом с датой, истёк без даты', () => {
    const closed = buildReceiptData(bundle({ status: 'closed', payments: [prepaidByLink(), finalByLink()], receipt: true }), at('2026-09-27T16:42:00Z'));
    expect(statusLine(closed, 'Europe/Moscow')).toBe('Сделка закрыта 27 сен 2026, 19:40');
    const cancelled = buildReceiptData(
      bundle({ status: 'cancelled', payments: [prepaidByTransfer()], cancel: { by: 'client', reason: 'Заболела', refundExpected: true } }),
      at('2026-09-20T09:00:00Z'),
    );
    expect(statusLine(cancelled, 'Europe/Moscow')).toBe('Отменена клиентом 19 сен 2026, 15:05: Заболела');
    expect(statusLine(buildReceiptData(bundle({ status: 'expired' })), 'Europe/Moscow')).toBe('Срок подтверждения истёк');
  });
});

describe('файл квитанции (§8, п. 14 чек-листа)', () => {
  it.each([
    ['закрытая', bundle({ status: 'closed', payments: [prepaidByLink(), finalByLink()], receipt: true, version: 2 })],
    ['отменённая', bundle({ status: 'cancelled', payments: [prepaidByTransfer()], cancel: { by: 'client', reason: 'Заболела', refundExpected: true } })],
    ['демо', bundle({ status: 'closed', demo: true, payments: [prepaidByLink(), finalByLink()], receipt: true })],
  ] as const)('%s: валидный PDF', async (_, b) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'receipt-test-'));
    try {
      const out = path.join(dir, 'k.pdf');
      const history = buildHistory([event('deal.created'), event('deal.closed')], [b.version], b.payments);
      await renderReceiptPdf(buildReceiptData(b, at('2026-09-27T16:42:00Z'), [], history), out);
      const bytes = await readFile(out);
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(bytes.toString('latin1')).toContain('%%EOF');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
