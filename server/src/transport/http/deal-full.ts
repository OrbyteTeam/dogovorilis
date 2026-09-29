// Экран сделки в мини-приложении (ЗАДАЧА_08 B, SPEC §7.9): представление `DealFull` для GET /api/deals/:id/full.
// Главное правило экрана — действия ровно те же, что у карточки в чате. Поэтому список действий не вычисляется
// заново, а читается из клавиатуры карточки (cardKeyboard): расходиться с чатом ему не из чего.
import { cfg, dealLink } from '../../config.js';
import * as texts from '../../texts.js';
import {
  isTerminal,
  paidTotal,
  remaining,
  type CardRole,
  type DealBundle,
  type DealEvent,
  type DealVersion,
  type Payment,
} from '../../types.js';
import { receiptDeadline } from '../../domain/time.js';
import { refundIfCancelled, taxModeOf } from '../../domain/deal/service.js';
import type { AttachmentRequest } from '../../integrations/max/gateway.js';
import { parseCallback } from '../bot/callbacks.js';
import { displayName, railVisibility } from '../bot/cards.js';
import { cardKeyboard, pendingKind } from '../bot/keyboards.js';

/** Коды действий экрана (SPEC §7.9). Первые — выполняет сервер (POST /actions), остальные — само мини-приложение. */
export const SERVER_ACTIONS = [
  'confirm',
  'request_changes',
  'decline',
  'accept',
  'remarks',
  'cancel',
  'keep_as_is',
  'done',
  'fixed',
  'close_without_receipt',
  'remind_client',
  'refund_confirmed',
  'receipt_pdf',
] as const;
export const CLIENT_SIDE_ACTIONS = ['edit', 'repeat', 'attach_receipt', 'share', 'pay', 'confirm_transfer', 'open_as_client'] as const;

export type ServerAction = (typeof SERVER_ACTIONS)[number];
export type ActionCode = ServerAction | (typeof CLIENT_SIDE_ACTIONS)[number];

/** Код callback-кнопки карточки (SPEC §13) → действие экрана. `op` («Открыть») на экране не нужен. */
const CALLBACK_ACTION: Record<string, ActionCode | null> = {
  cf: 'confirm',
  cr: 'request_changes',
  dc: 'decline',
  ac: 'accept',
  rm: 'remarks',
  cn: 'cancel',
  ka: 'keep_as_is',
  dn: 'done',
  fx: 'fixed',
  nc: 'close_without_receipt',
  rs: 'remind_client',
  rf: 'refund_confirmed',
  pdf: 'receipt_pdf',
  rc: 'attach_receipt',
  dm: 'open_as_client',
  pl: 'pay',
  pt: 'pay',
  nl: 'pay',
  pc: 'pay',
  pe: 'pay',
  op: null,
};

type AnyButton = { type?: string; payload?: string; url?: string };

function buttonsOf(kb: AttachmentRequest | null): AnyButton[] {
  const rows = (kb as { payload?: { buttons?: AnyButton[][] } } | null)?.payload?.buttons ?? [];
  return rows.flat();
}

export function actionOfButton(b: AnyButton): ActionCode | null {
  switch (b.type) {
    case 'callback': {
      const parsed = parseCallback(b.payload);
      if (parsed?.kind !== 'deal') return null;
      // «Перевёл» и «Отмена перевода» — клиент платит; «Получил» и «Не вижу» — исполнитель подтверждает перевод.
      if (parsed.code === 'tr') return parsed.sub === 'g' || parsed.sub === 'n' ? 'confirm_transfer' : 'pay';
      return CALLBACK_ACTION[parsed.code] ?? null;
    }
    case 'open_app':
      if (b.payload?.startsWith('edit_')) return 'edit';
      if (b.payload?.startsWith('repeat_')) return 'repeat';
      return null;
    case 'link':
      // «Отправить в MAX» ведёт на :share, «Перейти к оплате» — к провайдеру.
      return b.url?.startsWith('https://max.ru/:share') ? 'share' : 'pay';
    case 'clipboard':
      return 'share';
    default:
      return null;
  }
}

/** Действия, которые есть на клавиатуре, по порядку кнопок, без повторов. */
export function actionsFromKeyboard(kb: AttachmentRequest | null): ActionCode[] {
  const out: ActionCode[] = [];
  for (const b of buttonsOf(kb)) {
    const a = actionOfButton(b);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/** Роль карточки: клиент демо-сделки видит клиентскую карточку «client_demo» (SPEC §12). */
export function cardRoleOf(bundle: DealBundle, role: 'seller' | 'client'): CardRole {
  return role === 'client' && bundle.deal.demo ? 'client_demo' : role;
}

/** Действия экрана для роли — клавиатура той же карточки, что сейчас в чате у этой стороны. */
export function cardActions(bundle: DealBundle, role: 'seller' | 'client'): ActionCode[] {
  const c = cfg();
  const kb = cardKeyboard(bundle, cardRoleOf(bundle, role), {
    botUsername: c.MAX_BOT_USERNAME || 'bot',
    demoMode: c.DEMO_MODE,
    dealLink: dealLink(bundle.deal.publicId),
    ...railVisibility(bundle),
  });
  return actionsFromKeyboard(kb);
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function versionView(v: DealVersion) {
  return {
    version: v.version,
    created_at: v.createdAt.toISOString(),
    confirmed_at: iso(v.confirmedAt),
    title: v.title,
    scheduled_at: iso(v.scheduledAt),
    total_kopecks: v.totalKopecks,
    prepayment_kopecks: v.prepaymentKopecks,
    cancel_rule: v.cancelRule,
    change_request_text: v.changeRequestText,
  };
}

/** Платежи на экране — живые и состоявшиеся; неудачные попытки видны в хронологии, а не списком. */
function paymentsView(payments: Payment[]) {
  return payments
    .filter((p) => p.status === 'succeeded' || p.status === 'claimed' || p.status === 'pending')
    .sort((a, b) => a.id - b.id)
    .map((p) => {
      const at = p.succeededAt ?? p.claimedAt ?? p.createdAt;
      return {
        kind: p.kind,
        rail: p.rail,
        status: p.status,
        amount_kopecks: p.amountKopecks,
        at: at.toISOString(),
        label: texts.paymentLabel({ kind: p.kind, rail: p.rail, provider: p.provider, status: p.status, amountKopecks: p.amountKopecks, at }),
      };
    });
}

function actorOf(e: DealEvent): 'seller' | 'client' | 'system' {
  if (e.actorRole === 'client' || e.actorRole === 'client_demo') return 'client';
  return e.actorRole;
}

/** Хронология от старых событий к новым; служебные события (напоминания и т. п.) не показываются. */
export function timelineView(events: DealEvent[], payments: Payment[]) {
  const byId = new Map(payments.map((p) => [p.id, p]));
  const out: Array<{ at: string; actor: 'seller' | 'client' | 'system'; text: string }> = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const pid = typeof e.payload.payment_id === 'number' ? e.payload.payment_id : Number(e.payload.payment_id);
    const p = Number.isFinite(pid) ? byId.get(pid) : undefined;
    const payment = p ? { kind: p.kind, rail: p.rail, provider: p.provider, amountKopecks: p.amountKopecks } : null;
    const text = texts.timelineText(e.type, e.payload, { actor: actorOf(e), payment });
    if (text) out.push({ at: e.createdAt.toISOString(), actor: actorOf(e), text });
  }
  return out;
}

export type DealFullInput = {
  bundle: DealBundle;
  role: 'seller' | 'client';
  viewerId: number;
  versions: DealVersion[];
  events: DealEvent[];
};

/** DealFull (SPEC §7.9): всё, что нужно экрану сделки, одним ответом; тексты уже готовы к показу. */
export function dealFullView({ bundle, role, viewerId, versions, events }: DealFullInput) {
  const { deal, version } = bundle;
  const cardRole = cardRoleOf(bundle, role);
  const actions = cardActions(bundle, role);
  const kind = pendingKind(bundle);
  const due = kind === 'prepayment' ? version.prepaymentKopecks : kind === 'final' ? remaining(version) : 0;
  const statusArgs = { prepaymentKopecks: version.prepaymentKopecks, remainingKopecks: remaining(version), scheduledAt: version.scheduledAt };
  const consequence = actions.includes('cancel')
    ? texts.CANCEL_CONSEQUENCE({ by: role, prepaymentKopecks: version.prepaymentKopecks, expected: refundIfCancelled(bundle, role) })
    : null;
  const clientName = deal.demo
    ? 'демо-клиент (вы)'
    : bundle.client
      ? displayName(bundle.client.firstName, bundle.client.lastName)
      : null;

  return {
    public_id: deal.publicId,
    role,
    can_view_as_client: deal.demo && deal.sellerUserId === viewerId && deal.clientUserId === viewerId,
    demo: deal.demo,
    status: deal.status,
    status_text: texts.statusText(deal.status, cardRole, statusArgs),
    status_short: texts.statusShort(deal.status, cardRole),
    link: dealLink(deal.publicId),
    share_text: texts.shareInvite(version.title, version.scheduledAt),
    terms: {
      version: version.version,
      title: version.title,
      description: version.description,
      scheduled_at: iso(version.scheduledAt),
      total_kopecks: version.totalKopecks,
      prepayment_kopecks: version.prepaymentKopecks,
      remaining_kopecks: remaining(version),
      cancel_rule: version.cancelRule,
      cancel_rule_text: texts.cancelRuleText(version.cancelRule),
      created_at: version.createdAt.toISOString(),
      confirmed_at: iso(version.confirmedAt),
    },
    versions: [...versions].sort((a, b) => a.version - b.version).map(versionView),
    seller: { name: bundle.sellerProfile?.displayName || displayName(bundle.seller.firstName, bundle.seller.lastName) },
    client: clientName ? { name: clientName } : null,
    money: {
      paid_kopecks: paidTotal(bundle.payments),
      due_kopecks: due,
      payments: paymentsView(bundle.payments),
    },
    timeline: timelineView(events, bundle.payments),
    documents: {
      receipt_pdf: isTerminal(deal.status),
      cheque_text: texts.chequeText({
        status: deal.status,
        attachedAt: bundle.receipt?.createdAt ?? null,
        deadline: deal.paidAt ? receiptDeadline(deal.paidAt, cfg().APP_TIMEZONE) : null,
        taxModeNone: taxModeOf(bundle) === 'none',
      }),
    },
    actions,
    cancel_consequence: consequence,
  };
}

export type DealFull = ReturnType<typeof dealFullView>;
