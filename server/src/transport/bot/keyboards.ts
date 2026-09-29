// Клавиатуры карточек и уведомлений. Какие кнопки видит каждая роль в каждом статусе — SPEC §5.5;
// подписи — только из texts.BTN; коды — только из callbacks.cb (SPEC §13).
// Ограничения платформы: ≤ 7 кнопок в ряду и ≤ 3 для link/open_app (CONTRACTS §1.2, §1.9).
import { Keyboard } from '@maxhub/max-bot-api';
import type { Button } from '@maxhub/max-bot-api/types';
import { botUsername } from '../../config.js';
import { acceptTimeLabel, BTN, shareInvite } from '../../texts.js';
import type { AttachmentRequest } from '../../integrations/max/gateway.js';
import type { CardRole, DealBundle, Payment, PaymentKind, TimeProposal } from '../../types.js';
import { livePayment, remaining } from '../../types.js';
import { cb } from './callbacks.js';

export type Row = Button[];

export function keyboard(rows: Row[]): AttachmentRequest {
  const clean = rows.filter((r) => r.length > 0);
  return Keyboard.inlineKeyboard(clean) as unknown as AttachmentRequest;
}

/**
 * Ширина подписи «на глаз»: латиница и кириллица — один знак, эмодзи — примерно два.
 * Служебные невидимые символы (вариационный селектор, склейка) не занимают места.
 */
const INVISIBLE = /[\uFE0F\u200D]/g;

export function labelWidth(text: string): number {
  let width = 0;
  for (const ch of text.replace(INVISIBLE, '')) {
    const code = ch.codePointAt(0) ?? 0;
    width += code > 0x2000 ? 2 : 1;
  }
  return width;
}

/**
 * Сколько помещается в кнопку, когда в ряду их две. Клиент MAX не переносит подпись,
 * а обрезает многоточием: «💳 Оплатить по ссы…». Проверено вживую 21.09.2026 на телефоне
 * и на web.max.ru — обрезается в обоих.
 */
export const PAIR_LABEL_WIDTH = 16;

/**
 * Два действия рядом — только если обе подписи короткие; иначе каждое занимает свой ряд.
 * Ряд целиком всегда влезает, поэтому длинную подпись достаточно оставить одну.
 */
export function pair(a: Button, b: Button): Row[] {
  const fits = (btn: Button) => labelWidth((btn as { text?: string }).text ?? '') <= PAIR_LABEL_WIDTH;
  return fits(a) && fits(b) ? [[a, b]] : [[a], [b]];
}

const callback = (text: string, payload: string) => Keyboard.button.callback(text, payload);
const link = (text: string, url: string) => Keyboard.button.link(text, url);
const clipboard = (text: string, payload: string) => Keyboard.button.clipboard(text, payload);
const openApp = (text: string, bot: string, payload?: string) => Keyboard.button.openApp(text, bot, undefined, payload);

/**
 * «✏️ Изменить условия» (T5): мини-приложение открывается сразу на форме правки — start_param `edit_<id>` (SPEC §13).
 * Подпись длинная — всегда своим рядом (≤ 3 open_app/link в ряду, CONTRACTS §1.9).
 */
export function editTermsButton(bot: string, publicId: string): Button {
  return openApp(BTN.editTerms, bot, `edit_${publicId}`);
}

/**
 * Главное меню (SPEC §6.2): пять кнопок. Демо и сделка-пример спрятаны за «🧪 Попробовать» —
 * меню не перегружено пробными путями (ЗАДАЧА_04 A3). Мини-приложение открывается кнопками open_app.
 */
export function menuKeyboard(a: { botUsername: string; demoMode: boolean }): AttachmentRequest {
  const rows: Row[] = [
    ...pair(openApp(BTN.newDeal, a.botUsername, 'new'), openApp(BTN.myDeals, a.botUsername, 'deals')),
    ...pair(openApp(BTN.settings, a.botUsername, 'settings'), callback(BTN.help, 'help')),
    [callback(BTN.tryIt, 'try')],
  ];
  return keyboard(rows);
}

/** Пробные пути: демо одному (если DEMO_MODE) и сделка-пример для второго человека, плюс возврат в меню. */
export function tryKeyboard(a: { demoMode: boolean }): AttachmentRequest {
  const rows: Row[] = [];
  if (a.demoMode) rows.push([callback(BTN.tryDemo, 'dm:new')]);
  rows.push([callback(BTN.exampleDeal, 'ex:new')]);
  rows.push([callback(BTN.menu, 'menu')]);
  return keyboard(rows);
}

/**
 * Шеринг ссылки сделки в существующий чат MAX (SPEC §6.4). У `:share` документирован только `text`
 * (CONTRACTS §5.3), поэтому ссылка — внутри текста, ровно один раз, отдельной строкой.
 */
export function shareUrl(link_: string, invite: string): string {
  return `https://max.ru/:share?text=${encodeURIComponent(`${invite}\n${link_}`)}`;
}

export type CardKeyboardOptions = {
  botUsername: string;
  demoMode: boolean;
  /** ссылка вида https://max.ru/<bot>?start=d_<id> */
  dealLink: string;
  /** доступность рейла «ссылка» по SPEC §9.1 (провайдер подключён, рейл включён, сумма ≥ минимума) */
  linkRailVisible: boolean;
  transferRailVisible: boolean;
  /** предыдущая ссылка истекла или отменена — кнопка называется «🆕 Новая ссылка» и шлёт `nl` (§9.1, §14 п. 7) */
  linkRailRetry: boolean;
};

/**
 * Кнопки карточки по таблице §5.5. Роль `client_demo` получает клиентские кнопки:
 * в демо это тот же пользователь, но карточка и действия — клиентские (SPEC §12).
 */
export function cardKeyboard(bundle: DealBundle, role: CardRole, o: CardKeyboardOptions): AttachmentRequest | null {
  const id = bundle.deal.publicId;
  const status = bundle.deal.status;
  const isSeller = role === 'seller';
  const rows: Row[] = [];

  if (status === 'closed' || status === 'declined' || status === 'expired' || status === 'cancelled') {
    // Отменённая сделка с ожидаемым возвратом: каждая сторона отмечает свой шаг (SPEC §5.3, ЗАДАЧА_03 H1).
    const d = bundle.deal;
    const refundOpen = status === 'cancelled' && d.cancelRefundExpected === true && !d.refundReceivedAt;
    if (refundOpen && isSeller && !d.refundSentAt) rows.push([callback(BTN.refundSent, cb('rf', id, 's'))]);
    if (refundOpen && !isSeller) rows.push([callback(BTN.refundReceived, cb('rf', id, 'c'))]);
    rows.push([callback(BTN.receiptPdf, cb('pdf', id))]);
    // «🔁 Повторить» (ЗАДАЧА_04 F): форма с условиями этой сделки, «тот же клиент» — если он был. Демо не повторяется.
    if (isSeller && !d.demo) rows.push([openApp(BTN.repeat, o.botUsername, `repeat_${id}`)]);
    return keyboard(rows);
  }

  if (isSeller) {
    switch (status) {
      // «✏️ Изменить условия» (T5) — пока клиент не подтвердил: и до его входа по ссылке, и после (SPEC §5.5).
      case 'awaiting_confirmation':
        if (!bundle.deal.clientUserId) {
          const invite = shareInvite(bundle.version.title, bundle.version.scheduledAt);
          rows.push(...pair(link(BTN.sendToMax, shareUrl(o.dealLink, invite)), clipboard(BTN.copyLink, o.dealLink)));
          rows.push([editTermsButton(o.botUsername, id)]);
          if (o.demoMode) rows.push([callback(BTN.openAsClient, cb('dm', id))]);
        } else {
          rows.push([editTermsButton(o.botUsername, id)]);
          rows.push([callback(BTN.remindClient, cb('rs', id))]);
        }
        break;
      case 'changes_requested':
        // Клиент выбрал время в календаре (ЗАДАЧА_08 D): принять его — первым действием, одной кнопкой.
        if (bundle.timeProposal?.status === 'pending') rows.push([acceptTimeButton(id, bundle.timeProposal)]);
        rows.push([editTermsButton(o.botUsername, id)]);
        rows.push([callback(BTN.keepAsIs, cb('ka', id))]);
        break;
      case 'awaiting_prepayment':
      case 'awaiting_payment': {
        // Клиент сообщил о переводе — подтверждение живёт в самой карточке, а не только в уведомлении P2.
        const live = liveFor(bundle, status === 'awaiting_prepayment' ? 'prepayment' : 'final');
        if (live?.rail === 'transfer' && live.status === 'claimed') {
          rows.push([callback(BTN.transferReceived, cb('tr', id, 'g', live.id))]);
          rows.push([callback(BTN.transferNotReceived, cb('tr', id, 'n', live.id))]);
        } else {
          rows.push([callback(BTN.remindClient, cb('rs', id))]);
        }
        break;
      }
      case 'scheduled':
        rows.push([callback(BTN.done, cb('dn', id))]);
        break;
      case 'awaiting_acceptance':
        rows.push([callback(BTN.remindClient, cb('rs', id))]);
        break;
      case 'remarks':
        rows.push([callback(BTN.fixed, cb('fx', id))]);
        break;
      case 'paid':
        rows.push([callback(BTN.attachReceipt, cb('rc', id))]);
        rows.push([callback(BTN.closeWithoutReceipt, cb('nc', id))]);
        break;
    }
    // «Отменить» доступна исполнителю во всех нетерминальных статусах, кроме paid (§5.2 T16).
    if (status !== 'paid') rows.push([callback(BTN.cancelDeal, cb('cn', id))]);
    return keyboard(rows);
  }

  // клиент (и демо-клиент)
  switch (status) {
    case 'awaiting_confirmation':
      // Версия на кнопке: подтверждается ровно то, что клиент видит (T3; после T5 старая кнопка не сработает).
      rows.push([callback(BTN.confirm, cb('cf', id, undefined, bundle.deal.currentVersion))]);
      rows.push(...pair(callback(BTN.requestChanges, cb('cr', id)), callback(BTN.decline, cb('dc', id))));
      break;
    case 'changes_requested':
      return null; // ждём исполнителя — кнопок нет
    case 'awaiting_prepayment':
    case 'awaiting_payment': {
      // Живая ссылка вытесняет выбор рейла: пока она действует, клиенту нужны «Перейти» и «Проверить».
      const live = liveFor(bundle, status === 'awaiting_prepayment' ? 'prepayment' : 'final');
      if (live?.rail === 'link' && live.status === 'pending' && live.confirmationUrl) {
        rows.push([link(BTN.goToPayment, live.confirmationUrl)]);
        rows.push([callback(BTN.checkPayment, cb('pc', id, undefined, live.id))]);
      } else if (live?.rail === 'transfer' && live.status === 'pending') {
        // Реквизиты уже в тексте карточки (§6.4) — здесь только «перевёл» и отказ от этого способа.
        rows.push([callback(BTN.transferDone, cb('tr', id, 'c', live.id))]);
        rows.push([callback(BTN.transferCancel, cb('tr', id, 'x', live.id))]);
      } else if (live?.rail === 'transfer' && live.status === 'claimed') {
        // Клиент сообщил о переводе — ждём исполнителя, кнопок рейла нет.
      } else {
        // Подписи рейлов длинные, поэтому каждая занимает свой ряд — иначе MAX их обрежет.
        if (o.linkRailVisible) rows.push([callback(o.linkRailRetry ? BTN.newLink : BTN.payByLink, cb(o.linkRailRetry ? 'nl' : 'pl', id))]);
        if (o.transferRailVisible) rows.push([callback(BTN.payByTransfer, cb('pt', id))]);
      }
      if (status === 'awaiting_prepayment') rows.push([callback(BTN.cancelDeal, cb('cn', id))]);
      break;
    }
    case 'scheduled':
      rows.push([callback(BTN.cancelDeal, cb('cn', id))]);
      break;
    case 'awaiting_acceptance':
      rows.push(...pair(callback(BTN.accept, cb('ac', id)), callback(BTN.remarks, cb('rm', id))));
      break;
    case 'remarks':
    case 'paid':
      return null; // ждём исполнителя
  }
  return rows.length ? keyboard(rows) : null;
}

/**
 * Ссылочный платёж (SPEC §9.1 п. 2): живая ссылка — [Перейти к оплате] [🔄 Проверить оплату];
 * истёкшая или отменённая — [🆕 Новая ссылка]. Та же клавиатура уходит и в ответе на нажатие,
 * и в карточке, чтобы кнопки нигде не разошлись.
 */
export function linkPaymentKeyboard(publicId: string, payment: Payment): AttachmentRequest {
  if (payment.status === 'pending' && payment.confirmationUrl) {
    return keyboard([
      [link(BTN.goToPayment, payment.confirmationUrl)],
      [callback(BTN.checkPayment, cb('pc', publicId, undefined, payment.id))],
    ]);
  }
  return keyboard([[callback(BTN.newLink, cb('nl', publicId))]]);
}

/** Реквизиты для перевода: подтверждение факта перевода клиентом (SPEC §9.1 п. 2). */
export function transferKeyboard(publicId: string, paymentId: number): AttachmentRequest {
  return keyboard([
    [Keyboard.button.callback(BTN.transferDone, cb('tr', publicId, 'c', paymentId))],
    [Keyboard.button.callback(BTN.transferCancel, cb('tr', publicId, 'x', paymentId))],
  ]);
}

/** Второе «Не вижу» подряд (P3_DISPUTE): оплата по ссылке — первой, повтор «перевёл» — второй. */
export function transferDisputeKeyboard(publicId: string, paymentId: number, linkAvailable: boolean): AttachmentRequest {
  const rows: Row[] = [];
  if (linkAvailable) rows.push([Keyboard.button.callback(BTN.payByLink, cb('pl', publicId))]);
  rows.push([Keyboard.button.callback(BTN.transferDone, cb('tr', publicId, 'c', paymentId))]);
  return keyboard(rows);
}

/** Исполнителю: клиент сообщил о переводе (P2). */
export function transferCheckKeyboard(publicId: string, paymentId: number): AttachmentRequest {
  return keyboard([
    [Keyboard.button.callback(BTN.transferReceived, cb('tr', publicId, 'g', paymentId))],
    [Keyboard.button.callback(BTN.transferNotReceived, cb('tr', publicId, 'n', paymentId))],
  ]);
}

/**
 * Подтверждение необратимого действия отдельной кнопкой (§5.2 T7, T16, T15). Показывается на месте
 * карточки; «Назад» (`op`) возвращает обычную карточку.
 */
export function confirmKeyboard(code: 'dc' | 'cn' | 'nc', publicId: string, yesText: string): AttachmentRequest {
  return keyboard([[Keyboard.button.callback(yesText, cb(code, publicId, 'y'))], [Keyboard.button.callback(BTN.back, cb('op', publicId))]]);
}

/**
 * Причина отмены: «Без причины» (§6.6) и «Не отменять». Второе обязательно: пока ждём причину,
 * любой текст исполнителя отменил бы сделку — передумавшему нужен явный выход (`op` снимает ожидание).
 */
export function cancelReasonKeyboard(publicId: string): AttachmentRequest {
  return keyboard([
    [Keyboard.button.callback(BTN.noReason, cb('cn', publicId, 'y', 'none'))],
    [Keyboard.button.callback(BTN.keepDeal, cb('op', publicId))],
  ]);
}

/** «✅ Принять пн 5 окт, 14:00» — принять предложенное клиентом время (SPEC §7.10). Подпись длинная — своим рядом. */
export function acceptTimeButton(publicId: string, proposal: Pick<TimeProposal, 'id' | 'scheduledAt'>): Button {
  return callback(acceptTimeLabel(proposal.scheduledAt), cb('tp', publicId, undefined, proposal.id));
}

/**
 * «Предложить изменения» (ЗАДАЧА_08 D): на месте карточки — выбор пути. «Другое время» открывает мини-приложение на
 * календаре исполнителя (start_param `time_<id>`), «Написать текстом» — прежний ввод (T4), «Назад» — карточка.
 */
export function changeKindKeyboard(publicId: string): AttachmentRequest {
  return keyboard([
    [openApp(BTN.otherTime, botUsername(), `time_${publicId}`)],
    [callback(BTN.writeText, cb('cr', publicId, 't'))],
    [callback(BTN.back, cb('op', publicId))],
  ]);
}

/** N3T — исполнителю: принять время одной кнопкой или предложить другое на форме правки (T5). */
export function n3tKeyboard(publicId: string, proposal: Pick<TimeProposal, 'id' | 'scheduledAt'>): AttachmentRequest {
  return keyboard([[acceptTimeButton(publicId, proposal)], [openApp(BTN.proposeOther, botUsername(), `edit_${publicId}`)]]);
}

/** Клиенту, когда предложенное время успели занять: сразу выбрать другое. */
export function otherTimeKeyboard(publicId: string): AttachmentRequest {
  return keyboard([[openApp(BTN.otherTime, botUsername(), `time_${publicId}`)], [callback(BTN.open, cb('op', publicId))]]);
}

/** Кнопки уведомлений N3 (предложены изменения: изменить условия, оставить как есть, отменить) и N11 (замечания). */
export function n3Keyboard(publicId: string): AttachmentRequest {
  return keyboard([
    [editTermsButton(botUsername(), publicId)],
    [Keyboard.button.callback(BTN.keepAsIs, cb('ka', publicId))],
    [Keyboard.button.callback(BTN.cancelDeal, cb('cn', publicId))],
  ]);
}

export function n11Keyboard(publicId: string): AttachmentRequest {
  return keyboard([
    [Keyboard.button.callback(BTN.fixed, cb('fx', publicId))],
    [Keyboard.button.callback(BTN.cancelDeal, cb('cn', publicId))],
  ]);
}

/** Кнопки уведомления N13 (сделка оплачена, нужен чек). */
export function n13Keyboard(publicId: string): AttachmentRequest {
  return keyboard([
    [Keyboard.button.callback(BTN.attachReceipt, cb('rc', publicId))],
    [Keyboard.button.callback(BTN.closeWithoutReceipt, cb('nc', publicId))],
  ]);
}

/** Утренняя сводка (ЗАДАЧА_04 B2): «📅 Расписание» открывает мини-приложение на «Моих сделках». */
export function digestKeyboard(botUsername: string): AttachmentRequest {
  return keyboard([[openApp(BTN.schedule, botUsername, 'deals')]]);
}

/** Одна кнопка «Открыть» — для коротких уведомлений и напоминаний. */
export function openKeyboard(publicId: string): AttachmentRequest {
  return keyboard([[Keyboard.button.callback(BTN.open, cb('op', publicId))]]);
}

/** Какой платёж ждёт оплаты — нужно и карточке, и клавиатуре. */
export function pendingKind(bundle: DealBundle): PaymentKind | null {
  if (bundle.deal.status === 'awaiting_prepayment') return 'prepayment';
  if (bundle.deal.status === 'awaiting_payment') return 'final';
  return null;
}

export function liveFor(bundle: DealBundle, kind: PaymentKind) {
  return livePayment(bundle.payments, kind);
}

export function remainingOf(bundle: DealBundle): number {
  return remaining(bundle.version);
}
