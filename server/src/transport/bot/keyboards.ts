// Клавиатуры карточек и уведомлений. Какие кнопки видит каждая роль в каждом статусе — SPEC §5.5;
// подписи — только из texts.BTN; коды — только из callbacks.cb (SPEC §13).
// Ограничения платформы: ≤ 7 кнопок в ряду и ≤ 3 для link/open_app (CONTRACTS §1.2, §1.9).
import { Keyboard } from '@maxhub/max-bot-api';
import type { Button } from '@maxhub/max-bot-api/types';
import { BTN } from '../../texts.js';
import type { AttachmentRequest } from '../../integrations/max/gateway.js';
import type { CardRole, DealBundle, Payment, PaymentKind } from '../../types.js';
import { livePayment, remaining } from '../../types.js';
import { cb } from './callbacks.js';

export type Row = Button[];

export function keyboard(rows: Row[]): AttachmentRequest {
  const clean = rows.filter((r) => r.length > 0);
  return Keyboard.inlineKeyboard(clean) as unknown as AttachmentRequest;
}

const callback = (text: string, payload: string) => Keyboard.button.callback(text, payload);
const link = (text: string, url: string) => Keyboard.button.link(text, url);
const clipboard = (text: string, payload: string) => Keyboard.button.clipboard(text, payload);
const openApp = (text: string, bot: string, payload?: string) => Keyboard.button.openApp(text, bot, undefined, payload);

/** Главное меню (SPEC §6.2). Мини-приложение открывается кнопками open_app. */
export function menuKeyboard(a: { botUsername: string; demoMode: boolean }): AttachmentRequest {
  const rows: Row[] = [
    [openApp(BTN.newDeal, a.botUsername, 'new'), openApp(BTN.myDeals, a.botUsername, 'deals')],
    [openApp(BTN.settings, a.botUsername, 'settings'), callback(BTN.help, 'help')],
  ];
  if (a.demoMode) rows.push([callback(BTN.tryDemo, 'dm:new')]);
  return keyboard(rows);
}

/** Шеринг ссылки сделки в существующий чат MAX (SPEC §6.4). */
export function shareUrl(link_: string): string {
  return `https://max.ru/:share?text=${encodeURIComponent(`Подтвердите нашу договорённость: ${link_}`)}`;
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
    return keyboard([[callback(BTN.receiptPdf, cb('pdf', id))]]);
  }

  if (isSeller) {
    switch (status) {
      case 'awaiting_confirmation':
        if (!bundle.deal.clientUserId) {
          rows.push([link(BTN.sendToMax, shareUrl(o.dealLink)), clipboard(BTN.copyLink, o.dealLink)]);
          rows.push([openApp(BTN.editTerms, o.botUsername, `d_${id}`)]);
          if (o.demoMode) rows.push([callback(BTN.openAsClient, cb('dm', id))]);
        } else {
          rows.push([openApp(BTN.editTerms, o.botUsername, `d_${id}`), callback(BTN.remindClient, cb('rs', id))]);
        }
        break;
      case 'changes_requested':
        rows.push([openApp(BTN.editTerms, o.botUsername, `d_${id}`), callback(BTN.keepAsIs, cb('ka', id))]);
        break;
      case 'awaiting_prepayment':
      case 'awaiting_payment':
        rows.push([callback(BTN.remindClient, cb('rs', id))]);
        break;
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
      rows.push([callback(BTN.confirm, cb('cf', id))]);
      rows.push([callback(BTN.requestChanges, cb('cr', id)), callback(BTN.decline, cb('dc', id))]);
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
      } else {
        const pay: Row = [];
        if (o.linkRailVisible) pay.push(callback(o.linkRailRetry ? BTN.newLink : BTN.payByLink, cb(o.linkRailRetry ? 'nl' : 'pl', id)));
        if (o.transferRailVisible) pay.push(callback(BTN.payByTransfer, cb('pt', id)));
        if (pay.length) rows.push(pay);
      }
      if (status === 'awaiting_prepayment') rows.push([callback(BTN.cancelDeal, cb('cn', id))]);
      break;
    }
    case 'scheduled':
      rows.push([callback(BTN.cancelDeal, cb('cn', id))]);
      break;
    case 'awaiting_acceptance':
      rows.push([callback(BTN.accept, cb('ac', id)), callback(BTN.remarks, cb('rm', id))]);
      break;
    case 'remarks':
    case 'paid':
      return null; // ждём исполнителя
  }
  return keyboard(rows);
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

/** Исполнителю: клиент сообщил о переводе (P2). */
export function transferCheckKeyboard(publicId: string, paymentId: number): AttachmentRequest {
  return keyboard([
    [Keyboard.button.callback(BTN.transferReceived, cb('tr', publicId, 'g', paymentId))],
    [Keyboard.button.callback(BTN.transferNotReceived, cb('tr', publicId, 'n', paymentId))],
  ]);
}

/** Подтверждение необратимого действия отдельной кнопкой (§5.2 T7, T16, T15). */
export function confirmKeyboard(code: 'dc' | 'cn' | 'nc', publicId: string, yesText: string): AttachmentRequest {
  return keyboard([[Keyboard.button.callback(yesText, cb(code, publicId, 'y'))], [Keyboard.button.callback(BTN.open, cb('op', publicId))]]);
}

/** Причина отмены: кнопка «Без причины» (§6.6). */
export function cancelReasonKeyboard(publicId: string): AttachmentRequest {
  return keyboard([[Keyboard.button.callback(BTN.noReason, cb('cn', publicId, 'y', 'none'))]]);
}

/** Кнопки уведомлений N3 (предложены изменения) и N11 (замечания). */
export function n3Keyboard(publicId: string, botUsername: string): AttachmentRequest {
  return keyboard([
    [openApp(BTN.editTerms, botUsername, `d_${publicId}`)],
    [Keyboard.button.callback(BTN.keepAsIs, cb('ka', publicId))],
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
