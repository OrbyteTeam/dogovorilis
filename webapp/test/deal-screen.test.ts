// Экран сделки (ЗАДАЧА_08 B, SPEC §7.9): раскладка действий в кнопки, листы, проверка чека, разбор ошибок.
import { describe, expect, it } from 'vitest';

import {
  acceptTimeLabel,
  doneText,
  actionErrorOutcome,
  avatarGradient,
  buttonBehavior,
  CHANGE_SHEET,
  checkReceiptFile,
  confirmSheet,
  initials,
  layoutActions,
  proposalNote,
  RECEIPT_EMPTY_ERROR,
  RECEIPT_FILE_ERROR,
  RECEIPT_MAX_BYTES,
  statusTone,
  textSheet,
  validateText,
} from '../src/deal-screen';

const keys = (actions: Parameters<typeof layoutActions>[0], role: 'seller' | 'client' = 'seller') =>
  layoutActions(actions, role).buttons.map((b) => `${b.key}:${b.variant}`);

describe('раскладка действий', () => {
  it('клиент до подтверждения: «Подтверждаю» главной, «Отказаться» — обычной', () => {
    expect(keys(['confirm', 'request_changes', 'decline'], 'client')).toEqual([
      'confirm:primary',
      'request_changes:secondary',
      'decline:secondary',
    ]);
  });

  it('главное действие — первым, даже если в карточке оно не первое; «Отменить сделку» — последней', () => {
    expect(keys(['cancel', 'done'])).toEqual(['done:primary', 'cancel:destructive']);
    expect(keys(['remind_client', 'cancel', 'attach_receipt'])).toEqual([
      'attach_receipt:primary',
      'remind_client:secondary',
      'cancel:destructive',
    ]);
  });

  it('главное действие одно: второй кандидат остаётся обычной кнопкой', () => {
    expect(keys(['done', 'fixed'])).toEqual(['done:primary', 'fixed:secondary']);
  });

  it('нет главного — все обычные, отмена последней', () => {
    expect(keys(['edit', 'keep_as_is', 'cancel'])).toEqual(['edit:secondary', 'keep_as_is:secondary', 'cancel:destructive']);
  });

  it('«Отправить клиенту» даёт вторую кнопку «Скопировать ссылку» сразу за ней; «Открыть как клиент» не показываем', () => {
    const layout = layoutActions(['share', 'edit', 'open_as_client', 'cancel'], 'seller');
    expect(layout.buttons.map((b) => b.key)).toEqual(['share', 'copy_link', 'edit', 'cancel']);
    expect(layout.buttons[0].label).toBe('Отправить клиенту');
    expect(layout.buttons[1].label).toBe('Скопировать ссылку');
  });

  it('оплата и подтверждение перевода — не кнопки, а подсказки в блоке «Деньги»', () => {
    const client = layoutActions(['pay', 'cancel'], 'client');
    expect(client.payInChat).toBe(true);
    expect(client.buttons.map((b) => b.key)).toEqual(['cancel']);
    const seller = layoutActions(['confirm_transfer', 'remind_client', 'cancel'], 'seller');
    expect(seller.transferClaimed).toBe(true);
    expect(seller.buttons.map((b) => b.key)).toEqual(['remind_client', 'cancel']);
  });

  it('квитанция — в «Документах», а не в «Действиях»', () => {
    const layout = layoutActions(['refund_confirmed', 'receipt_pdf', 'repeat'], 'seller');
    expect(layout.receiptPdf).toBe(true);
    expect(layout.buttons.map((b) => b.key)).toEqual(['refund_confirmed', 'repeat']);
  });

  it('возврат подписан по роли', () => {
    expect(layoutActions(['refund_confirmed'], 'seller').buttons[0].label).toBe('Вернул(а)');
    expect(layoutActions(['refund_confirmed'], 'client').buttons[0].label).toBe('Возврат получил(а)');
  });

  it('повтор кода в ответе не даёт двух одинаковых кнопок', () => {
    expect(keys(['done', 'done', 'cancel'])).toEqual(['done:primary', 'cancel:destructive']);
  });

  it('пустой список — нет кнопок и подсказок', () => {
    expect(layoutActions([], 'client')).toEqual({ buttons: [], payInChat: false, transferClaimed: false, receiptPdf: false });
  });

  it('подписи новых кнопок без длинных тире и точек-разделителей', () => {
    const all = layoutActions(
      ['confirm', 'request_changes', 'decline', 'accept', 'remarks', 'keep_as_is', 'done', 'fixed', 'close_without_receipt',
        'remind_client', 'refund_confirmed', 'edit', 'repeat', 'attach_receipt', 'share', 'accept_time', 'cancel'],
      'seller',
      { id: 7, scheduled_at: '2026-10-01T16:00:00.000Z' },
    );
    for (const b of all.buttons) expect(b.label).not.toMatch(/[—·]/);
  });
});

describe('другое время (ЗАДАЧА_08 D)', () => {
  const proposal = { id: 7, scheduled_at: '2026-10-01T16:00:00.000Z' };

  it('«Принять {время}» — главной у исполнителя, первой; подпись — как кнопка в чате, время по МСК', () => {
    const layout = layoutActions(['accept_time', 'edit', 'keep_as_is', 'cancel'], 'seller', proposal);
    expect(layout.buttons.map((b) => `${b.key}:${b.variant}`)).toEqual([
      'accept_time:primary',
      'edit:secondary',
      'keep_as_is:secondary',
      'cancel:destructive',
    ]);
    expect(layout.buttons[0].label).toBe('Принять Чт 1 окт, 19:00');
    expect(acceptTimeLabel(proposal.scheduled_at)).toBe('Принять Чт 1 окт, 19:00');
  });

  it('действие без предложения — нейтральная подпись', () => {
    expect(layoutActions(['accept_time'], 'seller').buttons[0].label).toBe('Принять время');
  });

  it('«Принять» — сразу запрос действия; «Предложить изменения» — лист выбора времени или текста', () => {
    expect(buttonBehavior('accept_time')).toEqual({ kind: 'post', code: 'accept_time' });
    expect(buttonBehavior('request_changes')).toEqual({ kind: 'change' });
    expect(CHANGE_SHEET.timeLabel).toBe('Другое время');
    expect(CHANGE_SHEET.textLabel).toBe('Написать текстом');
  });

  it('строка над действиями: исполнителю — что предлагает клиент, клиенту — что он предложил', () => {
    expect(proposalNote('seller', proposal)).toBe('Клиент предлагает 01.10.2026 19:00 (МСК)');
    expect(proposalNote('client', proposal)).toBe('Вы предложили 01.10.2026 19:00 (МСК). Ждём ответа исполнителя');
  });

  it('новые подписи без длинных тире и точек-разделителей', () => {
    for (const text of [...Object.values(CHANGE_SHEET), proposalNote('seller', proposal), proposalNote('client', proposal)]) {
      expect(text).not.toMatch(/[—·]/);
    }
  });
});

describe('что делает кнопка', () => {
  it('необратимое — через подтверждение, текстовое — через лист ввода', () => {
    expect(buttonBehavior('decline')).toEqual({ kind: 'confirm', code: 'decline' });
    expect(buttonBehavior('cancel')).toEqual({ kind: 'confirm', code: 'cancel' });
    expect(buttonBehavior('close_without_receipt')).toEqual({ kind: 'confirm', code: 'close_without_receipt' });
    expect(buttonBehavior('remarks')).toEqual({ kind: 'text', code: 'remarks' });
  });

  it('переходы, файл и шеринг выполняет само мини-приложение', () => {
    expect(buttonBehavior('edit').kind).toBe('edit');
    expect(buttonBehavior('repeat').kind).toBe('repeat');
    expect(buttonBehavior('attach_receipt').kind).toBe('file');
    expect(buttonBehavior('share').kind).toBe('share');
    expect(buttonBehavior('copy_link').kind).toBe('copy');
  });

  it('остальное — сразу запрос действия', () => {
    for (const code of ['confirm', 'accept', 'keep_as_is', 'done', 'fixed', 'remind_client', 'refund_confirmed'] as const) {
      expect(buttonBehavior(code)).toEqual({ kind: 'post', code });
    }
  });
});

describe('листы', () => {
  it('причина отмены — только у исполнителя', () => {
    expect(confirmSheet('cancel', 'seller').reasonField).toBe(true);
    expect(confirmSheet('cancel', 'client').reasonField).toBe(false);
    expect(confirmSheet('decline', 'client').destructive).toBe(true);
    expect(confirmSheet('close_without_receipt', 'seller').destructive).toBe(false);
  });

  it('текст обязателен и не длиннее лимита', () => {
    const { emptyError } = textSheet('request_changes');
    expect(validateText('   ', { max: 500, emptyError })).toBe(emptyError);
    expect(validateText('Давайте 15:00', { max: 500, emptyError })).toBeNull();
    expect(validateText(`  ${'а'.repeat(500)}  `, { max: 500, emptyError })).toBeNull();
    expect(validateText('а'.repeat(501), { max: 500, emptyError })).toBe('Не больше 500 символов');
  });

  it('причина отмены необязательна, но не длиннее 300', () => {
    expect(validateText('', { max: 300 })).toBeNull();
    expect(validateText('а'.repeat(301), { max: 300 })).toBe('Не больше 300 символов');
  });
});

describe('файл чека', () => {
  it('pdf, jpeg, png — принимаем и передаём правильный Content-Type', () => {
    expect(checkReceiptFile({ name: 'чек.pdf', type: 'application/pdf', size: 1000 })).toEqual({ ok: true, contentType: 'application/pdf' });
    expect(checkReceiptFile({ name: 'a.jpg', type: 'image/jpeg', size: 1000 })).toEqual({ ok: true, contentType: 'image/jpeg' });
    expect(checkReceiptFile({ name: 'a.jpg', type: 'image/jpg', size: 1000 })).toEqual({ ok: true, contentType: 'image/jpeg' });
    expect(checkReceiptFile({ name: 'a.png', type: 'image/png', size: RECEIPT_MAX_BYTES })).toEqual({ ok: true, contentType: 'image/png' });
  });

  it('WebView не сообщил тип — определяем по расширению', () => {
    expect(checkReceiptFile({ name: 'Чек.PDF', type: '', size: 10 })).toEqual({ ok: true, contentType: 'application/pdf' });
    expect(checkReceiptFile({ name: 'scan.jpeg', type: 'application/octet-stream', size: 10 })).toEqual({ ok: true, contentType: 'image/jpeg' });
    expect(checkReceiptFile({ name: 'без расширения', type: '', size: 10 })).toEqual({ ok: false, error: RECEIPT_FILE_ERROR });
  });

  it('чужой тип, пустой файл и больше 20 МБ — отказ до отправки', () => {
    expect(checkReceiptFile({ name: 'a.heic', type: 'image/heic', size: 10 })).toEqual({ ok: false, error: RECEIPT_FILE_ERROR });
    expect(checkReceiptFile({ name: 'a.pdf', type: 'image/gif', size: 10 })).toEqual({ ok: false, error: RECEIPT_FILE_ERROR });
    expect(checkReceiptFile({ name: 'a.pdf', type: 'application/pdf', size: 0 })).toEqual({ ok: false, error: RECEIPT_EMPTY_ERROR });
    expect(checkReceiptFile({ name: 'a.pdf', type: 'application/pdf', size: RECEIPT_MAX_BYTES + 1 })).toEqual({
      ok: false,
      error: RECEIPT_FILE_ERROR,
    });
  });
});

describe('ошибки действий', () => {
  it('сделка ушла дальше или условия сменились — перезагрузка экрана', () => {
    expect(actionErrorOutcome({ status: 409, code: 'invalid_transition' }, false)).toBe('reload');
    expect(actionErrorOutcome({ status: 409, code: 'version_mismatch' }, true)).toBe('reload');
  });

  it('ошибка валидации — у поля, если поле есть; иначе тост', () => {
    expect(actionErrorOutcome({ status: 400, code: 'validation' }, true)).toBe('field');
    expect(actionErrorOutcome({ status: 400, code: 'validation' }, false)).toBe('toast');
  });

  it('сеть и 5xx — лист остаётся открытым; прочие 409, 403, 429 — тост', () => {
    expect(actionErrorOutcome({ status: 0, code: 'network' }, true)).toBe('retry');
    expect(actionErrorOutcome({ status: 0, code: 'timeout' }, false)).toBe('retry');
    expect(actionErrorOutcome({ status: 502, code: 'internal' }, false)).toBe('retry');
    expect(actionErrorOutcome({ status: 409, code: 'client_cancel_locked' }, false)).toBe('toast');
    expect(actionErrorOutcome({ status: 409, code: 'receipt_not_ready' }, false)).toBe('toast');
    expect(actionErrorOutcome({ status: 413, code: 'file_too_large' }, false)).toBe('toast');
    expect(actionErrorOutcome({ status: 403, code: 'forbidden' }, false)).toBe('toast');
    expect(actionErrorOutcome({ status: 429, code: 'rate_limited' }, false)).toBe('toast');
  });
});

describe('вид', () => {
  it('тон статуса: нужен мой шаг — акцент; завершено — успех; отмена, отказ, срок — опасность', () => {
    expect(statusTone('awaiting_confirmation', layoutActions(['confirm', 'decline'], 'client'))).toBe('action');
    expect(statusTone('awaiting_prepayment', layoutActions(['pay', 'cancel'], 'client'))).toBe('action');
    expect(statusTone('awaiting_prepayment', layoutActions(['remind_client', 'cancel'], 'seller'))).toBe('waiting');
    expect(statusTone('closed', layoutActions(['receipt_pdf'], 'seller'))).toBe('success');
    expect(statusTone('cancelled', layoutActions(['refund_confirmed'], 'seller'))).toBe('danger');
    expect(statusTone('expired', layoutActions([], 'seller'))).toBe('danger');
  });

  it('аватар: инициалы и один градиент у одного имени', () => {
    expect(initials('Анна Аксёнова')).toBe('АА');
    expect(initials('  саша ')).toBe('С');
    expect(initials('Барбершоп «Усы»')).toBe('Б');
    expect(avatarGradient('Саша')).toBe(avatarGradient(' саша '));
    expect(['red', 'orange', 'green', 'blue', 'purple']).toContain(avatarGradient('Ольга'));
  });
});

describe('тост после действия (прогон удобства ЗАДАЧА_08 F)', () => {
  it('говорит, что произошло, а не просто «Готово»', () => {
    expect(doneText('confirm')).toBe('Условия подтверждены. Исполнитель получил уведомление');
    expect(doneText('accept')).toMatch(/^Работа принята/);
    expect(doneText('receipt_pdf')).toBe('Готово');
  });
});
