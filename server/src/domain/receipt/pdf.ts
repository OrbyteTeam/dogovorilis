// Квитанция PDF (SPEC §11): A4, поля 20 мм, шрифт DejaVu Sans — кириллица.
// В ЗАДАЧА_01 шаблон минимальный: заголовок, стороны, условия, подтверждения, платежи, чек, статус, подвал.
// Полный шаблон (история условий, QR) — ЗАДАЧА_03. Демо-сделка помечается водяным знаком «ДЕМО» (SPEC §12).
// Пометки среды в строках платежей обязательны (SPEC §18): «тест» для ссылок, «модель» для перевода.
import { createWriteStream, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import PDFDocument from 'pdfkit';
import { formatMoney, prepaymentPercent } from '../money.js';
import { DEFAULT_TZ, formatDateShort, formatDateTime, formatFull } from '../time.js';
import type { CancelRule, DealStatus, PaymentKind, PaymentProvider, PaymentRail, TaxMode } from '../../types.js';

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
  closing: {
    closedAt: Date | null;
    cancelledAt: Date | null;
    cancelledByRole: 'seller' | 'client' | 'system' | null;
    cancelReason: string | null;
    cancelRefundExpected: boolean | null;
  };
  /** часовой пояс показа; по умолчанию Europe/Moscow */
  timezone?: string;
};

// ——— константы вёрстки ———

const MM = 72 / 25.4;
const MARGIN = 20 * MM;
const FONT = 'DejaVu';
const FONT_BOLD = 'DejaVu-Bold';
const INK = '#000000';
const MUTED = '#555555';
const HAIRLINE = '#cccccc';
/** Длинное описание не должно ломать вёрстку — режем (SPEC §7.2 разрешает до 2000 символов). */
const DESCRIPTION_LIMIT = 600;

// ——— тексты ———

/** Тексты правил отмены — дословно SPEC §6.4. Дублируются здесь намеренно: texts.ts принадлежит транспорту. */
const CANCEL_RULE_TEXT: Record<CancelRule, string> = {
  free_24h: 'Отмена без потери предоплаты за 24 ч и более до срока',
  free_48h: 'Отмена без потери предоплаты за 48 ч и более до срока',
  nonrefundable: 'Предоплата не возвращается при отмене клиентом',
  full_refund: 'Предоплата возвращается при любой отмене',
};

/** Статус словами — для сделок, которые ещё не закрыты и не отменены (SPEC §11 п. 7). */
const STATUS_TEXT: Record<DealStatus, string> = {
  awaiting_confirmation: 'ждёт подтверждения условий клиентом',
  changes_requested: 'клиент предложил изменения',
  declined: 'клиент отказался от сделки',
  expired: 'срок подтверждения истёк',
  awaiting_prepayment: 'ждёт предоплату',
  scheduled: 'условия подтверждены, работа запланирована',
  awaiting_acceptance: 'ждёт приёмки клиентом',
  remarks: 'клиент оставил замечания',
  awaiting_payment: 'ждёт оплату остатка',
  paid: 'оплачена, ждёт чек от исполнителя',
  closed: 'закрыта',
  cancelled: 'отменена',
};

const CANCELLED_BY_TEXT: Record<'seller' | 'client' | 'system', string> = {
  seller: 'исполнителем',
  client: 'клиентом',
  system: 'системой',
};

const PAYMENT_KIND_TEXT: Record<PaymentKind, string> = {
  prepayment: 'Предоплата',
  final: 'Остаток',
};

const FOOTER_TEXT =
  'Документ фиксирует договорённость и подтверждения сторон в MAX; не является кассовым чеком или чеком НПД. ' +
  'Тестовые платежи: реальные деньги не движутся.';

/** Рейл с обязательной пометкой среды (SPEC §11 п. 5, §18). */
function railText(rail: PaymentRail, provider: PaymentProvider): string {
  if (rail === 'transfer') return 'перевод по реквизитам, подтверждён сторонами (модель)';
  if (provider === 'yookassa') return 'ссылка ЮKassa (тестовый магазин)';
  if (provider === 'tbank') return 'СБП Т-Банк (DEMO-терминал)';
  return 'оплата по ссылке (тестовая среда)';
}

/**
 * Имя файла квитанции — именно оно показывается получателю в MAX (CONTRACTS §1.8: клиент берёт
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

// ——— шрифты ———

const requireFromHere = createRequire(import.meta.url);
let fontFiles: { regular: string; bold: string } | null = null;

/** Путь к ttf ищем через package.json пакета — устойчиво к вложенности node_modules. */
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

// ——— примитивы вёрстки ———

type Doc = PDFKit.PDFDocument;

function contentWidth(doc: Doc): number {
  return doc.page.width - MARGIN * 2;
}

function bottomY(doc: Doc): number {
  return doc.page.height - MARGIN;
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
  ensureSpace(doc, 30);
  useFont(doc, true, 11);
  doc.fillColor(INK).text(text, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.3);
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
  doc.y = y + 8;
}

type Column = { width: number; align?: 'left' | 'right' };

/** Строка таблицы платежей: высота — по самой высокой ячейке, ячейки переносятся внутри колонки. */
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

/** Диагональный водяной знак «ДЕМО», серый ~15 % (SPEC §11 п. 1, §12). */
function drawWatermark(doc: Doc): void {
  const { width, height } = doc.page;
  const savedX = doc.x;
  const savedY = doc.y;
  doc.save();
  doc.rotate(-45, { origin: [width / 2, height / 2] });
  doc.fillColor('#000000').fillOpacity(0.15).font(FONT_BOLD).fontSize(110).text('ДЕМО', 0, height / 2 - 70, {
    width,
    align: 'center',
  });
  doc.restore();
  doc.fillOpacity(1).fillColor(INK);
  doc.x = savedX;
  doc.y = savedY;
}

// ——— разделы квитанции ———

function drawHeader(doc: Doc, data: ReceiptData, tz: string): void {
  doc.font(FONT_BOLD).fontSize(16).fillColor(INK).text(`Квитанция о сделке №${data.publicId}`, MARGIN, doc.y, {
    width: contentWidth(doc),
  });
  doc.moveDown(0.3);
  line(doc, `Сформировано ботом «Договорились» в MAX · ${formatFull(data.generatedAt, tz)}`, { size: 9, color: MUTED });
  if (data.demo) {
    line(doc, 'Демонстрационная сделка: обе стороны — один пользователь', { size: 9, color: MUTED });
  }
  hairline(doc);
}

function drawParties(doc: Doc, data: ReceiptData): void {
  heading(doc, 'Стороны');
  const phone = data.seller.phoneMasked;
  const sellerTail = phone !== null && phone !== '' ? `, телефон ${phone}` : '';
  line(doc, `Исполнитель: ${data.seller.name}, MAX id ${data.seller.maxUserId}${sellerTail}`);
  line(
    doc,
    data.client === null
      ? 'Клиент: ещё не присоединился'
      : `Клиент: ${data.client.name}, MAX id ${data.client.maxUserId}`,
  );
  hairline(doc);
}

function drawTerms(doc: Doc, data: ReceiptData, tz: string): void {
  const v = data.version;
  heading(doc, 'Условия');
  line(doc, `Название: ${v.title}`);
  const description = v.description === null || v.description.trim() === '' ? '—' : trim(v.description);
  line(doc, `Описание: ${description}`);
  line(doc, `Дата и время: ${v.scheduledAt === null ? 'без даты' : formatDateTime(v.scheduledAt, tz, data.generatedAt)}`);
  line(doc, `Сумма: ${formatMoney(v.totalKopecks)}`);
  const prepayment =
    v.prepaymentKopecks > 0
      ? `${formatMoney(v.prepaymentKopecks)} (${prepaymentPercent(v.totalKopecks, v.prepaymentKopecks)} %)`
      : 'без предоплаты';
  line(doc, `Предоплата: ${prepayment}`);
  line(doc, `Правило отмены: ${CANCEL_RULE_TEXT[v.cancelRule]}`);
  line(doc, `Версия ${v.version} от ${formatFull(v.createdAt, tz)}`, { size: 9, color: MUTED });
  hairline(doc);
}

/** Описание обрезаем по границе слова, чтобы не разрывать текст посередине. */
function trim(text: string): string {
  const clean = text.trim();
  if (clean.length <= DESCRIPTION_LIMIT) return clean;
  const cut = clean.slice(0, DESCRIPTION_LIMIT);
  const space = cut.lastIndexOf(' ');
  return `${(space > DESCRIPTION_LIMIT - 60 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function drawConfirmations(doc: Doc, data: ReceiptData, tz: string): void {
  const c = data.confirmations;
  const rows: string[] = [];
  if (c.confirmedAt !== null) rows.push(`Условия подтверждены клиентом ${formatFull(c.confirmedAt, tz)}`);
  if (c.doneAt !== null) rows.push(`Работа отмечена выполненной ${formatFull(c.doneAt, tz)}`);
  if (c.acceptedAt !== null) rows.push(`Принята клиентом ${formatFull(c.acceptedAt, tz)}`);
  if (rows.length === 0) return;
  heading(doc, 'Подтверждения');
  for (const row of rows) line(doc, row);
  hairline(doc);
}

function drawPayments(doc: Doc, data: ReceiptData, tz: string): void {
  heading(doc, 'Платежи');
  if (data.payments.length === 0) {
    line(doc, 'Платежей по сделке не было', { color: MUTED });
  } else {
    const total = contentWidth(doc);
    const columns: Column[] = [
      { width: total * 0.15 },
      { width: total * 0.15, align: 'right' },
      { width: total * 0.35 },
      { width: total * 0.22 },
      { width: total * 0.13 },
    ];
    tableRow(doc, ['Вид', 'Сумма', 'Рейл', 'id провайдера', 'Дата'], columns, true);
    for (const p of data.payments) {
      // Для неоплаченного платежа в колонке даты — состояние, чтобы в тексте не появилось пустот.
      const when = p.succeeded ? (p.at === null ? '—' : formatDateShort(p.at, tz)) : 'не оплачен';
      tableRow(
        doc,
        [
          PAYMENT_KIND_TEXT[p.kind],
          formatMoney(p.amountKopecks),
          railText(p.rail, p.provider),
          p.providerPaymentId ?? '—',
          when,
        ],
        columns,
      );
    }
  }
  doc.moveDown(0.2);
  line(doc, `Итого оплачено: ${formatMoney(data.paidKopecks)}`, { bold: true });
  line(doc, `Остаток: ${formatMoney(data.remainingKopecks)}`, { bold: true });
  hairline(doc);
}

function drawReceiptLine(doc: Doc, data: ReceiptData, tz: string): void {
  heading(doc, 'Чек');
  if (data.receipt.taxMode === 'none') {
    line(doc, 'Чек не требуется (режим без чека)');
  } else if (data.receipt.attachedAt !== null) {
    line(doc, `Чек НПД приложен исполнителем ${formatFull(data.receipt.attachedAt, tz)}`);
  } else {
    line(doc, 'Чек не приложен');
  }
  hairline(doc);
}

function drawClosing(doc: Doc, data: ReceiptData, tz: string): void {
  const c = data.closing;
  heading(doc, 'Статус и завершение');
  if (c.closedAt !== null) {
    line(doc, `Сделка закрыта ${formatFull(c.closedAt, tz)}`);
  } else if (c.cancelledAt !== null) {
    const by = c.cancelledByRole === null ? '' : ` ${CANCELLED_BY_TEXT[c.cancelledByRole]}`;
    const reason = c.cancelReason === null || c.cancelReason.trim() === '' ? 'без причины' : c.cancelReason.trim();
    line(doc, `Отменена${by} ${formatFull(c.cancelledAt, tz)}: ${reason}`);
    if (c.cancelRefundExpected !== null) {
      line(
        doc,
        c.cancelRefundExpected
          ? 'Предоплата: ожидается возврат'
          : 'Предоплата: не возвращается по правилу отмены',
      );
    }
  } else {
    line(doc, `Текущий статус: ${STATUS_TEXT[data.status]}`);
  }
}

function drawFooter(doc: Doc): void {
  useFont(doc, false, 8);
  const width = contentWidth(doc);
  const height = doc.heightOfString(FOOTER_TEXT, { width });
  const pinned = bottomY(doc) - height;
  if (doc.y + 14 > pinned) {
    // Контент дошёл до подвала: если места нет совсем — переносим подвал на новую страницу.
    if (doc.y + 14 + height > bottomY(doc)) {
      doc.addPage();
      doc.y = bottomY(doc) - height;
    } else {
      doc.y += 14;
    }
  } else {
    doc.y = pinned;
  }
  useFont(doc, false, 8);
  doc.save().strokeColor(HAIRLINE).lineWidth(0.5).moveTo(MARGIN, doc.y - 6).lineTo(doc.page.width - MARGIN, doc.y - 6).stroke().restore();
  doc.fillColor(MUTED).text(FOOTER_TEXT, MARGIN, doc.y, { width });
  doc.fillColor(INK);
}

/**
 * Пишет PDF в файл и возвращает путь и имя.
 * Путь передаёт вызывающий (обычно os.tmpdir()), файл удаляет тоже он — SDK MAX требует ПУТЬ,
 * а не Buffer, иначе имя файла у получателя станет UUID (CONTRACTS §1.8).
 */
export async function renderReceiptPdf(data: ReceiptData, outPath: string): Promise<{ path: string; fileName: string }> {
  const fonts = resolveFonts();
  const tz = data.timezone ?? DEFAULT_TZ;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: { Title: `Квитанция о сделке ${data.publicId}`, Creator: 'Договорились (MAX)' },
  });
  doc.registerFont(FONT, fonts.regular);
  doc.registerFont(FONT_BOLD, fonts.bold);
  doc.font(FONT).fontSize(10).fillColor(INK);

  const stream = createWriteStream(outPath);
  doc.pipe(stream);

  if (data.demo) {
    // Знак рисуется до контента, чтобы текст остался читаемым; на каждой новой странице — заново.
    doc.on('pageAdded', () => drawWatermark(doc));
    drawWatermark(doc);
  }

  drawHeader(doc, data, tz);
  drawParties(doc, data);
  drawTerms(doc, data, tz);
  drawConfirmations(doc, data, tz);
  drawPayments(doc, data, tz);
  drawReceiptLine(doc, data, tz);
  drawClosing(doc, data, tz);
  drawFooter(doc);

  doc.end();
  await finished(stream);
  return { path: outPath, fileName: receiptFileName(data.publicId) };
}
