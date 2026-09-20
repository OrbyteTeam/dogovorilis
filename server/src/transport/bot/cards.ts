// Рендер и синхронизация карточек. Карточка — сообщение бота, которое правится на месте (SPEC §6.4, §19).
// У каждой стороны своя карточка; в демо-режиме обе живут в одном чате (§12).
import { cfg, dealLink } from '../../config.js';
import * as cardsRepo from '../../db/repos/cards.js';
import { inTx } from '../../db/pool.js';
import type { MaxGateway } from '../../integrations/max/gateway.js';
import { log } from '../../logger.js';
import * as texts from '../../texts.js';
import { livePayment, paidTotal, remaining, type CardMessage, type CardRole, type DealBundle } from '../../types.js';
import { receiptDeadline } from '../../domain/time.js';
import { taxModeOf } from '../../domain/deal/service.js';
import { cardKeyboard, pendingKind } from './keyboards.js';

/** Доступность рейлов в карточке клиента (SPEC §9.1). В ЗАДАЧА_01 «ссылка» видна, но отвечает E11. */
export function railVisibility(bundle: DealBundle): { linkRailVisible: boolean; transferRailVisible: boolean } {
  const profile = bundle.sellerProfile;
  return {
    // Кнопка показывается всегда: по ЗАДАЧА_01 она должна существовать и отвечать E11,
    // даже когда PAYMENT_PROVIDER=none (расхождение со SPEC §9.1 отмечено в docs/ДОПУЩЕНИЯ.md).
    linkRailVisible: profile?.linkEnabled !== false,
    transferRailVisible: profile?.transferEnabled !== false,
  };
}

function paymentLineFor(bundle: DealBundle): string | null {
  const kind = pendingKind(bundle);
  if (kind) {
    const live = livePayment(bundle.payments, kind);
    const sum = kind === 'prepayment' ? bundle.version.prepaymentKopecks : remaining(bundle.version);
    if (!live || live.status === 'pending') {
      return live?.rail === 'link'
        ? texts.paymentLine({ kind, state: 'link_issued', sumKopecks: sum, at: null, rail: 'link', provider: live.provider, linkExpiresAt: live.expiresAt })
        : texts.paymentLine({ kind, state: 'awaiting', sumKopecks: sum, at: null, rail: null, provider: null, linkExpiresAt: null });
    }
    if (live.status === 'claimed') {
      return texts.paymentLine({ kind, state: 'claimed', sumKopecks: live.amountKopecks, at: live.claimedAt, rail: live.rail, provider: live.provider, linkExpiresAt: null });
    }
  }
  const succeeded = bundle.payments
    .filter((p) => p.status === 'succeeded')
    .sort((a, b) => (a.succeededAt?.getTime() ?? 0) - (b.succeededAt?.getTime() ?? 0))
    .at(-1);
  if (!succeeded) return null;
  return texts.paymentLine({
    kind: succeeded.kind,
    state: 'received',
    sumKopecks: succeeded.amountKopecks,
    at: succeeded.succeededAt,
    rail: succeeded.rail,
    provider: succeeded.provider,
    linkExpiresAt: null,
  });
}

function receiptLineFor(bundle: DealBundle): string | null {
  const status = bundle.deal.status;
  if (status !== 'paid' && status !== 'closed') return null;
  const taxMode = taxModeOf(bundle);
  return texts.receiptLine({
    attachedAt: bundle.receipt?.createdAt ?? null,
    deadline: bundle.deal.paidAt ? receiptDeadline(bundle.deal.paidAt, cfg().APP_TIMEZONE) : null,
    taxModeNone: taxMode === 'none',
  });
}

export function buildCardView(bundle: DealBundle, role: CardRole): texts.CardView {
  const { deal, version, seller, client } = bundle;
  const showLink = role === 'seller' && deal.clientUserId === null;
  return {
    publicId: deal.publicId,
    status: deal.status,
    role,
    title: version.title,
    description: version.description,
    scheduledAt: version.scheduledAt,
    totalKopecks: version.totalKopecks,
    prepaymentKopecks: version.prepaymentKopecks,
    remainingKopecks: remaining(version),
    cancelRule: version.cancelRule,
    hasPhoto: Boolean(version.photoMaxToken),
    sellerName: bundle.sellerProfile?.displayName || displayName(seller.firstName, seller.lastName),
    clientName: deal.demo
      ? 'демо-клиент (вы)'
      : client
        ? displayName(client.firstName, client.lastName)
        : null,
    demo: deal.demo,
    paymentLine: paymentLineFor(bundle),
    receiptLine: receiptLineFor(bundle),
    refundLine: texts.refundLine({ prepaymentKopecks: version.prepaymentKopecks, expected: deal.cancelRefundExpected }),
    clientLink: showLink ? dealLink(deal.publicId) : null,
  };
}

export function displayName(firstName: string, lastName: string | null): string {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || 'без имени';
}

export function renderCard(bundle: DealBundle, role: CardRole): { text: string; attachments: NonNullable<unknown>[] } {
  const c = cfg();
  const text = texts.card(buildCardView(bundle, role));
  const kb = cardKeyboard(bundle, role, {
    botUsername: c.MAX_BOT_USERNAME || 'bot',
    demoMode: c.DEMO_MODE,
    dealLink: dealLink(bundle.deal.publicId),
    ...railVisibility(bundle),
  });
  return { text, attachments: kb ? [kb] : [] };
}

/** Кому и в каком виде принадлежат карточки этой сделки. В демо у одного пользователя их две. */
export function cardTargets(bundle: DealBundle): Array<{ userId: number; role: CardRole }> {
  const out: Array<{ userId: number; role: CardRole }> = [{ userId: bundle.deal.sellerUserId, role: 'seller' }];
  if (bundle.deal.clientUserId) {
    out.push({ userId: bundle.deal.clientUserId, role: bundle.deal.demo ? 'client_demo' : 'client' });
  }
  return out;
}

/**
 * Отправить новую карточку и запомнить её mid.
 * Возвращает mid; если у получателя нет диалога с ботом, ничего не делает (бот не пишет первым — MAX_API §1 п. 5).
 */
export async function sendCard(
  max: MaxGateway,
  bundle: DealBundle,
  role: CardRole,
  a: { userId: number; chatId: number | null },
): Promise<string | null> {
  if (!a.chatId) {
    log.info({ deal: bundle.deal.publicId, user: a.userId, role }, 'карточка не отправлена: нет диалога с ботом');
    return null;
  }
  const { text, attachments } = renderCard(bundle, role);
  const mid = await max.send({ chatId: a.chatId }, text, attachments as never);
  await inTx((c) => cardsRepo.upsert(c, { dealId: bundle.deal.id, userId: a.userId, role, chatId: a.chatId!, mid }));
  return mid;
}

/**
 * Обновить все карточки сделки на месте. Если правка не удалась (сообщение удалено) — отправляем новую
 * и переписываем mid (SPEC §8, §14 п. 4). Ошибка одной карточки не мешает остальным.
 */
export async function syncCards(max: MaxGateway, bundle: DealBundle, skipMid?: string): Promise<void> {
  const stored = await inTx((c) => cardsRepo.byDeal(c, bundle.deal.id));
  await Promise.all(
    stored.map(async (card: CardMessage) => {
      if (skipMid && card.mid === skipMid) return; // это сообщение уже обновлено ответом на кнопку
      const { text, attachments } = renderCard(bundle, card.role);
      try {
        const ok = await max.edit(card.mid, text, attachments as never);
        if (ok) return;
        const mid = await max.send({ chatId: card.chatId }, text, attachments as never);
        await inTx((c) => cardsRepo.updateMid(c, card.id, mid));
      } catch (e) {
        log.warn({ deal: bundle.deal.publicId, role: card.role, err: (e as Error).message }, 'не удалось обновить карточку');
      }
    }),
  );
}

/** Есть ли уже карточка у этой роли — чтобы не дублировать при повторном входе клиента. */
export async function hasCard(dealId: number, role: CardRole): Promise<boolean> {
  const card = await inTx((c) => cardsRepo.byDealAndRole(c, dealId, role));
  return card !== null;
}

export function paidSum(bundle: DealBundle): number {
  return paidTotal(bundle.payments);
}
