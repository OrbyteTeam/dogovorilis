// Экран сделки `#/deals/:id` — чистая логика: раскладка кодов действий в кнопки, тексты листов подтверждения и ввода,
// проверка файла чека и разбор ошибок действий — docs/SPEC.md §7.9, §7.8 (`/actions`, `/receipt`), ЗАДАЧА_08 B;
// «Другое время» и «Принять {время}» — §7.10, ЗАДАЧА_08 D.
// Модуль без React и без window: его покрывают unit-тесты webapp/test/deal-screen.test.ts.
import { formatDateTime } from './format';
import { shortDateTime } from './schedule';
import type { ActionCode, DealRole, DealStatus, DealTimelineItem, DealTimeProposal, PostActionCode } from './types';

// ─────────────────────────────────────────── кнопки ───────────────────────────────────────────

/**
 * Кнопка блока «Действия». `pay` и `confirm_transfer` — не кнопки, а подсказка «оплата в чате» в блоке «Деньги»;
 * `receipt_pdf` живёт в «Документах»; `open_as_client` — только в чате (демо). `share` даёт две кнопки:
 * «Отправить клиенту» и «Скопировать ссылку», как пара кнопок карточки в чате (SPEC §5.5).
 */
export type ButtonKey = Exclude<ActionCode, 'pay' | 'confirm_transfer' | 'open_as_client' | 'receipt_pdf'> | 'copy_link';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive';

export interface ActionButton {
  key: ButtonKey;
  label: string;
  variant: ButtonVariant;
}

export interface ActionLayout {
  /** Главное действие (primary) первым, «Отменить сделку» (destructive) последним, остальные — в порядке карточки. */
  buttons: ActionButton[];
  /** Клиенту пора платить: оплата — в карточке в чате, на экране статус и «Открыть чат» (SPEC §7.9 п. 4). */
  payInChat: boolean;
  /** Клиент сообщил о переводе — исполнитель подтверждает в чате. */
  transferClaimed: boolean;
  /** Квитанцию можно отправить в чат с ботом (блок «Документы»). */
  receiptPdf: boolean;
}

/** Подписи — как на кнопках карточки в чате (SPEC §7.9, DESIGN §6): глагол или результат, без эмодзи. */
const LABEL: Record<Exclude<ButtonKey, 'refund_confirmed'>, string> = {
  confirm: 'Подтверждаю',
  request_changes: 'Предложить изменения',
  decline: 'Отказаться',
  accept: 'Принимаю',
  remarks: 'Есть замечания',
  cancel: 'Отменить сделку',
  keep_as_is: 'Оставить как есть',
  done: 'Выполнено',
  fixed: 'Исправлено, проверьте',
  close_without_receipt: 'Закрыть без чека',
  remind_client: 'Напомнить клиенту',
  // Подпись с временем — acceptTimeLabel; эта — если сервер прислал действие без предложения.
  accept_time: 'Принять время',
  edit: 'Изменить условия',
  repeat: 'Повторить',
  attach_receipt: 'Приложить чек',
  share: 'Отправить клиенту',
  copy_link: 'Скопировать ссылку',
};

export const RECEIPT_PDF_LABEL = 'Квитанция PDF в чат';

/**
 * Что сказать после успешного действия, если сервер не прислал своего `notice`: не «Готово», а что именно
 * произошло и что дальше — клиент не должен гадать (прогон удобства ЗАДАЧА_08 F).
 */
const DONE_TEXT: Partial<Record<PostActionCode, string>> = {
  confirm: 'Условия подтверждены. Исполнитель получил уведомление',
  decline: 'Вы отказались от сделки. Исполнитель получил уведомление',
  request_changes: 'Предложение отправлено исполнителю',
  remarks: 'Замечания отправлены исполнителю',
  accept: 'Работа принята. Исполнитель получил уведомление',
  cancel: 'Сделка отменена. Вторая сторона получила уведомление',
  keep_as_is: 'Условия оставлены как есть. Клиент получил уведомление',
  done: 'Отмечено: выполнено. Ждём приёмку клиента',
  fixed: 'Клиенту отправлено: замечания исправлены',
  close_without_receipt: 'Сделка закрыта без чека. Квитанция ушла обеим сторонам',
};

export function doneText(code: PostActionCode): string {
  return DONE_TEXT[code] ?? 'Готово';
}

export function buttonLabel(key: ButtonKey, role: DealRole): string {
  if (key === 'refund_confirmed') return role === 'seller' ? 'Вернул(а)' : 'Возврат получил(а)';
  return LABEL[key];
}

/** «Принять Чт 1 окт, 19:00» — как кнопка «✅ Принять …» карточки в чате (server texts.ts acceptTimeLabel), без эмодзи. */
export function acceptTimeLabel(iso: string): string {
  const when = shortDateTime(iso);
  return when ? `Принять ${when}` : LABEL.accept_time;
}

/**
 * Строка над действиями, пока предложение времени ждёт ответа (§7.10): исполнителю — что предлагает клиент,
 * клиенту — что он предложил. Время — по МСК с меткой, как в условиях.
 */
export function proposalNote(role: DealRole, proposal: DealTimeProposal): string {
  const when = formatDateTime(proposal.scheduled_at);
  return role === 'seller' ? `Клиент предлагает ${when}` : `Вы предложили ${when}. Ждём ответа исполнителя`;
}

/**
 * Кандидаты в главное действие — то, чего ждёт от этой стороны следующий шаг сделки. «Принять {время}» — первым:
 * клиент уже выбрал свободное время, исполнителю остаётся одно нажатие (§7.10).
 */
const PRIMARY: readonly ActionCode[] = ['accept_time', 'confirm', 'accept', 'done', 'fixed', 'attach_receipt', 'share'];
/** Не кнопки блока «Действия» (см. ButtonKey). */
const NOT_BUTTONS: readonly ActionCode[] = ['pay', 'confirm_transfer', 'open_as_client', 'receipt_pdf'];

/** `proposal` — ожидающее предложение времени (`DealFull.time_proposal`): из него подпись «Принять {время}». */
export function layoutActions(
  actions: readonly ActionCode[],
  role: DealRole,
  proposal: DealTimeProposal | null = null,
): ActionLayout {
  const codes = actions.filter((code, index) => actions.indexOf(code) === index);
  const primary = codes.find((code) => PRIMARY.includes(code)) ?? null;
  const rest = codes.filter((code) => code !== primary && code !== 'cancel' && !NOT_BUTTONS.includes(code));
  const ordered = [...(primary ? [primary] : []), ...rest, ...(codes.includes('cancel') ? ['cancel' as const] : [])];

  const buttons: ActionButton[] = [];
  for (const code of ordered) {
    const key = code as ButtonKey;
    const variant: ButtonVariant = code === primary ? 'primary' : code === 'cancel' ? 'destructive' : 'secondary';
    const label = code === 'accept_time' && proposal ? acceptTimeLabel(proposal.scheduled_at) : buttonLabel(key, role);
    buttons.push({ key, label, variant });
    // Ссылку для клиента — сразу за «Отправить клиенту»: в MAX шеринг бывает недоступен, тогда её копируют руками.
    if (code === 'share') buttons.push({ key: 'copy_link', label: buttonLabel('copy_link', role), variant: 'secondary' });
  }
  return {
    buttons,
    payInChat: codes.includes('pay'),
    transferClaimed: codes.includes('confirm_transfer'),
    receiptPdf: codes.includes('receipt_pdf'),
  };
}

// ─────────────────────────────────────────── что делает кнопка ───────────────────────────────────────────

export type ConfirmCode = 'decline' | 'cancel' | 'close_without_receipt';
export type TextCode = 'request_changes' | 'remarks';

export type ButtonBehavior =
  /** Сразу `POST …/actions`. */
  | { kind: 'post'; code: PostActionCode }
  /** Необратимое — сначала лист подтверждения. */
  | { kind: 'confirm'; code: ConfirmCode }
  /** Нужен текст — лист с полем ввода. */
  | { kind: 'text'; code: TextCode }
  /** «Предложить изменения» клиента — лист выбора: «Другое время» (экран времени) или «Написать текстом» (§7.10). */
  | { kind: 'change' }
  | { kind: 'edit' }
  | { kind: 'repeat' }
  | { kind: 'file' }
  | { kind: 'share' }
  | { kind: 'copy' };

export function buttonBehavior(key: ButtonKey): ButtonBehavior {
  switch (key) {
    case 'decline':
    case 'cancel':
    case 'close_without_receipt':
      return { kind: 'confirm', code: key };
    case 'request_changes':
      return { kind: 'change' };
    case 'remarks':
      return { kind: 'text', code: key };
    case 'edit':
      return { kind: 'edit' };
    case 'repeat':
      return { kind: 'repeat' };
    case 'attach_receipt':
      return { kind: 'file' };
    case 'share':
      return { kind: 'share' };
    case 'copy_link':
      return { kind: 'copy' };
    default:
      return { kind: 'post', code: key };
  }
}

// ─────────────────────────────────────────── листы ───────────────────────────────────────────

export const TEXT_MAX = 500;
export const REASON_MAX = 300;

export interface ConfirmSheetText {
  title: string;
  text: string;
  confirmLabel: string;
  dismissLabel: string;
  destructive: boolean;
  /** Исполнителю при отмене — поле «Причина (необязательно)» ≤ 300 (SPEC §7.9). */
  reasonField: boolean;
}

/** Тексты подтверждений — как в чате (server/src/texts.ts CONFIRM_*), без #id: он и так в заголовке экрана. */
export function confirmSheet(code: ConfirmCode, role: DealRole): ConfirmSheetText {
  switch (code) {
    case 'decline':
      return {
        title: 'Отказаться от сделки?',
        text: 'Исполнитель получит уведомление, вернуться к этой карточке будет нельзя.',
        confirmLabel: 'Да, отказаться',
        dismissLabel: 'Не отказываться',
        destructive: true,
        reasonField: false,
      };
    case 'cancel':
      return {
        title: 'Отменить сделку?',
        text: 'Действие необратимо, вторая сторона получит уведомление.',
        confirmLabel: 'Да, отменить',
        dismissLabel: 'Не отменять',
        destructive: true,
        reasonField: role === 'seller',
      };
    case 'close_without_receipt':
      return {
        title: 'Закрыть без чека?',
        text: 'Квитанция уйдёт обеим сторонам, но чека из «Мой налог» в ней не будет.',
        confirmLabel: 'Да, закрыть',
        dismissLabel: 'Не закрывать',
        destructive: false,
        reasonField: false,
      };
  }
}

export interface ChangeSheetText {
  title: string;
  text: string;
  timeLabel: string;
  textLabel: string;
}

/** Лист выбора «Предложить изменения» — те же два пути, что у карточки в чате (§7.10): время или текст. */
export const CHANGE_SHEET: ChangeSheetText = {
  title: 'Предложить изменения',
  text: 'Время выберите в календаре исполнителя, остальное напишите словами.',
  timeLabel: 'Другое время',
  textLabel: 'Написать текстом',
};

export interface TextSheetText {
  title: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  emptyError: string;
}

export function textSheet(code: TextCode): TextSheetText {
  if (code === 'request_changes') {
    return {
      title: 'Предложить изменения',
      label: 'Что изменить',
      placeholder: 'Например: давайте 15:00 и без предоплаты',
      submitLabel: 'Отправить исполнителю',
      emptyError: 'Напишите, что изменить',
    };
  }
  return {
    title: 'Есть замечания',
    label: 'Что исправить',
    placeholder: 'Опишите, что не так',
    submitLabel: 'Отправить замечания',
    emptyError: 'Опишите замечания',
  };
}

/** Текст из листа: обязательный — 1…max символов без пробелов по краям; необязательный — только верхняя граница. */
export function validateText(value: string, opts: { max: number; emptyError?: string }): string | null {
  const trimmed = value.trim();
  if (opts.emptyError && trimmed.length === 0) return opts.emptyError;
  if (trimmed.length > opts.max) return `Не больше ${opts.max} символов`;
  return null;
}

// ─────────────────────────────────────────── чек ───────────────────────────────────────────

/** Как у сервера и у чека из чата: pdf/jpeg/png, до 20 МБ (SPEC §6.6, §7.8). */
export const RECEIPT_MAX_BYTES = 20 * 1024 * 1024;
export const RECEIPT_ACCEPT = 'application/pdf,image/jpeg,image/png';
export const RECEIPT_FILE_ERROR = 'Нужен файл PDF, JPG или PNG до 20 МБ';
export const RECEIPT_EMPTY_ERROR = 'Файл пустой. Выберите другой';

export type ReceiptContentType = 'application/pdf' | 'image/jpeg' | 'image/png';

export type ReceiptCheck = { ok: true; contentType: ReceiptContentType } | { ok: false; error: string };

const BY_MIME: Record<string, ReceiptContentType> = {
  'application/pdf': 'application/pdf',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/png': 'image/png',
};

const BY_EXTENSION: Record<string, ReceiptContentType> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Проверка до отправки: тип и размер. Тип — по MIME, а если WebView его не сообщил (пусто или octet-stream,
 * так бывает на Android), — по расширению имени. Результат — Content-Type для запроса.
 */
export function checkReceiptFile(file: { name: string; type: string; size: number }): ReceiptCheck {
  const mime = file.type.trim().toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  const generic = mime === '' || mime === 'application/octet-stream';
  const contentType = generic ? BY_EXTENSION[extension] : BY_MIME[mime];
  if (!contentType) return { ok: false, error: RECEIPT_FILE_ERROR };
  if (file.size <= 0) return { ok: false, error: RECEIPT_EMPTY_ERROR };
  if (file.size > RECEIPT_MAX_BYTES) return { ok: false, error: RECEIPT_FILE_ERROR };
  return { ok: true, contentType };
}

// ─────────────────────────────────────────── ошибки действий ───────────────────────────────────────────

/**
 * Что делать с ошибкой действия (контракт ЗАДАЧА_08 B):
 * - `reload` — сделка ушла дальше или условия сменились (409 `invalid_transition` / `version_mismatch`):
 *   перезагрузить экран и показать message тостом;
 * - `field` — 400 `validation`, когда на листе есть поле: текст ошибки под полем;
 * - `retry` — сеть, таймаут, 5xx: тост, лист остаётся открытым, введённое не теряется;
 * - `toast` — всё прочее (E7, квитанция до завершения, 403, 429…): тост, экран остаётся рабочим.
 */
export type ActionErrorOutcome = 'reload' | 'field' | 'retry' | 'toast';

export function actionErrorOutcome(error: { status: number; code: string }, hasField: boolean): ActionErrorOutcome {
  if (error.status === 409 && (error.code === 'invalid_transition' || error.code === 'version_mismatch')) return 'reload';
  if (error.status === 400 && error.code === 'validation' && hasField) return 'field';
  if (error.status === 0 || error.status >= 500) return 'retry';
  return 'toast';
}

// ─────────────────────────────────────────── вид ───────────────────────────────────────────

/** Тон статуса — только для полосы у статуса (DESIGN §1, `--deal-*`); смысл всегда несут эмодзи и слова. */
export type StatusTone = 'action' | 'waiting' | 'success' | 'danger';

export function statusTone(status: DealStatus, layout: ActionLayout): StatusTone {
  if (status === 'closed') return 'success';
  if (status === 'cancelled' || status === 'declined' || status === 'expired') return 'danger';
  const needsMe = layout.payInChat || layout.transferClaimed || layout.buttons.some((b) => b.variant === 'primary');
  return needsMe ? 'action' : 'waiting';
}

export const ACTOR_LABEL: Record<DealTimelineItem['actor'], string> = {
  seller: 'Исполнитель',
  client: 'Клиент',
  system: 'Автоматически',
};

export type AvatarGradient = 'red' | 'orange' | 'green' | 'blue' | 'purple';
const GRADIENTS: readonly AvatarGradient[] = ['red', 'orange', 'green', 'blue', 'purple'];

/** Градиент аватара по имени — один и тот же у одного человека на всех экранах (DESIGN §4). */
export function avatarGradient(name: string): AvatarGradient {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return GRADIENTS[hash % GRADIENTS.length];
}

/** «Анна Аксёнова» → «АА», «Саша» → «С». */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}
