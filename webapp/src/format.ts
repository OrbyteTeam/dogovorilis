// Форматирование и тексты интерфейса — docs/SPEC.md §5.1 (эмодзи статусов), §6.4 (карточка), §7.2 (поля формы).
import type { CancelRule, DealStatus, DealView, TaxMode } from './types';

const RUB = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/** Суммы в контракте — целые копейки (domain/money.ts на сервере). */
export function formatKopecks(kopecks: number): string {
  return `${RUB.format(Math.round(kopecks / 100))} ₽`;
}

export function formatRub(rub: number): string {
  return `${RUB.format(rub)} ₽`;
}

const DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Время показываем в часовом поясе устройства исполнителя — сервер хранит UTC (SPEC §4.3, APP_TIMEZONE). */
export function formatDateTime(iso: string | null): string {
  if (!iso) return 'без даты';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'без даты';
  return DATE_TIME.format(date).replace(', ', ' ');
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
