// Представления для мини-приложения (SPEC §7.8). Наружу — snake_case, внутрь домена — camelCase.
import { dealLink } from '../../config.js';
import * as texts from '../../texts.js';
import { isTerminal, paidTotal, remaining, type DealBundle, type DealListItem, type SellerProfile, type User } from '../../types.js';
import { TEMPLATES } from '../../domain/templates.js';
import { EDITABLE_STATUSES } from '../../domain/deal/state-machine.js';
import { displayName } from '../bot/cards.js';

export function userView(user: User) {
  return {
    id: user.maxUserId,
    first_name: user.firstName,
    last_name: user.lastName,
    username: user.username,
    phone_verified: user.phoneVerifiedAt !== null,
  };
}

export function profileView(p: SellerProfile | null) {
  if (!p) return null;
  return {
    display_name: p.displayName,
    tax_mode: p.taxMode,
    payout_details: p.payoutDetails,
    transfer_enabled: p.transferEnabled,
    link_enabled: p.linkEnabled,
    default_cancel_rule: p.defaultCancelRule,
    digest_time: p.digestTime,
  };
}

export function templatesView() {
  return TEMPLATES.map((t) => ({
    key: t.key,
    label: t.label,
    title: t.title,
    prepayment_percent: t.prepaymentPercent,
    cancel_rule: t.cancelRule,
    date_required: t.dateRequired,
    hint: t.hint,
  }));
}

export function dealListItemView(item: DealListItem) {
  return {
    public_id: item.publicId,
    status: item.status,
    status_text: texts.statusText(item.status, item.role, {
      prepaymentKopecks: item.prepaymentKopecks,
      remainingKopecks: item.totalKopecks - item.prepaymentKopecks,
      scheduledAt: item.scheduledAt,
    }),
    status_short: texts.statusShort(item.status, item.role),
    demo: item.demo,
    role: item.role,
    title: item.title,
    scheduled_at: item.scheduledAt?.toISOString() ?? null,
    total_kopecks: item.totalKopecks,
    prepayment_kopecks: item.prepaymentKopecks,
    paid_kopecks: item.paidKopecks,
    updated_at: item.updatedAt.toISOString(),
    client_name: item.clientName,
  };
}

export function dealView(bundle: DealBundle) {
  const { deal, version } = bundle;
  const sellerName = bundle.sellerProfile?.displayName ?? bundle.seller.firstName;
  return {
    public_id: deal.publicId,
    status: deal.status,
    status_text: texts.statusText(deal.status, 'seller', {
      prepaymentKopecks: version.prepaymentKopecks,
      remainingKopecks: remaining(version),
      scheduledAt: version.scheduledAt,
    }),
    template: deal.template,
    demo: deal.demo,
    seller: { name: sellerName },
    client: bundle.client ? { name: bundle.client.firstName } : null,
    version: {
      version: version.version,
      title: version.title,
      description: version.description,
      scheduled_at: version.scheduledAt?.toISOString() ?? null,
      total_kopecks: version.totalKopecks,
      prepayment_kopecks: version.prepaymentKopecks,
      cancel_rule: version.cancelRule,
      photo_max_token: version.photoMaxToken,
    },
    remaining_kopecks: remaining(version),
    paid_kopecks: paidTotal(bundle.payments),
    link: dealLink(deal.publicId),
    timestamps: {
      created_at: deal.createdAt.toISOString(),
      confirmed_at: deal.confirmedAt?.toISOString() ?? null,
      done_at: deal.doneAt?.toISOString() ?? null,
      accepted_at: deal.acceptedAt?.toISOString() ?? null,
      paid_at: deal.paidAt?.toISOString() ?? null,
      closed_at: deal.closedAt?.toISOString() ?? null,
      cancelled_at: deal.cancelledAt?.toISOString() ?? null,
    },
  };
}

/** Текст приглашения БЕЗ ссылки: мини-приложение передаёт её в `shareMaxContent` отдельно (ЗАДАЧА_04 A1). */
export function shareText(bundle: DealBundle): string {
  return texts.shareInvite(bundle.version.title, bundle.version.scheduledAt);
}

/** У сделки есть клиент-человек: не демо (там клиент — сам исполнитель) и клиент уже открыл ссылку. */
export function realClientOf(bundle: DealBundle) {
  const { deal, client } = bundle;
  if (deal.demo || !client || deal.clientUserId === deal.sellerUserId) return null;
  return client;
}

/**
 * GET /api/deals/:publicId (SPEC §7.8): предзаполнение формы правки условий (T5) и «Повторить» — поля текущей
 * версии, суммы в целых рублях, и что смотрящему можно: править (исполнитель, до подтверждения) и повторить
 * (исполнитель, сделка завершена, не демо; «тот же клиент» — если клиент был настоящий).
 */
export function dealEditView(bundle: DealBundle, role: 'seller' | 'client') {
  const { deal, version } = bundle;
  const client = realClientOf(bundle);
  const canRepeat = role === 'seller' && isTerminal(deal.status) && !deal.demo;
  return {
    public_id: deal.publicId,
    status: deal.status,
    version: deal.currentVersion,
    role,
    demo: deal.demo,
    template: deal.template,
    title: version.title,
    description: version.description,
    scheduled_at: version.scheduledAt?.toISOString() ?? null,
    total_rub: Math.round(version.totalKopecks / 100),
    prepayment_rub: Math.round(version.prepaymentKopecks / 100),
    cancel_rule: version.cancelRule,
    client: client ? { name: displayName(client.firstName, client.lastName) } : null,
    can_edit: role === 'seller' && EDITABLE_STATUSES.includes(deal.status),
    can_repeat: canRepeat,
    same_client_available: canRepeat && client !== null,
  };
}
