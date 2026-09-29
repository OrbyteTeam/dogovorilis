// Оценка клиента и надёжность исполнителя (ЗАДАЧА_08 E, SPEC §7.11). Оценку видит только исполнитель; публичного
// рейтинга нет. Показатели — из фактов сделок (domain/reliability.ts), демо-сделки в них не входят.
import { inTx } from '../db/pool.js';
import * as dealsRepo from '../db/repos/deals.js';
import * as ratingsRepo from '../db/repos/ratings.js';
import type { DealRating } from '../db/repos/ratings.js';
import { ForbiddenError, InvalidTransition, NotFoundError, ValidationError } from '../errors.js';
import type { Deal, Reliability } from '../types.js';
import { computeReliability } from './reliability.js';
import { DEFAULT_TZ } from './time.js';

export const RATING_COMMENT_MAX = 500;

export type RateOutcome = { created: true; rating: DealRating; deal: Deal } | { created: false; rating: DealRating | null; deal: Deal };

/** Оценка 1–5 — только клиент закрытой сделки, один раз (повтор — `created: false`, первая оценка остаётся). */
export async function rateDeal(publicId: string, clientUserId: number, score: number): Promise<RateOutcome> {
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new ValidationError('Оценка от 1 до 5', 'score');
  return inTx(async (c) => {
    const deal = await dealsRepo.byPublicId(c, publicId);
    if (!deal) throw new NotFoundError(`сделка ${publicId}`);
    if (deal.clientUserId !== clientUserId) throw new ForbiddenError('оценивает клиент сделки');
    if (deal.status !== 'closed') throw new InvalidTransition(deal.status, 'accept', 'client', 'forbidden');
    const created = await ratingsRepo.createOnce(c, { dealId: deal.id, clientUserId, score });
    if (created) return { created: true, rating: created, deal };
    return { created: false, rating: await ratingsRepo.byDeal(c, deal.id), deal };
  });
}

/** Комментарий к своей оценке — один раз, до 500 символов. false — оценки нет или комментарий уже есть. */
export async function commentRating(dealId: number, clientUserId: number, text: string, now = new Date()): Promise<boolean> {
  const comment = text.trim();
  if (comment.length < 1 || comment.length > RATING_COMMENT_MAX) throw new ValidationError('Комментарий до 500 символов', 'comment');
  return inTx((c) => ratingsRepo.setCommentOnce(c, { dealId, clientUserId, comment, now }));
}

export function ratingOf(dealId: number): Promise<DealRating | null> {
  return inTx((c) => ratingsRepo.byDeal(c, dealId));
}

/** Показатели исполнителя по его завершённым не-демо сделкам. */
export async function sellerReliability(sellerUserId: number, tz: string = DEFAULT_TZ): Promise<Reliability> {
  const facts = await inTx((c) => ratingsRepo.finishedFacts(c, sellerUserId));
  return computeReliability(facts, tz);
}
