// «Другое время» (ЗАДАЧА_08 D, SPEC §7.10): занятость исполнителя для пикера и предложение времени клиентом.
// Авторизация — общий хук /api (routes/api.ts). Принятие предложения — кнопка исполнителя (бот) или действие
// `accept_time` экрана сделки: оба идут в dealService.acceptTimeProposal.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cfg } from '../../../config.js';
import { inTx } from '../../../db/pool.js';
import { ForbiddenError, SlotBusyError } from '../../../errors.js';
import type { MaxGateway } from '../../../integrations/max/gateway.js';
import * as texts from '../../../texts.js';
import * as dealService from '../../../domain/deal/service.js';
import { pickerWindow, sellerBusy } from '../../../domain/schedule/availability.js';
import {
  DAY_FIRST_SLOT_MIN,
  DAY_LAST_SLOT_MIN,
  DEFAULT_DURATION_MIN,
  HORIZON_DAYS,
  MIN_LEAD_MIN,
  SLOT_STEP_MIN,
} from '../../../domain/schedule/busy.js';
import { publishOutcome } from '../../bot/outcome.js';
import { checkedPublicId, fail, firstIssue, me, sendError } from '../common.js';
import { fullOf } from './deal-screen.js';

export type TimeDeps = { max: MaxGateway | null };

const proposalSchema = z.object({
  scheduled_at: z.string().datetime({ offset: true }),
  as: z.enum(['client']).optional(),
});

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function registerTimeApi(app: FastifyInstance, deps: TimeDeps): void {
  // Занятость — участнику сделки: интервалы слиты, без названий и клиентов (чужие записи не раскрываем).
  app.get<{ Params: { publicId: string } }>('/api/deals/:publicId/busy', async (req, reply) => {
    const user = me(req);
    try {
      const bundle = await dealService.getBundle(checkedPublicId(req.params.publicId));
      if (dealService.participantRole(bundle.deal, user.maxUserId).length === 0) throw new ForbiddenError('not_participant');
      const now = new Date();
      const { from, to } = pickerWindow(now);
      const busy = await inTx((c) => sellerBusy(c, { sellerUserId: bundle.deal.sellerUserId, excludeDealId: bundle.deal.id, from, to }));
      return {
        duration_min: bundle.deal.durationMin ?? DEFAULT_DURATION_MIN,
        step_min: SLOT_STEP_MIN,
        first_slot: hhmm(DAY_FIRST_SLOT_MIN),
        last_slot: hhmm(DAY_LAST_SLOT_MIN),
        horizon_days: HORIZON_DAYS,
        min_lead_min: MIN_LEAD_MIN,
        now: now.toISOString(),
        current: bundle.version.scheduledAt?.toISOString() ?? null,
        busy: busy.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })),
      };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // Предложение времени — только клиент сделки (в демо — исполнитель с as=client), SPEC §7.10.
  app.post<{ Params: { publicId: string } }>('/api/deals/:publicId/time-proposals', async (req, reply) => {
    const user = me(req);
    const parsed = proposalSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'validation', firstIssue(parsed.error.issues));
    try {
      const publicId = checkedPublicId(req.params.publicId);
      const { result, proposal } = await dealService.proposeTime(
        publicId,
        { userId: user.maxUserId, role: 'client' },
        new Date(parsed.data.scheduled_at),
        { tz: cfg().APP_TIMEZONE, text: texts.TIME_PROPOSAL_TEXT(new Date(parsed.data.scheduled_at)) },
      );
      if (deps.max) await publishOutcome(deps.max, result);
      return {
        proposal: { id: proposal.id, scheduled_at: proposal.scheduledAt.toISOString(), status: proposal.status },
        deal: await fullOf(result.bundle, 'client', user.maxUserId),
      };
    } catch (e) {
      if (e instanceof SlotBusyError) return fail(reply, 409, 'slot_busy', texts.API_SLOT_BUSY);
      return sendError(reply, e);
    }
  });
}
