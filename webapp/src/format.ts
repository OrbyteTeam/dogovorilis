// Форматирование и тексты интерфейса — docs/SPEC.md §5.1 (эмодзи статусов), §6.4 (карточка), §7.2 (поля формы).
import type { CancelRule, DealStatus, DealView, TaxMode } from './types';

const RUB = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
/** Перед «₽» — неразрывный пробел, как в domain/money.ts: иначе в узкой строке списка знак уезжает на вторую строку. */
const NBSP = '\u00A0';

/** Суммы в контракте — целые копейки (domain/money.ts на сервере). */
export function formatKopecks(kopecks: number): string {
  return `${RUB.format(Math.round(kopecks / 100))}${NBSP}₽`;
}

export function formatRub(rub: number): string {
  return `${RUB.format(rub)}${NBSP}₽`;
}

const DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
});

/**
 * Время — по Москве с меткой «(МСК)», как в карточке бота и квитанции (APP_TIMEZONE сервера). Раньше экран
 * показывал пояс устройства, а бот — МСК без метки: исполнитель из Новосибирска видел 14:00, клиент — 10:00.
 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return 'без даты';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'без даты';
  return `${DATE_TIME.format(date).replace(', ', ' ')} (МСК)`;
}

/** Москва живёт без перехода на летнее время: UTC+3 круглый год. */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Значение `datetime-local` («2026-09-27T14:00») — это время по Москве → момент UTC в ISO. null — строка не разобрана. */
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

export const CANCEL_RULE_LABEL: Record<CancelRule, string> = {
  free_24h: 'Бесплатная отмена за 24 ч и более',
  free_48h: 'Бесплатная отмена за 48 ч и более',
  nonrefundable: 'Предоплата не возвращается',
  full_refund: 'Предоплата возвращается всегда',
};

/** Дословные формулировки для карточки — SPEC §6.4. */
export const CANCEL_RULE_TEXT: Record<CancelRule, string> = {
  free_24h: 'Отмена без потери предоплаты за 24 ч и более до срока',
  free_48h: 'Отмена без потери предоплаты за 48 ч и более до срока',
  nonrefundable: 'Предоплата не возвращается при отмене клиентом',
  full_refund: 'Предоплата возвращается при любой отмене',
};

export const CANCEL_RULES: CancelRule[] = ['free_24h', 'free_48h', 'nonrefundable', 'full_refund'];

export const TAX_MODE_LABEL: Record<TaxMode, string> = {
  npd: 'Самозанятый — чек в «Мой налог»',
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

/**
 * Текстовое превью карточки для экрана «Готово» — порядок строк как в боте (SPEC §6.4),
 * но без разметки и кнопок: это просто напоминание, что именно увидит клиент.
 */
export function renderCardPreview(deal: DealView): string {
  const v = deal.version;
  const lines: string[] = [];
  lines.push(`${statusEmoji(deal.status)} ${v.title} · #${deal.public_id}`);
  lines.push(`Статус: ${deal.status_text}`);
  lines.push('');
  lines.push(`📌 ${v.description?.trim() ? v.description.trim() : '—'}`);
  lines.push(`🗓 ${formatDateTime(v.scheduled_at)}`);
  if (v.prepayment_kopecks > 0) {
    const percent = v.total_kopecks > 0 ? Math.round((v.prepayment_kopecks / v.total_kopecks) * 100) : 0;
    lines.push(
      `💰 ${formatKopecks(v.total_kopecks)} · предоплата ${formatKopecks(v.prepayment_kopecks)} (${percent}%)`,
    );
  } else {
    lines.push(`💰 ${formatKopecks(v.total_kopecks)} · без предоплаты`);
  }
  lines.push(`↩️ ${CANCEL_RULE_TEXT[v.cancel_rule]}`);
  lines.push('');
  lines.push(`👤 Исполнитель: ${deal.seller.name}`);
  lines.push(`👤 Клиент: ${deal.client?.name ?? 'ещё не открыл ссылку'}`);
  if (deal.demo) lines.push('🧪 ДЕМО-сделка — тестовые данные');
  return lines.join('\n');
}

/** Утренняя сводка: 06:00…12:00 МСК с шагом 30 минут, по умолчанию 08:00 (ЗАДАЧА_04 B2). Значение — минуты от полуночи. */
export const DIGEST_DEFAULT_MINUTES = 8 * 60;
export const DIGEST_TIMES: number[] = Array.from({ length: 13 }, (_, i) => 6 * 60 + i * 30);

export function formatMinutes(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
