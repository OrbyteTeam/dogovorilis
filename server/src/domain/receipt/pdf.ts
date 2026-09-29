// Квитанция PDF (SPEC §11, DESIGN_BRIEF §8): A4, поля 20 мм, шрифт DejaVu Sans (кириллица).
// Порядок блоков: шапка с логотипом, статус, стороны, условия с прошлыми версиями, платежи с подтверждениями
// перевода, хронология, чек; подвал на каждой странице. Демо-сделка помечается водяным знаком «ДЕМО» (SPEC §12).
// Пометки среды в строках платежей обязательны (SPEC §18): «тест» у ссылок. Все тексты по DESIGN_BRIEF §2:
// без тире, суммы «1 500 ₽», даты «15 окт 2026, 19:02». Тексты дублируются здесь намеренно: texts.ts
// принадлежит транспорту, а квитанция это домен.
import { createWriteStream, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import PDFDocument from 'pdfkit';
import { formatMoney, formatPercent, prepaymentPercent } from '../money.js';
import { DEFAULT_TZ, formatDocDateTime, formatDocWhen, zoneLabel } from '../time.js';
import type { CancelRule, DealStatus, PaymentKind, PaymentProvider, PaymentRail, TaxMode } from '../../types.js';
import type { ReceiptHistory } from './history.js';

export type ReceiptPaymentRow = {
  kind: PaymentKind;
  amountKopecks: number;
  rail: PaymentRail;
  provider: PaymentProvider;
  providerPaymentId: string | null;
  at: Date | null;
  succeeded: boolean;
};

export type ReceiptData = {
  publicId: string;
  demo: boolean;
  generatedAt: Date;
  status: DealStatus;
  seller: { name: string; maxUserId: number; phoneMasked: string | null };
  client: { name: string; maxUserId: number } | null;
  version: {
    version: number;
    title: string;
    description: string | null;
    scheduledAt: Date | null;
    totalKopecks: number;
    prepaymentKopecks: number;
    cancelRule: CancelRule;
    createdAt: Date;
  };
  confirmations: { confirmedAt: Date | null; doneAt: Date | null; acceptedAt: Date | null };
  payments: ReceiptPaymentRow[];
  paidKopecks: number;
  remainingKopecks: number;
  receipt: { attachedAt: Date | null; taxMode: TaxMode };
  /** Отметки сторон по рейлу «перевод»: кто и когда сообщил, не увидел, подтвердил (аудит 22.09 §4.3). */
  transferLog?: Array<{ at: Date; step: 'claimed' | 'not_received' | 'received'; kind: PaymentKind; amountKopecks: number }>;
  /** Хронология событий и прошлые версии (domain/receipt/history.ts); нет — хронология собирается из отметок сделки. */
  history?: ReceiptHistory;
  closing: {
    closedAt: Date | null;
    cancelledAt: Date | null;
    cancelledByRole: 'seller' | 'client' | 'system' | null;
    cancelReason: string | null;
    cancelRefundExpected: boolean | null;
    /** отметки возврата сторонами (SPEC §5.3, ЗАДАЧА_03 H1) */
    refundSentAt?: Date | null;
    refundReceivedAt?: Date | null;
  };
  /** часовой пояс показа; по умолчанию Europe/Moscow */
  timezone?: string;
};

// ——— константы вёрстки ———

const MM = 72 / 25.4;
const MARGIN = 20 * MM;
/** Место под подвал: он стоит на каждой странице ниже поля содержимого. */
const FOOTER_SPACE = 44;
const FONT = 'DejaVu';
const FONT_BOLD = 'DejaVu-Bold';
const INK = '#000000';
const MUTED = '#555555';
const HAIRLINE = '#cccccc';
/** Синий логотипа: только логотип, заголовок и линия под шапкой квитанции (DESIGN_BRIEF §6, §8). */
const BRAND = '#0152AA';
const LOGO_SIZE = 28;
/** Длинные уточнения не должны ломать вёрстку, режем по границе слова (SPEC §7.2 разрешает до 1000 символов). */
const DESCRIPTION_LIMIT = 600;

// ——— тексты ———

/** Правило отмены после подписи «Правило отмены:» (как в карточке, SPEC §6.4). */
const CANCEL_RULE_TEXT: Record<CancelRule, string> = {
  free_24h: 'отмена без потери предоплаты за 24 ч и более до срока',
  free_48h: 'отмена без потери предоплаты за 48 ч и более до срока',
  nonrefundable: 'предоплата не возвращается при отмене клиентом',
  full_refund: 'предоплата возвращается при любой отмене',
};

/** Статус словами для сделок, которые ещё не закрыты и не отменены (SPEC §11 п. 7). */
const STATUS_TEXT: Record<DealStatus, string> = {
  awaiting_confirmation: 'ждём подтверждения клиента',
  changes_requested: 'клиент предложил изменения',
  declined: 'клиент отказался от сделки',
  expired: 'срок подтверждения истёк',
  awaiting_prepayment: 'ждём предоплату',
  scheduled: 'всё согласовано, ждём выполнения',
  awaiting_acceptance: 'ждём приёмку клиентом',
  remarks: 'клиент оставил замечания',
  awaiting_payment: 'ждём остаток',
  paid: 'оплачено, ждём чек',
  closed: 'сделка закрыта',
  cancelled: 'сделка отменена',
};

const CANCELLED_BY_TEXT: Record<'seller' | 'client' | 'system', string> = {
  seller: 'исполнителем',
  client: 'клиентом',
  system: 'автоматически',
};

const TAX_MODE_TEXT: Record<TaxMode, string | null> = {
  npd: 'самозанятый',
  ip_kkt: 'ИП',
  none: null,
};

const PAYMENT_KIND_TEXT: Record<PaymentKind, string> = {
  prepayment: 'Предоплата',
  final: 'Остаток',
};

const FOOTER_TEXT =
  'Не фискальный документ. Квитанция фиксирует договорённость и подтверждения сторон в MAX; не является кассовым ' +
  'чеком или чеком НПД. Содержимое приложенного чека не проверялось. Тестовые платежи: реальные деньги не движутся. ' +
  'Деньги идут напрямую исполнителю, продукт их не касается.';

/** Способ оплаты с обязательной пометкой среды (SPEC §11 п. 5, §18). */
function railText(rail: PaymentRail, provider: PaymentProvider): string {
  if (rail === 'transfer') return 'перевод по реквизитам';
  if (provider === 'yookassa') return 'ссылка ЮKassa, тест';
  if (provider === 'tbank') return 'СБП Т-Банк, тест';
  return 'ссылка на оплату, тест';
}

/** Кто подтвердил платёж: у ссылки провайдер с номером платежа, у перевода отметки сторон. */
function confirmationText(p: ReceiptPaymentRow): string {
  if (!p.succeeded) return 'не подтверждён';
  if (p.rail === 'transfer') return 'отметки сторон в MAX';
  const provider = p.provider === 'yookassa' ? 'ЮKassa' : p.provider === 'tbank' ? 'Т-Банк' : 'провайдер';
  return p.providerPaymentId ? `${provider}, платёж ${p.providerPaymentId}` : provider;
}

/**
 * Имя файла квитанции: именно оно показывается получателю в MAX (CONTRACTS §1.8: клиент берёт
 * базовое имя из пути загружаемого файла).
 *
 * **Только ASCII.** SDK 0.3.1 подставляет имя в заголовок `Content-Disposition` без кодирования
 * по RFC 5987, поэтому кириллица роняет загрузку целиком: `Invalid character in header content`,
 * квитанция не уходит вообще (проверено 21.09.2026, CONTRACTS §1.14 п. 11). Отсюда транслит,
 * а не «Квитанция_…». Инвариант закреплён тестом в `server/test/texts.test.ts`.
 */
export function receiptFileName(publicId: string): string {
  return `Kvitanciya-${publicId}.pdf`;
}

// ——— файлы: шрифты и логотип ———

const requireFromHere = createRequire(import.meta.url);
let fontFiles: { regular: string; bold: string } | null = null;

/** Путь к ttf ищем через package.json пакета: устойчиво к вложенности node_modules. */
function resolveFonts(): { regular: string; bold: string } {
  if (fontFiles) return fontFiles;
  let pkgDir: string;
  try {
    pkgDir = path.dirname(requireFromHere.resolve('dejavu-fonts-ttf/package.json'));
  } catch {
    throw new Error(
      'Пакет dejavu-fonts-ttf не найден: без него в квитанции не будет кириллицы. Выполните npm ci в корне репозитория.',
    );
  }
  fontFiles = { regular: findFontFile(pkgDir, 'DejaVuSans.ttf'), bold: findFontFile(pkgDir, 'DejaVuSans-Bold.ttf') };
  return fontFiles;
}

function findFontFile(pkgDir: string, file: string): string {
  const candidates = [path.join(pkgDir, 'ttf', file), path.join(pkgDir, file), path.join(pkgDir, 'fonts', 'ttf', file)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Шрифт ${file} не найден в пакете dejavu-fonts-ttf (искали: ${candidates.join(', ')})`);
  }
  return found;
}

/**
 * Логотип для шапки: server/assets/logo.png. Путь одинаковый из src (tsx) и из dist (сборка): оба на три уровня
 * ниже server/. Файла нет (старый образ, урезанная сборка) — квитанция собирается без логотипа, а не падает.
 */
export function logoPath(): string | null {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/logo.png');
  return existsSync(file) ? file : null;
}

// ——— примитивы вёрстки ———

type Doc = PDFKit.PDFDocument;

function contentWidth(doc: Doc): number {
  return doc.page.width - MARGIN * 2;
}

function bottomY(doc: Doc): number {
  return doc.page.height - doc.page.margins.bottom;
}

/**
 * Перенос на новую страницу, если нужное место не влезает.
 * Важно: после переноса водяной знак демо-сделки меняет текущий шрифт и кегль,
 * поэтому шрифт задаётся заново непосредственно перед отрисовкой (см. useFont).
 */
function ensureSpace(doc: Doc, need: number): void {
  if (doc.y + need > bottomY(doc)) doc.addPage();
}

function useFont(doc: Doc, bold: boolean, size: number): void {
  doc.font(bold ? FONT_BOLD : FONT).fontSize(size);
}

function heading(doc: Doc, text: string): void {
  ensureSpace(doc, 34);
  doc.moveDown(0.4);
  useFont(doc, true, 11);
  doc.fillColor(INK).text(text, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.25);
}

function line(doc: Doc, text: string, opts: { size?: number; bold?: boolean; color?: string } = {}): void {
  const size = opts.size ?? 10;
  const bold = opts.bold === true;
  useFont(doc, bold, size);
  ensureSpace(doc, doc.heightOfString(text, { width: contentWidth(doc) }));
  useFont(doc, bold, size);
  doc.fillColor(opts.color ?? INK).text(text, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.fillColor(INK);
}

function hairline(doc: Doc): void {
  const y = doc.y + 4;
  doc.save().strokeColor(HAIRLINE).lineWidth(0.5).moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).stroke().restore();
  doc.x = MARGIN;
  doc.y = y + 6;
}

type Column = { width: number; align?: 'left' | 'right' };

/** Строка таблицы платежей: высота по самой высокой ячейке, ячейки переносятся внутри колонки. */
function tableRow(doc: Doc, cells: string[], columns: Column[], bold = false): void {
  const size = 8.5;
  const pad = 6;
  useFont(doc, bold, size);
  const heights = cells.map((cell, i) => doc.heightOfString(cell, { width: (columns[i]?.width ?? 60) - pad }));
  const rowHeight = Math.max(...heights, size) + 4;
  ensureSpace(doc, rowHeight);
  useFont(doc, bold, size);
  const top = doc.y;
  let x = MARGIN;
  cells.forEach((cell, i) => {
    const column = columns[i] ?? { width: 60 };
    doc.text(cell, x, top, { width: column.width - pad, align: column.align ?? 'left' });
    x += column.width;
  });
  doc.x = MARGIN;
  doc.y = top + rowHeight;
}

/** Диагональный водяной знак «ДЕМО», серый около 15 % (SPEC §11 п. 1, §12). Логотип в знак не идёт (§7). */
function drawWatermark(doc: Doc): void {
  const { width, height } = doc.page;
  const savedX = doc.x;
  const savedY = doc.y;
  doc.save();
  doc.rotate(-45, { origin: [width / 2, height / 2] });
  doc.fillColor('#000000').fillOpacity(0.15).font(FONT_BOLD).fontSize(110).text('ДЕМО', 0, height / 2 - 70, {
    width,
    align: 'center',
    lineBreak: false,
  });
  doc.restore();
  doc.fillOpacity(1).fillColor(INK);
  doc.x = savedX;
  doc.y = savedY;
}

/** Описание обрезаем по границе слова, чтобы не разрывать текст посередине. */
function trim(text: string): string {
  const clean = text.trim();
  if (clean.length <= DESCRIPTION_LIMIT) return clean;
  const cut = clean.slice(0, DESCRIPTION_LIMIT);
  const space = cut.lastIndexOf(' ');
  return `${(space > DESCRIPTION_LIMIT - 60 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ——— разделы квитанции (DESIGN_BRIEF §8) ———

/** 1. Шапка: логотип 28 pt, заголовок, строка о формировании, линия синим логотипа. */
function drawHeader(doc: Doc, data: ReceiptData, tz: string): void {
  const logo = logoPath();
  const top = doc.y;
  const textX = logo ? MARGIN + LOGO_SIZE + 10 : MARGIN;
  const textWidth = doc.page.width - MARGIN - textX;
  if (logo) doc.image(logo, MARGIN, top, { width: LOGO_SIZE, height: LOGO_SIZE });
  useFont(doc, true, 16);
  doc.fillColor(BRAND).text(`Квитанция о сделке #${data.publicId}`, textX, top, { width: textWidth });
  useFont(doc, false, 9);
  doc
    .fillColor(MUTED)
    .text(`Сформировано ботом «Договорились» в MAX, ${formatDocDateTime(data.generatedAt, tz)} (${zoneLabel(tz)})`, textX, doc.y + 2, {
      width: textWidth,
    });
  doc.fillColor(INK);
  const y = Math.max(doc.y, top + LOGO_SIZE) + 8;
  doc.save().strokeColor(BRAND).lineWidth(1).moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).stroke().restore();
  doc.x = MARGIN;
  doc.y = y + 8;
  if (data.demo) {
    line(doc, 'Демонстрационная сделка: обе стороны один пользователь', { size: 9, color: MUTED });
    doc.moveDown(0.2);
  }
}

/** 2. Статус одной строкой словом и датой. */
export function statusLine(data: ReceiptData, tz: string): string {
  const c = data.closing;
  if (data.status === 'closed' && c.closedAt) return `Сделка закрыта ${formatDocDateTime(c.closedAt, tz)}`;
  if (data.status === 'cancelled' && c.cancelledAt) {
    const by = c.cancelledByRole ? ` ${CANCELLED_BY_TEXT[c.cancelledByRole]}` : '';
    const reason = c.cancelReason?.trim() ? `: ${c.cancelReason.trim()}` : ', без причины';
    return `Отменена${by} ${formatDocDateTime(c.cancelledAt, tz)}${reason}`;
  }
  if (data.status === 'expired') return 'Срок подтверждения истёк';
  if (data.status === 'declined') return 'Клиент отказался от сделки';
  return `Текущий статус: ${STATUS_TEXT[data.status]}`;
}

function drawStatus(doc: Doc, data: ReceiptData, tz: string): void {
  heading(doc, 'Статус');
  line(doc, statusLine(data, tz));
  hairline(doc);
}

/** 3. Стороны: имя, MAX id, статус исполнителя. */
function drawParties(doc: Doc, data: ReceiptData): void {
  heading(doc, 'Стороны');
  const phone = data.seller.phoneMasked ? `, телефон ${data.seller.phoneMasked}` : '';
  const tax = TAX_MODE_TEXT[data.receipt.taxMode];
  line(doc, `Исполнитель: ${data.seller.name}, MAX id ${data.seller.maxUserId}${tax ? `, ${tax}` : ''}${phone}`);
  line(doc, data.client === null ? 'Клиент: ещё не открыл ссылку' : `Клиент: ${data.client.name}, MAX id ${data.client.maxUserId}`);
  hairline(doc);
}

/** 4. Условия текущей версии, строка версии серым, прошлые версии списком. */
function drawTerms(doc: Doc, data: ReceiptData, tz: string): void {
  const v = data.version;
  heading(doc, 'Условия');
  line(doc, `Что: ${v.title}`);
  if (v.description?.trim()) line(doc, `Уточнения: ${trim(v.description)}`);
  line(doc, `Когда: ${v.scheduledAt === null ? 'без даты' : `${formatDocWhen(v.scheduledAt, tz)} (${zoneLabel(tz)})`}`);
  line(doc, `Сумма: ${formatMoney(v.totalKopecks)}`);
  const prepayment =
    v.prepaymentKopecks > 0
      ? `${formatMoney(v.prepaymentKopecks)} (${formatPercent(prepaymentPercent(v.totalKopecks, v.prepaymentKopecks))})`
      : 'без предоплаты';
  line(doc, `Предоплата: ${prepayment}`);
  line(doc, `Правило отмены: ${CANCEL_RULE_TEXT[v.cancelRule]}`);
  line(doc, `Версия ${v.version} от ${formatDocDateTime(v.createdAt, tz)}`, { size: 9, color: MUTED });
  const past = data.history?.pastVersions ?? [];
  if (past.length) {
    doc.moveDown(0.3);
    line(doc, 'Прошлые версии', { size: 9, bold: true });
    for (const p of past) line(doc, `Версия ${p.version}, ${formatDocDateTime(p.createdAt, tz)}: ${p.changes}`, { size: 9, color: MUTED });
  }
  hairline(doc);
}

const TRANSFER_STEP_TEXT: Record<'claimed' | 'not_received' | 'received', string> = {
  claimed: 'Клиент сообщил о переводе',
  not_received: 'Исполнитель не видит перевода',
  received: 'Исполнитель подтвердил получение',
};

/** 5. Платежи: таблица, итог, возврат; для переводов подтверждения сторон. */
function drawPayments(doc: Doc, data: ReceiptData, tz: string): void {
  heading(doc, 'Платежи');
  if (data.payments.length === 0) {
    line(doc, 'Платежей по сделке не было', { color: MUTED });
  } else {
    const total = contentWidth(doc);
    const columns: Column[] = [
      { width: total * 0.14 },
      { width: total * 0.13, align: 'right' },
      { width: total * 0.24 },
      { width: total * 0.29 },
      { width: total * 0.2 },
    ];
    tableRow(doc, ['Этап', 'Сумма', 'Способ', 'Подтверждение', 'Дата'], columns, true);
    for (const p of data.payments) {
      tableRow(
        doc,
        [
          PAYMENT_KIND_TEXT[p.kind],
          formatMoney(p.amountKopecks),
          railText(p.rail, p.provider),
          confirmationText(p),
          p.succeeded && p.at ? formatDocDateTime(p.at, tz) : 'не оплачен',
        ],
        columns,
      );
    }
  }
  doc.moveDown(0.2);
  line(doc, `Оплачено: ${formatMoney(data.paidKopecks)}`, { bold: true });
  line(doc, `Остаток: ${formatMoney(data.remainingKopecks)}`, { bold: true });

  const c = data.closing;
  if (data.status === 'cancelled' && c.cancelRefundExpected !== null && data.version.prepaymentKopecks > 0) {
    const sum = formatMoney(data.version.prepaymentKopecks);
    let refund = c.cancelRefundExpected ? `Предоплата ${sum}: ожидается возврат` : `Предоплата ${sum} не возвращается по правилу отмены`;
    if (c.refundReceivedAt) refund = `Возврат ${sum} получен клиентом ${formatDocDateTime(c.refundReceivedAt, tz)}`;
    else if (c.refundSentAt) refund = `Исполнитель вернул ${sum} ${formatDocDateTime(c.refundSentAt, tz)}, клиент ещё не подтвердил`;
    line(doc, refund);
  }

  const log = data.transferLog ?? [];
  if (log.length) {
    doc.moveDown(0.4);
    line(doc, 'Подтверждения перевода', { size: 10, bold: true });
    for (const s of log) {
      const what = `${PAYMENT_KIND_TEXT[s.kind].toLowerCase()} ${formatMoney(s.amountKopecks)}`;
      line(doc, `${TRANSFER_STEP_TEXT[s.step]} ${formatDocDateTime(s.at, tz)}: ${what}`);
    }
    line(doc, 'Перевод продукт не видит: строки выше это отметки сторон кнопками в MAX.', { size: 9, color: MUTED });
  }
  hairline(doc);
}

/** Хронология без журнала событий (данные старше квитанции нового вида): из отметок самой сделки. */
function fallbackTimeline(data: ReceiptData): Array<{ at: Date; text: string }> {
  const c = data.confirmations;
  const out: Array<{ at: Date; text: string }> = [];
  if (c.confirmedAt) out.push({ at: c.confirmedAt, text: 'Клиент подтвердил условия' });
  if (c.doneAt) out.push({ at: c.doneAt, text: 'Исполнитель отметил выполнение' });
  if (c.acceptedAt) out.push({ at: c.acceptedAt, text: 'Клиент принял работу' });
  if (data.closing.closedAt) out.push({ at: data.closing.closedAt, text: 'Сделка закрыта' });
  if (data.closing.cancelledAt) out.push({ at: data.closing.cancelledAt, text: 'Сделка отменена' });
  if (data.closing.refundSentAt) out.push({ at: data.closing.refundSentAt, text: 'Исполнитель отметил возврат предоплаты' });
  if (data.closing.refundReceivedAt) out.push({ at: data.closing.refundReceivedAt, text: 'Клиент подтвердил получение возврата' });
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** 6. Хронология: все события строками «дата, время: событие». */
function drawTimeline(doc: Doc, data: ReceiptData, tz: string): void {
  const entries = data.history?.entries.length ? data.history.entries : fallbackTimeline(data);
  if (!entries.length) return;
  heading(doc, `Хронология, время ${zoneLabel(tz)}`);
  for (const e of entries) line(doc, `${formatDocDateTime(e.at, tz)}: ${e.text}`, { size: 9.5 });
  hairline(doc);
}

/** 7. Чек. */
function drawReceiptLine(doc: Doc, data: ReceiptData, tz: string): void {
  heading(doc, 'Чек');
  if (data.receipt.taxMode === 'none') {
    line(doc, 'Чек не требуется: исполнитель работает без чека');
  } else if (data.receipt.attachedAt !== null) {
    line(doc, `Чек приложен исполнителем ${formatDocDateTime(data.receipt.attachedAt, tz)}. Содержимое чека не проверялось`);
  } else {
    line(doc, 'Чек не приложен');
  }
}

/** 8. Подвал на каждой странице: страницы буферизованы, поле под подвал оставлено при создании документа. */
function drawFooters(doc: Doc): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const width = contentWidth(doc);
    const savedBottom = doc.page.margins.bottom;
    // Подвал стоит ниже поля содержимого: без обнуления нижнего поля pdfkit перенёс бы его на новую страницу.
    doc.page.margins.bottom = 0;
    useFont(doc, false, 7.5);
    const height = doc.heightOfString(FOOTER_TEXT, { width });
    const y = doc.page.height - MARGIN - height;
    doc.save().strokeColor(HAIRLINE).lineWidth(0.5).moveTo(MARGIN, y - 6).lineTo(doc.page.width - MARGIN, y - 6).stroke().restore();
    doc.fillColor(MUTED).text(FOOTER_TEXT, MARGIN, y, { width, lineBreak: true });
    doc.page.margins.bottom = savedBottom;
  }
  doc.fillColor(INK);
}

/**
 * Пишет PDF в файл и возвращает путь и имя.
 * Путь передаёт вызывающий (обычно os.tmpdir()), файл удаляет тоже он: SDK MAX требует ПУТЬ,
 * а не Buffer, иначе имя файла у получателя станет UUID (CONTRACTS §1.8).
 */
export async function renderReceiptPdf(data: ReceiptData, outPath: string): Promise<{ path: string; fileName: string }> {
  const fonts = resolveFonts();
  const tz = data.timezone ?? DEFAULT_TZ;
  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,
    margins: { top: MARGIN, bottom: MARGIN + FOOTER_SPACE, left: MARGIN, right: MARGIN },
    info: { Title: `Квитанция о сделке ${data.publicId}`, Creator: 'Договорились (MAX)' },
  });
  doc.registerFont(FONT, fonts.regular);
  doc.registerFont(FONT_BOLD, fonts.bold);
  doc.font(FONT).fontSize(10).fillColor(INK);

  const stream = createWriteStream(outPath);
  doc.pipe(stream);

  if (data.demo) {
    // Знак рисуется до содержимого, чтобы текст остался читаемым; на каждой новой странице заново.
    doc.on('pageAdded', () => drawWatermark(doc));
    drawWatermark(doc);
  }

  drawHeader(doc, data, tz);
  drawStatus(doc, data, tz);
  drawParties(doc, data);
  drawTerms(doc, data, tz);
  drawPayments(doc, data, tz);
  drawTimeline(doc, data, tz);
  drawReceiptLine(doc, data, tz);
  drawFooters(doc);

  doc.end();
  await finished(stream);
  return { path: outPath, fileName: receiptFileName(data.publicId) };
}
