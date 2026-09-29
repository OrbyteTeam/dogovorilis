// Форматирование и тексты интерфейса: суммы и даты по DESIGN_BRIEF §2.3–2.4 (так же, как в боте), статусы §2.5,
// превью карточки §3.1, поля формы SPEC §7.2. Все время по Москве с «(МСК)»: как в карточке бота и квитанции.
import type { CancelRule, DealStatus, TaxMode } from './types';

const RUB = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
/** Перед «₽» неразрывный пробел, как в domain/money.ts: иначе в узкой строке списка знак уезжает на вторую строку. */
const NBSP = ' ';

/** Суммы в контракте целые копейки (domain/money.ts на сервере); в интерфейсе целые рубли: «1 500 ₽». */
export function formatKopecks(kopecks: number): string {
  return `${RUB.format(Math.round(kopecks / 100))}${NBSP}₽`;
}

export function formatRub(rub: number): string {
  return `${RUB.format(rub)}${NBSP}₽`;
}

/** «30 %». */
export function formatPercent(percent: number): string {
  return `${percent}${NBSP}%`;
}

const TZ = 'Europe/Moscow';
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Parts = { year: number; month: number; day: number; hh: string; mm: string; weekday: number };

function partsOf(date: Date): Parts {
  const map: Record<string, string> = {};
  for (const p of PARTS.formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hh: (map.hour === '24' ? '00' : map.hour).padStart(2, '0'),
    mm: map.minute.padStart(2, '0'),
    weekday: Math.max(0, WD_EN.indexOf(map.weekday)),
  };
}

function parse(iso: string | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayLabel(p: Parts, now: Parts, weekday: boolean): string {
  const year = p.year === now.year ? '' : ` ${p.year}`;
  const base = `${p.day} ${MONTHS_SHORT[p.month - 1]}${year}`;
  return weekday ? `${WEEKDAYS[p.weekday]} ${base}` : base;
}

/** «вт 12 окт, 14:00 (МСК)»; год, если не текущий; без даты «без даты». */
export function formatDateTime(iso: string | null, now: Date = new Date()): string {
  const date = parse(iso);
  if (!date) return 'без даты';
  const p = partsOf(date);
  return `${dayLabel(p, partsOf(now), true)}, ${p.hh}:${p.mm} (МСК)`;
}

/**
 * Строка списка: «сегодня, 14:00», «завтра, 14:00», иначе «12 окт, 14:00» (DESIGN_BRIEF §2.4, §5.3).
 * Пояс в строках не пишется: он один раз под списком или в заголовке дня.
 */
export function listDateTime(iso: string | null, now: Date = new Date()): string {
  const date = parse(iso);
  if (!date) return 'без даты';
  const p = partsOf(date);
  const today = partsOf(now);
  const tomorrow = partsOf(new Date(now.getTime() + 86_400_000));
  const same = (a: Parts, b: Parts) => a.year === b.year && a.month === b.month && a.day === b.day;
  if (same(p, today)) return `сегодня, ${p.hh}:${p.mm}`;
  if (same(p, tomorrow)) return `завтра, ${p.hh}:${p.mm}`;
  return `${dayLabel(p, today, false)}, ${p.hh}:${p.mm}`;
}

/** Москва живёт без перехода на летнее время: UTC+3 круглый год. */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Значение `datetime-local` («2026-09-27T14:00») это время по Москве → момент UTC в ISO. null: строка не разобрана. */
export function moscowInputToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - MSK_OFFSET_MS;
  return new Date(utc).toISOString();
}

/** Момент → значение для `datetime-local` по Москве (для атрибута min). */
export function isoToMoscowInput(date: Date): string {
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${msk.getUTCFullYear()}-${pad(msk.getUTCMonth() + 1)}-${pad(msk.getUTCDate())}T${pad(msk.getUTCHours())}:${pad(msk.getUTCMinutes())}`;
}

/** Подписи радио в форме: коротко, полная фраза под списком (CANCEL_RULE_TEXT). */
export const CANCEL_RULE_LABEL: Record<CancelRule, string> = {
  free_24h: 'Бесплатная отмена за 24 ч и более',
  free_48h: 'Бесплатная отмена за 48 ч и более',
  nonrefundable: 'Предоплата не возвращается',
  full_refund: 'Предоплата возвращается всегда',
};

/** Формулировки как в карточке бота (server/src/texts.ts, cancelRuleText). */
export const CANCEL_RULE_TEXT: Record<CancelRule, string> = {
  free_24h: 'Отмена без потери предоплаты за 24 ч и более до срока',
  free_48h: 'Отмена без потери предоплаты за 48 ч и более до срока',
  nonrefundable: 'Предоплата не возвращается при отмене клиентом',
  full_refund: 'Предоплата возвращается при любой отмене',
};

/** После подписи «Отмена:» в карточке (server/src/texts.ts, cancelRuleLine). */
const CANCEL_RULE_AFTER_LABEL: Record<CancelRule, string> = {
  free_24h: 'без потери предоплаты за 24 ч и более до срока',
  free_48h: 'без потери предоплаты за 48 ч и более до срока',
  nonrefundable: 'предоплата не возвращается при отмене клиентом',
  full_refund: 'предоплата возвращается при любой отмене',
};

export const CANCEL_RULES: CancelRule[] = ['free_24h', 'free_48h', 'nonrefundable', 'full_refund'];

export const TAX_MODE_LABEL: Record<TaxMode, string> = {
  npd: 'Самозанятый, чек в «Мой налог»',
  ip_kkt: 'ИП с кассой',
  none: 'Без чека',
};

export const TAX_MODES: TaxMode[] = ['npd', 'ip_kkt', 'none'];

const STATUS_EMOJI: Record<DealStatus, string> = {
  awaiting_confirmation: '⏳',
  changes_requested: '✏️',
  declined: '⛔',
  expired: '⌛',
  awaiting_prepayment: '💳',
  scheduled: '📅',
  awaiting_acceptance: '🔍',
  remarks: '⚠️',
  awaiting_payment: '💳',
  paid: '🧾',
  closed: '✅',
  cancelled: '🚫',
};

export function statusEmoji(status: DealStatus): string {
  return STATUS_EMOJI[status] ?? '⏳';
}

// ─────────────────────────── статус: тон плашки и «чей ход» (DESIGN_BRIEF §2.5, §6) ───────────────────────────

export type StatusTone = 'action' | 'waiting' | 'success' | 'danger';
export type ViewerRole = 'seller' | 'client';

/** Статусы, в которых ход за этой стороной: у неё статус начинается с глагола (§2.5). */
const MOVE: Record<ViewerRole, readonly DealStatus[]> = {
  seller: ['changes_requested', 'remarks', 'paid'],
  client: ['awaiting_confirmation', 'awaiting_prepayment', 'awaiting_acceptance', 'awaiting_payment'],
};

/**
 * Цвет плашки: «нужно ваше действие» акцентом, «ждём другую сторону» третичным, closed и paid успехом,
 * declined, expired, cancelled негативом (DESIGN_BRIEF §2.5). Цвет только дублирует слово статуса.
 */
export function statusTone(status: DealStatus, role: ViewerRole): StatusTone {
  if (status === 'closed' || status === 'paid') return 'success';
  if (status === 'declined' || status === 'expired' || status === 'cancelled') return 'danger';
  return MOVE[role].includes(status) ? 'action' : 'waiting';
}

/**
 * Нужен ли ход пользователя: для счётчика на «Сделках» (§5.1). У исполнителя сюда же прошедшая запланированная
 * сделка: её пора отметить «Выполнено».
 */
export function needsMove(item: { status: DealStatus; role: ViewerRole; scheduled_at: string | null; demo: boolean }, now = new Date()): boolean {
  if (MOVE[item.role].includes(item.status)) return true;
  if (item.role === 'seller' && item.status === 'scheduled' && item.scheduled_at) return new Date(item.scheduled_at).getTime() < now.getTime();
  return false;
}

/**
 * Короткая форма статуса (DESIGN_BRIEF §2.5), слово в слово как server/src/texts.ts statusShort. Списки получают её от
 * сервера (`status_short`); здесь она для экрана, открытого по прямой ссылке, где в ответе API её нет.
 */
const STATUS_SHORT: Record<DealStatus, Record<ViewerRole, string>> = {
  awaiting_confirmation: { seller: 'ждём подтверждения', client: 'подтвердите условия' },
  changes_requested: { seller: 'предложены изменения', client: 'ждём новые условия' },
  declined: { seller: 'клиент отказался', client: 'вы отказались' },
  expired: { seller: 'срок истёк', client: 'срок истёк' },
  awaiting_prepayment: { seller: 'ждём предоплату', client: 'внесите предоплату' },
  scheduled: { seller: 'запланировано', client: 'запланировано' },
  awaiting_acceptance: { seller: 'ждём приёмку', client: 'примите работу' },
  remarks: { seller: 'есть замечания', client: 'ждём исправлений' },
  awaiting_payment: { seller: 'ждём остаток', client: 'оплатите остаток' },
  paid: { seller: 'нужен чек', client: 'ждём чек' },
  closed: { seller: 'закрыта', client: 'закрыта' },
  cancelled: { seller: 'отменена', client: 'отменена' },
};

export function statusShort(status: DealStatus, role: ViewerRole): string {
  return STATUS_SHORT[status][role];
}

/** «99+» при ста и больше (§5.1). */
export function counterLabel(n: number): string {
  return n >= 100 ? '99+' : String(n);
}

// ─────────────────────────── превью карточки (DESIGN_BRIEF §3.1, экран «Готово») ───────────────────────────

export interface CardPreviewInput {
  publicId: string;
  status: DealStatus;
  /** Статус полной фразой для того, чьими глазами смотрим. */
  statusText: string;
  title: string;
  description: string | null;
  scheduledAt: string | null;
  totalKopecks: number;
  prepaymentKopecks: number;
  cancelRule: CancelRule;
  sellerName: string;
  clientName: string | null;
  demo: boolean;
}

/**
 * Текст карточки так, как её увидит клиент в чате: тот же порядок блоков и те же строки, что в боте, без разметки
 * и кнопок. Экран «Готово» показывает его, чтобы исполнитель знал, что именно уйдёт клиенту.
 */
export function renderCardPreview(v: CardPreviewInput): string {
  const lines: string[] = [];
  if (v.demo) lines.push('🧪 Демо: так видит клиент');
  lines.push(`${statusEmoji(v.status)} ${v.title} #${v.publicId}`);
  lines.push(`Статус: ${v.statusText.charAt(0).toLowerCase()}${v.statusText.slice(1)}`);
  lines.push('');
  lines.push(`Когда: ${v.scheduledAt ? formatDateTime(v.scheduledAt) : 'без даты, срок обсудите отдельно'}`);
  if (v.prepaymentKopecks > 0) {
    const percent = v.totalKopecks > 0 ? Math.round((v.prepaymentKopecks / v.totalKopecks) * 100) : 0;
    lines.push(`Сумма: ${formatKopecks(v.totalKopecks)}, предоплата ${formatKopecks(v.prepaymentKopecks)} (${formatPercent(percent)})`);
  } else {
    lines.push(`Сумма: ${formatKopecks(v.totalKopecks)}, без предоплаты`);
  }
  lines.push(`Отмена: ${CANCEL_RULE_AFTER_LABEL[v.cancelRule]}`);
  const description = v.description?.replace(/\s+/g, ' ').trim();
  if (description) lines.push(`Уточнения: ${description}`);
  lines.push('');
  lines.push(`Исполнитель: ${v.sellerName}`);
  lines.push(`Клиент: ${v.clientName ?? 'ещё не открыл ссылку'}`);
  return lines.join('\n');
}

/** Утренняя сводка: 06:00…12:00 МСК с шагом 30 минут, по умолчанию 08:00 (ЗАДАЧА_04 B2). Значение: минуты от полуночи. */
export const DIGEST_DEFAULT_MINUTES = 8 * 60;
export const DIGEST_TIMES: number[] = Array.from({ length: 13 }, (_, i) => 6 * 60 + i * 30);

export function formatMinutes(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
