// Тексты — это контракт с пользователем (SPEC §6), поэтому проверяем не «работает ли функция»,
// а три вещи, которые ломаются молча: экранирование пользовательского текста, лимиты карточки
// (DESIGN §6: ≤ 12 строк / ≤ 1200 символов) и подстановку сумм и дат в уведомления.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CancelRule, CardRole, DealStatus, ReminderKind } from '../src/types.js';
import { formatDateTime, formatDayMonth, formatDateTimeShort } from '../src/domain/time.js';
import { formatMoney } from '../src/domain/money.js';
import { receiptFileName } from '../src/domain/receipt/pdf.js';
import {
  ALREADY_DONE,
  ASK_CANCEL_REASON,
  BTN,
  COMMANDS,
  CONFIRM_CANCEL,
  CONFIRM_CLOSE_WITHOUT_RECEIPT,
  CONFIRM_DECLINE,
  DEAL_FINISHED_LINE,
  DEMO_CARD_PREFIX,
  E1,
  E5,
  H1,
  N1,
  N10,
  N11,
  N13,
  N14,
  N15,
  N2,
  N3,
  N8,
  P1,
  P2,
  S1,
  S2,
  type CardView,
  cancelRuleText,
  card,
  demoNotifyPrefix,
  esc,
  paymentLine,
  quote,
  railLabel,
  receiptLine,
  refundLine,
  reminderText,
  statusEmoji,
  statusText,
  testRailNotice,
} from '../src/texts.js';

// Даты форматируются относительно «сейчас» (год не показывается, если он текущий) — фиксируем время.
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-20T09:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

const ID = 'Ab3kZ9x1Qs';
const SCHEDULED = new Date('2026-09-27T11:00:00Z'); // вс, 27 сен, 14:00 МСК
const LINK = `https://max.ru/dogovorilis_bot?start=d_${ID}`;

// Record вместо массива: TypeScript не даст забыть новый статус / вид напоминания.
const ALL_STATUSES = Object.keys({
  awaiting_confirmation: true,
  changes_requested: true,
  declined: true,
  expired: true,
  awaiting_prepayment: true,
  scheduled: true,
  awaiting_acceptance: true,
  remarks: true,
  awaiting_payment: true,
  paid: true,
  closed: true,
  cancelled: true,
} satisfies Record<DealStatus, true>) as DealStatus[];

const ALL_REMINDERS = Object.keys({
  client_not_opened: true,
  confirmation_expired: true,
  prepayment_due: true,
  prepayment_overdue: true,
  event_tomorrow: true,
  event_passed: true,
  acceptance_due: true,
  payment_due: true,
  payment_overdue: true,
  receipt_due: true,
  receipt_deadline: true,
} satisfies Record<ReminderKind, true>) as ReminderKind[];

const ALL_RULES = Object.keys({
  free_24h: true,
  free_48h: true,
  nonrefundable: true,
  full_refund: true,
} satisfies Record<CancelRule, true>) as CancelRule[];

const CARD_ROLES: CardRole[] = ['seller', 'client', 'client_demo'];

function view(over: Partial<CardView> = {}): CardView {
  return {
    publicId: ID,
    status: 'awaiting_confirmation',
    role: 'seller',
    title: 'Маникюр с покрытием',
    description: 'Гель-лак, укрепление',
    scheduledAt: SCHEDULED,
    totalKopecks: 250_000,
    prepaymentKopecks: 50_000,
    remainingKopecks: 200_000,
    cancelRule: 'free_24h',
    hasPhoto: false,
    sellerName: 'Анна А.',
    clientName: null,
    demo: false,
    paymentLine: null,
    receiptLine: null,
    refundLine: null,
    clientLink: null,
    ...over,
  };
}

describe('esc', () => {
  it('экранирует каждый спецсимвол markdown MAX (SPEC §6)', () => {
    for (const ch of ['*', '_', '`', '[', ']', '^', '~', '>', '#', '\\']) {
      expect(esc(ch)).toBe(`\\${ch}`);
      expect(esc(`до ${ch} после`)).toBe(`до \\${ch} после`);
    }
  });

  it('не трогает обычный текст, включая кавычки-ёлочки, тире и эмодзи', () => {
    const plain = 'Маникюр «Люкс» — 2 часа 💅, цена 2 500 ₽';
    expect(esc(plain)).toBe(plain);
  });

  it('обезвреживает попытку сломать разметку', () => {
    const attack = '**не жирный** `не код` [ссылка](http://evil) # заголовок > цитата';
    const out = esc(attack);
    // Ни одного спецсимвола без предшествующего слэша.
    expect(/(^|[^\\])[*_`[\]^~>#]/.test(out)).toBe(false);
    expect(out).toContain('\\*\\*не жирный\\*\\*');
    expect(out).toContain('\\[ссылка\\]');
  });

  it('идемпотентен по смыслу: повторный esc не съедает слэши', () => {
    expect(esc(esc('*'))).toBe('\\\\\\*');
  });
});

describe('quote', () => {
  it('ставит «> » перед каждой строкой', () => {
    expect(quote('первая\nвторая')).toBe('> первая\n> вторая');
  });

  it('пустая строка остаётся маркером без висячего пробела', () => {
    expect(quote('a\n\nb')).toBe('> a\n>\n> b');
  });
});

describe('карточка (SPEC §6.4, DESIGN §6)', () => {
  it('исполнитель, awaiting_confirmation, клиент ещё не открыл — со ссылкой', () => {
    const text = card(view({ clientLink: LINK }));
    expect(text).toBe(
      [
        `⏳ **Маникюр с покрытием** · #${ID}`,
        'Статус: Ждём подтверждения клиента',
        '',
        '📌 Гель-лак, укрепление',
        `🗓 ${formatDateTime(SCHEDULED)}`,
        `💰 **${formatMoney(250_000)}** · предоплата **${formatMoney(50_000)}** (20%)`,
        '↩️ Отмена без потери предоплаты за 24 ч и более до срока',
        '',
        '👤 Исполнитель: Анна А.',
        '👤 Клиент: ещё не открыл ссылку',
        `🔗 Ссылка для клиента: \`${LINK}\``,
      ].join('\n'),
    );
  });

  it('клиент, awaiting_prepayment — статус с суммой, строка оплаты, макет', () => {
    const text = card(
      view({
        status: 'awaiting_prepayment',
        role: 'client',
        description: null,
        hasPhoto: true,
        clientName: 'Иван И.',
        paymentLine: paymentLine({
          kind: 'prepayment',
          state: 'awaiting',
          sumKopecks: 50_000,
          at: null,
          rail: null,
          provider: null,
          linkExpiresAt: null,
        }),
      }),
    );
    expect(text).toBe(
      [
        `💳 **Маникюр с покрытием** · #${ID}`,
        `Статус: Внесите предоплату ${formatMoney(50_000)}`,
        '',
        '📌 —',
        `🗓 ${formatDateTime(SCHEDULED)}`,
        `💰 **${formatMoney(250_000)}** · предоплата **${formatMoney(50_000)}** (20%)`,
        '↩️ Отмена без потери предоплаты за 24 ч и более до срока',
        '🖼 макет приложён',
        '',
        '👤 Исполнитель: Анна А.',
        '👤 Клиент: Иван И.',
        `Предоплата ${formatMoney(50_000)} ждёт оплаты`,
      ].join('\n'),
    );
    expect(text).not.toContain(DEMO_CARD_PREFIX);
  });

  it('демо-клиент, closed — префикс ДЕМО первой строкой, экранированное название', () => {
    const paidAt = new Date('2026-09-28T11:03:00Z');
    const text = card(
      view({
        status: 'closed',
        role: 'client_demo',
        demo: true,
        title: 'Маникюр *с* покрытием',
        description: 'Гель-лак',
        clientName: 'Анна А.',
        paymentLine: paymentLine({
          kind: 'final',
          state: 'received',
          sumKopecks: 200_000,
          at: paidAt,
          rail: 'link',
          provider: 'yookassa',
          linkExpiresAt: null,
        }),
        receiptLine: receiptLine({ attachedAt: new Date('2026-09-28T12:00:00Z'), deadline: null, taxModeNone: false }),
      }),
    );
    expect(text.split('\n')[0]).toBe(DEMO_CARD_PREFIX);
    expect(text).toBe(
      [
        DEMO_CARD_PREFIX,
        `✅ **Маникюр \\*с\\* покрытием** · #${ID}`,
        'Статус: Сделка закрыта, квитанция отправлена',
        '',
        '📌 Гель-лак',
        `🗓 ${formatDateTime(SCHEDULED)}`,
        `💰 **${formatMoney(250_000)}** · предоплата **${formatMoney(50_000)}** (20%)`,
        '↩️ Отмена без потери предоплаты за 24 ч и более до срока',
        '👤 Исполнитель: Анна А.',
        '👤 Клиент: Анна А.',
        `Остаток получен ${formatDateTimeShort(paidAt)} (ссылка ЮKassa, тест)`,
        'Файл чека приложен 28.09 (содержимое не проверялось)',
      ].join('\n'),
    );
  });

  it('без предоплаты — вместо процента «без предоплаты», без даты — «без даты»', () => {
    const text = card(view({ prepaymentKopecks: 0, remainingKopecks: 250_000, scheduledAt: null }));
    expect(text).toContain(`💰 **${formatMoney(250_000)}** · без предоплаты`);
    expect(text).toContain('🗓 без даты');
    expect(text).not.toContain('предоплата **');
  });

  it('суммы выводятся через formatMoney (неразрывный пробел), а не своим форматированием', () => {
    const text = card(view({ totalKopecks: 250_000 }));
    expect(text).toContain('2 500 ₽');
  });

  it('ссылка для клиента печатается только когда она передана', () => {
    expect(card(view({ clientLink: null }))).not.toContain('🔗 Ссылка для клиента');
    expect(card(view({ clientLink: LINK }))).toContain(`\`${LINK}\``);
  });

  it('многострочное описание не увеличивает число строк', () => {
    const text = card(view({ description: 'Первая строка\nвторая строка\n\nтретья' }));
    expect(text).toContain('📌 Первая строка вторая строка третья');
  });

  it('держит лимиты 12 строк и 1200 символов на самой перегруженной карточке', () => {
    const text = card(
      view({
        status: 'cancelled',
        role: 'client_demo',
        demo: true,
        title: 'Т'.repeat(80),
        description: 'о'.repeat(1000),
        totalKopecks: 100_000_000,
        prepaymentKopecks: 50_000_000,
        remainingKopecks: 50_000_000,
        cancelRule: 'nonrefundable',
        hasPhoto: true,
        clientName: 'Иван И.',
        paymentLine: paymentLine({
          kind: 'prepayment',
          state: 'received',
          sumKopecks: 50_000_000,
          at: SCHEDULED,
          rail: 'transfer',
          provider: 'manual',
          linkExpiresAt: null,
        }),
        receiptLine: receiptLine({ attachedAt: null, deadline: new Date('2026-10-09T20:59:00Z'), taxModeNone: false }),
        refundLine: refundLine({ prepaymentKopecks: 50_000_000, expected: false }),
        clientLink: LINK,
      }),
    );
    expect(text.split('\n').length).toBeLessThanOrEqual(12);
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).toContain('…'); // описание обрезано, а не выкинуто
  });

  it('лимиты соблюдаются для всех статусов и ролей', () => {
    for (const status of ALL_STATUSES) {
      for (const role of CARD_ROLES) {
        const text = card(
          view({
            status,
            role,
            clientName: role === 'seller' ? null : 'Иван И.',
            clientLink: role === 'seller' ? LINK : null,
            hasPhoto: true,
            description: 'о'.repeat(600),
            paymentLine: paymentLine({
              kind: 'final',
              state: 'awaiting',
              sumKopecks: 200_000,
              at: null,
              rail: null,
              provider: null,
              linkExpiresAt: null,
            }),
            receiptLine: receiptLine({ attachedAt: null, deadline: new Date('2026-10-09T20:59:00Z'), taxModeNone: false }),
          }),
        );
        expect(text.split('\n').length, `${status}/${role}`).toBeLessThanOrEqual(12);
        expect(text.length, `${status}/${role}`).toBeLessThanOrEqual(1200);
        expect(text).not.toContain('undefined');
      }
    }
  });
});

describe('статусы', () => {
  it('эмодзи задан для каждого статуса (SPEC §5.1)', () => {
    for (const status of ALL_STATUSES) {
      expect(statusEmoji(status), status).toBeTruthy();
    }
    expect(statusEmoji('awaiting_confirmation')).toBe('⏳');
    expect(statusEmoji('paid')).toBe('🧾');
    expect(statusEmoji('cancelled')).toBe('🚫');
  });

  it('текст задан для каждой пары (статус, роль) и не содержит undefined/NaN', () => {
    for (const status of ALL_STATUSES) {
      for (const role of CARD_ROLES) {
        const text = statusText(status, role, {
          prepaymentKopecks: 50_000,
          remainingKopecks: 200_000,
          scheduledAt: SCHEDULED,
        });
        expect(text.length, `${status}/${role}`).toBeGreaterThan(0);
        expect(text, `${status}/${role}`).not.toMatch(/undefined|NaN|\[object/);
      }
      // Демо-клиент читает клиентские тексты (SPEC §12).
      const args = { prepaymentKopecks: 50_000, remainingKopecks: 200_000, scheduledAt: SCHEDULED };
      expect(statusText(status, 'client_demo', args)).toBe(statusText(status, 'client', args));
    }
  });

  it('роль различает формулировку и подставляет сумму', () => {
    const args = { prepaymentKopecks: 50_000, remainingKopecks: 200_000, scheduledAt: null };
    expect(statusText('awaiting_confirmation', 'seller', args)).toBe('Ждём подтверждения клиента');
    expect(statusText('awaiting_confirmation', 'client', args)).toBe('Подтвердите условия');
    expect(statusText('awaiting_prepayment', 'seller', args)).toBe(`Ждём предоплату ${formatMoney(50_000)}`);
    expect(statusText('awaiting_prepayment', 'client', args)).toBe(`Внесите предоплату ${formatMoney(50_000)}`);
    expect(statusText('awaiting_payment', 'seller', args)).toBe(`Ждём остаток ${formatMoney(200_000)}`);
    expect(statusText('paid', 'seller', args)).toBe('Оплачено. Приложите чек');
    expect(statusText('paid', 'client', args)).toBe('Оплачено. Ждём чек от исполнителя');
  });

  it('scheduled подставляет дату, если она есть', () => {
    const withDate = statusText('scheduled', 'client', {
      prepaymentKopecks: 0,
      remainingKopecks: 0,
      scheduledAt: SCHEDULED,
    });
    expect(withDate).toContain(formatDateTime(SCHEDULED));
    const noDate = statusText('scheduled', 'client', { prepaymentKopecks: 0, remainingKopecks: 0, scheduledAt: null });
    expect(noDate).not.toContain('сен');
  });

  it('правила отмены — четыре разных текста (SPEC §6.4)', () => {
    const texts = ALL_RULES.map((r) => cancelRuleText(r));
    expect(new Set(texts).size).toBe(4);
    expect(cancelRuleText('free_24h')).toBe('Отмена без потери предоплаты за 24 ч и более до срока');
    expect(cancelRuleText('free_48h')).toContain('48 ч');
    expect(cancelRuleText('nonrefundable')).toBe('Предоплата не возвращается при отмене клиентом');
    expect(cancelRuleText('full_refund')).toBe('Предоплата возвращается при любой отмене');
  });
});

describe('строки карточки', () => {
  it('строка оплаты по состояниям', () => {
    expect(
      paymentLine({ kind: 'final', state: 'awaiting', sumKopecks: 200_000, at: null, rail: null, provider: null, linkExpiresAt: null }),
    ).toBe(`Остаток ${formatMoney(200_000)} ждёт оплаты`);

    const expires = new Date('2026-09-20T12:03:00Z');
    expect(
      paymentLine({
        kind: 'prepayment',
        state: 'link_issued',
        sumKopecks: 50_000,
        at: null,
        rail: 'link',
        provider: 'yookassa',
        linkExpiresAt: expires,
      }),
    ).toBe(`Ссылка на оплату ${formatMoney(50_000)} действует до ${formatDateTimeShort(expires)}`);

    expect(
      paymentLine({
        kind: 'prepayment',
        state: 'claimed',
        sumKopecks: 50_000,
        at: expires,
        rail: 'transfer',
        provider: 'manual',
        linkExpiresAt: null,
      }),
    ).toContain('клиент сообщил о переводе');

    expect(
      paymentLine({
        kind: 'prepayment',
        state: 'received',
        sumKopecks: 50_000,
        at: expires,
        rail: 'link',
        provider: 'tbank',
        linkExpiresAt: null,
      }),
    ).toBe(`Предоплата получена ${formatDateTimeShort(expires)} (СБП Т-Банк, DEMO)`);
  });

  it('строка чека: приложен / дедлайн / без чека', () => {
    expect(receiptLine({ attachedAt: new Date('2026-09-22T09:00:00Z'), deadline: null, taxModeNone: false })).toBe(
      'Файл чека приложен 22.09 (содержимое не проверялось)',
    );
    const deadline = new Date('2026-10-09T20:59:00Z');
    expect(receiptLine({ attachedAt: null, deadline, taxModeNone: false })).toBe(`Чек: до ${formatDayMonth(deadline)}`);
    expect(receiptLine({ attachedAt: null, deadline: null, taxModeNone: true })).toContain('не требуется');
  });

  it('строка возврата предоплаты (SPEC §5.3)', () => {
    expect(refundLine({ prepaymentKopecks: 50_000, expected: true })).toBe(`Предоплата ${formatMoney(50_000)}: ожидается возврат`);
    expect(refundLine({ prepaymentKopecks: 50_000, expected: false })).toBe(
      `Предоплата ${formatMoney(50_000)} не возвращается по правилу отмены`,
    );
    expect(refundLine({ prepaymentKopecks: 0, expected: true })).toBeNull();
    expect(refundLine({ prepaymentKopecks: 50_000, expected: null })).toBeNull();
  });

  it('подпись рейла', () => {
    expect(railLabel('transfer', 'manual')).toBe('перевод по реквизитам');
    expect(railLabel('link', 'yookassa')).toBe('ссылка ЮKassa, тест');
    expect(railLabel('link', 'tbank')).toBe('СБП Т-Банк, DEMO');
  });
});

describe('уведомления (SPEC §6.5)', () => {
  it('N2 подставляет сумму предоплаты или дату', () => {
    expect(N2({ client: 'Иван И.', id: ID, prepaymentKopecks: 50_000, scheduledAt: SCHEDULED })).toBe(
      `✅ Иван И. подтвердил(а) условия #${ID}. Ждём предоплату ${formatMoney(50_000)}.`,
    );
    expect(N2({ client: 'Иван И.', id: ID, prepaymentKopecks: 0, scheduledAt: SCHEDULED })).toBe(
      `✅ Иван И. подтвердил(а) условия #${ID}. Всё согласовано на ${formatDateTime(SCHEDULED)}.`,
    );
    expect(N2({ client: 'Иван И.', id: ID, prepaymentKopecks: 0, scheduledAt: null })).toBe(
      `✅ Иван И. подтвердил(а) условия #${ID}. Всё согласовано.`,
    );
  });

  it('N8 подставляет сумму и рейл', () => {
    expect(N8({ id: ID, sumKopecks: 50_000, rail: 'link', provider: 'yookassa' })).toBe(
      `💸 Предоплата ${formatMoney(50_000)} по #${ID} получена (ссылка ЮKassa, тест).`,
    );
    expect(N8({ id: ID, sumKopecks: 50_000, rail: 'transfer', provider: 'manual' })).toContain('(перевод по реквизитам)');
  });

  it('N13 подставляет дедлайн чека словами', () => {
    const deadline = new Date('2026-10-09T20:59:00Z');
    expect(N13({ id: ID, deadline })).toBe(
      `🧾 #${ID} оплачена полностью. Сформируйте чек в «Мой налог» сейчас и приложите его сюда. Для безналичных расчётов закон допускает до ${formatDayMonth(deadline)}.`,
    );
    expect(N13({ id: ID, deadline })).toContain('9 октября');
  });

  it('N15: кто отменил, экранированная причина и строка про предоплату', () => {
    const refund = refundLine({ prepaymentKopecks: 50_000, expected: true });
    expect(N15({ id: ID, by: 'client', reason: 'Заболел*а*', refundLine: refund })).toBe(
      `🚫 #${ID} отменена клиентом: Заболел\\*а\\*. Предоплата ${formatMoney(50_000)}: ожидается возврат`,
    );
    expect(N15({ id: ID, by: 'seller', reason: null, refundLine: null })).toBe(`🚫 #${ID} отменена исполнителем.`);
    expect(N15({ id: ID, by: 'system', reason: null, refundLine: null })).toContain('отменена автоматически');
  });

  it('N3 и N11 оформляют пользовательский текст цитатой и экранируют его', () => {
    const n3 = N3({ client: 'Иван И.', id: ID, text: 'Давайте 15:00\nи *без* предоплаты' });
    expect(n3.startsWith(`✏️ Иван И. предлагает изменения по #${ID}:\n> Давайте 15:00\n> и \\*без\\* предоплаты\n\n`)).toBe(true);
    // Экрана правки условий (T5) нет — N3 честно говорит, что делать (ЗАДАЧА_03 S4)
    expect(n3).toContain('создайте новую сделку');
    expect(N11({ client: 'Иван И.', id: ID, text: '# плохо' })).toContain('> \\# плохо');
  });

  it('имя клиента экранируется во всех уведомлениях, где оно есть', () => {
    const evil = 'Иван *VIP*';
    expect(N1({ client: evil, id: ID })).toContain('Иван \\*VIP\\*');
    expect(N10({ client: evil, id: ID, remainingKopecks: 0 })).toContain('Иван \\*VIP\\*');
    expect(N10({ client: evil, id: ID, remainingKopecks: 0 })).toContain('Оплачено полностью');
    expect(N10({ client: evil, id: ID, remainingKopecks: 200_000 })).toContain(`Ждём остаток ${formatMoney(200_000)}`);
    expect(P2({ client: evil, sumKopecks: 50_000, id: ID })).toContain('Иван \\*VIP\\*');
  });

  it('N14 упоминает чек только когда он есть', () => {
    expect(N14({ id: ID, withReceipt: true })).toBe(`✅ Сделка #${ID} закрыта. Квитанция во вложении, чек — выше.`);
    expect(N14({ id: ID, withReceipt: false })).toBe(`✅ Сделка #${ID} закрыта. Квитанция во вложении.`);
  });
});

describe('рейл «перевод» (SPEC §9.1) и пометки тестовой среды', () => {
  it('P1: сумма, реквизиты в моноширинном блоке, подсказка про чат MAX', () => {
    const text = P1({ sumKopecks: 50_000, payoutDetails: 'СБП +7 900 000-00-00, Т-Банк' });
    expect(text).toContain(`Переведите ${formatMoney(50_000)} исполнителю:`);
    expect(text).toContain('`СБП +7 900 000-00-00, Т-Банк`');
    expect(text).toContain('«Перевести деньги»');
  });

  it('реквизиты экранируются (исполнитель вводит их сам)', () => {
    expect(P1({ sumKopecks: 100, payoutDetails: 'карта `1234`' })).toContain('карта \\`1234\\`');
  });

  it('пометка тестовой среды по провайдеру (SPEC §18)', () => {
    expect(testRailNotice('yookassa')).toContain('ЮKassa');
    expect(testRailNotice('tbank')).toContain('DEMO-терминал');
    for (const p of ['yookassa', 'tbank', 'manual'] as const) {
      expect(testRailNotice(p)).toContain('🧪');
    }
  });
});

describe('напоминания (SPEC §10.2)', () => {
  it('текст задан для каждого вида и содержит id сделки', () => {
    for (const kind of ALL_REMINDERS) {
      const text = reminderText(kind, {
        id: ID,
        title: 'Маникюр с покрытием',
        sumKopecks: 50_000,
        scheduledAt: SCHEDULED,
        deadline: new Date('2026-10-09T20:59:00Z'),
      });
      expect(text.length, kind).toBeGreaterThan(0);
      expect(text, kind).toContain(`#${ID}`);
      expect(text, kind).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it('подставляет суммы, дату и экранированное название', () => {
    const base = { id: ID, title: 'Маникюр *люкс*', sumKopecks: 50_000, scheduledAt: SCHEDULED, deadline: null };
    expect(reminderText('prepayment_due', base)).toBe(`Напоминаем: предоплата ${formatMoney(50_000)} по #${ID} ещё не внесена.`);
    expect(reminderText('payment_due', base)).toBe(`Остаток ${formatMoney(50_000)} по #${ID} ждёт оплаты.`);
    expect(reminderText('event_tomorrow', base)).toBe(`Завтра ${formatDateTime(SCHEDULED)}: Маникюр \\*люкс\\* (#${ID}).`);
    expect(reminderText('event_tomorrow', { ...base, scheduledAt: null })).toContain('Завтра по плану');
    expect(reminderText('receipt_deadline', base)).toContain('422-ФЗ');
  });

  it('ускоренное в демо напоминание несёт пометку, обычное — нет', () => {
    const base = { id: ID, title: 'Маникюр', sumKopecks: 50_000, scheduledAt: SCHEDULED, deadline: null };
    const fast = reminderText('receipt_due', { ...base, accelerated: true });
    expect(fast.startsWith(reminderText('receipt_due', base))).toBe(true);
    expect(fast).toContain('🧪 в демо — ускорено');
    for (const kind of ALL_REMINDERS) expect(reminderText(kind, base), kind).not.toContain('ускорено');
  });
});

describe('меню, ошибки, кнопки', () => {
  it('S1 и H1 — дословно по SPEC §6.2 и §6.8', () => {
    expect(S1.startsWith('👋 Это «Договорились» — карточка договорённости прямо в чате MAX.')).toBe(true);
    expect(S1.trimEnd().endsWith('Что дальше?')).toBe(true);
    expect(H1.split('\n')[0]).toBe('Как это работает');
    expect(H1).toContain('Деньги идут напрямую исполнителю. Мы не платёжный агент и не храним реквизиты карт.');
    expect(H1.split('\n').filter((l) => /^\d\./.test(l))).toHaveLength(5);
  });

  it('S2 экранирует имя исполнителя', () => {
    expect(S2('Анна `A`')).toBe(
      'Исполнитель **Анна \\`A\\`** предлагает договорённость. Проверьте условия и подтвердите — или предложите изменения.',
    );
  });

  it('команды для setMyCommands — без слэша и с описанием (SPEC §6.1)', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(['start', 'new', 'deals', 'settings', 'help', 'cancel']);
    for (const c of COMMANDS) {
      expect(c.name).not.toContain('/');
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it('подтверждения называют сделку', () => {
    for (const text of [CONFIRM_DECLINE(ID), CONFIRM_CANCEL(ID), CONFIRM_CLOSE_WITHOUT_RECEIPT(ID)]) {
      expect(text).toContain(`#${ID}`);
      expect(text).toContain('?');
    }
  });

  it('тексты ошибок и служебные строки непустые и дословные', () => {
    expect(E1).toBe('Это действие уже недоступно — карточка обновлена.');
    expect(E5).toBe('Слишком длинно — до 500 символов.');
    expect(ALREADY_DONE).toBe('Это уже сделано — карточка актуальна.');
    expect(DEAL_FINISHED_LINE).toBe('Сделка завершена');
    expect(ASK_CANCEL_REASON).toContain('«Без причины»');
  });

  it('префиксы демо-режима (SPEC §12)', () => {
    expect(DEMO_CARD_PREFIX).toBe('🧪 **ДЕМО — так видит клиент**');
    expect(demoNotifyPrefix('client')).toBe('🧪 (клиенту) ');
    expect(demoNotifyPrefix('seller')).toBe('🧪 (исполнителю) ');
  });

  it('все подписи кнопок непустые и без лишних пробелов', () => {
    for (const [key, label] of Object.entries(BTN)) {
      expect(label.length, key).toBeGreaterThan(0);
      expect(label, key).toBe(label.trim());
    }
    expect(BTN.confirm).toBe('✅ Подтверждаю');
    expect(BTN.accept).toBe('👍 Принимаю');
    expect(BTN.transferDone).toBe('✅ Я перевёл(а)');
    expect(BTN.transferReceived).toBe('✅ Получил(а)');
  });
});

/**
 * Имя файла квитанции — это то, что видит получатель в MAX, и одновременно мина:
 * SDK 0.3.1 кладёт его в `Content-Disposition` без кодирования по RFC 5987, поэтому любой
 * не-ASCII символ роняет ЗАГРУЗКУ ЦЕЛИКОМ («Invalid character in header content») — квитанция
 * не уходит ни одной из сторон. Поймано вживую 21.09.2026 при попытке назвать файл по-русски.
 * Тест держит инвариант: если кто-то снова захочет «Квитанция_…», он узнает об этом здесь,
 * а не в день проверки.
 */
describe('имя файла квитанции', () => {
  it('состоит только из ASCII — иначе загрузка в MAX падает', () => {
    const name = receiptFileName('AbC123xyZ0');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x20-\x7E]+$/.test(name)).toBe(true);
  });

  it('содержит public_id и расширение .pdf, без таймстампов и мусора', () => {
    expect(receiptFileName('AbC123xyZ0')).toBe('Kvitanciya-AbC123xyZ0.pdf');
  });
});
