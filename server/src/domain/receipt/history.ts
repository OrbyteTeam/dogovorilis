// Хронология сделки и прошлые версии условий для квитанции PDF (DESIGN_BRIEF §8 п. 4 и п. 6).
// Источник — журнал deal_events и таблица deal_versions (SPEC §5.4, §8): только чтение, схема не меняется.
// Разбор событий в строки — чистая функция buildHistory, её проверяет тест без БД; loadReceiptHistory лишь читает.
import { inTx } from '../../db/pool.js';
import * as eventsRepo from '../../db/repos/events.js';
import * as paymentsRepo from '../../db/repos/payments.js';
import * as versionsRepo from '../../db/repos/versions.js';
import type { CancelRule, DealEvent, DealVersion, Payment } from '../../types.js';
import { formatMoney } from '../money.js';
import { DEFAULT_TZ, formatDocWhen } from '../time.js';

export type HistoryEntry = { at: Date; text: string };
export type PastVersion = { version: number; createdAt: Date; changes: string };
export type ReceiptHistory = { entries: HistoryEntry[]; pastVersions: PastVersion[] };

const KIND: Record<'prepayment' | 'final', string> = { prepayment: 'Предоплата', final: 'Остаток' };
const BY: Record<string, string> = { seller: 'исполнителем', client: 'клиентом', system: 'автоматически' };

// После «правило отмены:» слово «отмена» не повторяем (DESIGN_BRIEF §3.1).
const CANCEL_RULE: Record<CancelRule, string> = {
  free_24h: 'без потери предоплаты за 24 ч и более до срока',
  free_48h: 'без потери предоплаты за 48 ч и более до срока',
  nonrefundable: 'предоплата не возвращается при отмене клиентом',
  full_refund: 'предоплата возвращается при любой отмене',
};

function howPaid(p: Payment | undefined): string {
  if (!p) return '';
  if (p.rail === 'transfer') return ' переводом по реквизитам';
  if (p.provider === 'yookassa') return ' по ссылке ЮKassa (тест)';
  if (p.provider === 'tbank') return ' по ссылке Т-Банка (тест)';
  return ' по ссылке';
}

/** Одна строка хронологии по событию; null: служебное событие, в квитанцию не идёт (напоминания, демо). */
function describe(e: DealEvent, payments: Map<number, Payment>): string | null {
  const payment = payments.get(Number(e.payload.payment_id));
  switch (e.type) {
    case 'deal.created':
      return 'Исполнитель создал сделку';
    case 'client.joined':
      return 'Клиент открыл карточку';
    case 'version.change_requested':
      return 'Клиент предложил изменения';
    case 'version.created':
      return e.payload.kept_as_is ? 'Исполнитель оставил условия без изменений' : `Исполнитель изменил условия, версия ${Number(e.payload.version)}`;
    case 'version.confirmed':
      return `Клиент подтвердил условия, версия ${Number(e.payload.version ?? 1)}`;
    case 'deal.declined':
      return 'Клиент отказался от сделки';
    case 'deal.expired':
      return 'Срок подтверждения истёк (72 ч)';
    case 'payment.created':
      return e.payload.rail === 'transfer' ? 'Клиент выбрал перевод по реквизитам' : 'Выдана ссылка на оплату';
    case 'payment.claimed':
      return payment ? `Клиент сообщил о переводе ${formatMoney(payment.amountKopecks)}` : 'Клиент сообщил о переводе';
    case 'payment.not_received':
      return 'Исполнитель не видит перевода';
    case 'payment.succeeded': {
      if (e.payload.no_remainder) return null; // остатка нет: оплачено предоплатой целиком
      const kind = e.payload.kind === 'final' ? 'final' : 'prepayment';
      const sum = payment ? ` ${formatMoney(payment.amountKopecks)}` : '';
      return `${KIND[kind]}${sum} ${kind === 'prepayment' ? 'получена' : 'получен'}${howPaid(payment)}`;
    }
    case 'payment.succeeded_late':
      return `Поступила оплата ${formatMoney(Number(e.payload.amount ?? 0))} после отмены или повторно, исполнителю нужно её вернуть`;
    case 'payment.canceled':
      return e.payload.reason === 'rail_switch' ? 'Клиент выбрал другой способ оплаты' : 'Оплата отменена';
    case 'deal.done':
      return 'Исполнитель отметил выполнение';
    case 'deal.accepted':
      return 'Клиент принял работу';
    case 'deal.remarks':
      return 'Клиент оставил замечания';
    case 'deal.fixed':
      return 'Исполнитель исправил замечания';
    case 'receipt.attached':
      return 'Исполнитель приложил чек';
    case 'deal.closed_without_receipt':
      return 'Исполнитель закрыл сделку без чека';
    case 'deal.closed':
      return 'Сделка закрыта';
    case 'deal.cancelled': {
      const reason = typeof e.payload.reason === 'string' && e.payload.reason.trim() ? `: ${e.payload.reason.trim()}` : '';
      return `Сделка отменена ${BY[String(e.payload.by)] ?? ''}${reason}`.replace(' :', ':');
    }
    case 'refund.confirmed':
      return e.payload.by === 'client' ? 'Клиент подтвердил получение возврата' : 'Исполнитель отметил возврат предоплаты';
    default:
      return null; // reminder.sent, reminder.skipped, demo.opened
  }
}

/** Что в прошлой версии было иначе, чем в следующей: значения прошлой версии по порядку формы. */
function versionChanges(prev: DealVersion, next: DealVersion, tz: string): string {
  const out: string[] = [];
  if (prev.title !== next.title) out.push(`что: «${prev.title}»`);
  if ((prev.description ?? '') !== (next.description ?? '')) out.push('другие уточнения');
  if ((prev.scheduledAt?.getTime() ?? null) !== (next.scheduledAt?.getTime() ?? null)) {
    out.push(`когда: ${prev.scheduledAt ? formatDocWhen(prev.scheduledAt, tz) : 'без даты'}`);
  }
  if (prev.totalKopecks !== next.totalKopecks) out.push(`сумма ${formatMoney(prev.totalKopecks)}`);
  if (prev.prepaymentKopecks !== next.prepaymentKopecks) {
    out.push(prev.prepaymentKopecks > 0 ? `предоплата ${formatMoney(prev.prepaymentKopecks)}` : 'без предоплаты');
  }
  if (prev.cancelRule !== next.cancelRule) out.push(`правило отмены: ${CANCEL_RULE[prev.cancelRule]}`);
  return out.length ? out.join(', ') : 'те же условия';
}

/** События и версии сделки в строки квитанции. Порядок хронологический сверху вниз (DESIGN_BRIEF §5.2, §8). */
export function buildHistory(events: DealEvent[], versions: DealVersion[], payments: Payment[], tz: string = DEFAULT_TZ): ReceiptHistory {
  const byId = new Map(payments.map((p) => [p.id, p]));
  const entries = events
    .map((e) => ({ at: e.createdAt, text: describe(e, byId) }))
    .filter((e): e is HistoryEntry => e.text !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const pastVersions = sorted.slice(0, -1).map((v, i) => ({ version: v.version, createdAt: v.createdAt, changes: versionChanges(v, sorted[i + 1], tz) }));
  return { entries, pastVersions };
}

export async function loadReceiptHistory(dealId: number, tz: string = DEFAULT_TZ): Promise<ReceiptHistory> {
  const { events, versions, payments } = await inTx(async (c) => ({
    events: await eventsRepo.listByDeal(c, dealId, 500),
    versions: await versionsRepo.listByDeal(c, dealId),
    payments: await paymentsRepo.listByDeal(c, dealId),
  }));
  return buildHistory(events, versions, payments, tz);
}
