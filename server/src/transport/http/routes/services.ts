// «Мои услуги» (ЗАДАЧА_08 C, SPEC §7.6a, §7.8): GET/POST /api/services, PUT /api/services/:id, PUT /api/services/order.
// Суммы в API — целые рубли, как у сделок; внутри — копейки. Авторизация — общий хук /api (routes/api.ts).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServiceFields } from '../../../db/repos/services.js';
import { NotFoundError } from '../../../errors.js';
import * as texts from '../../../texts.js';
import type { SellerService } from '../../../types.js';
import { rublesToKopecks } from '../../../domain/money.js';
import * as services from '../../../domain/services.js';
import { ServicesLimitError } from '../../../domain/services.js';
import { fail, firstIssue, me, sendError } from '../common.js';
import { cancelRuleSchema, templateSchema } from '../schemas.js';

const prepaymentSchema = z.object({
  kind: z.enum(['none', 'percent', 'amount']),
  value: z.number().int('Предоплата целым числом').min(0).max(1_000_000),
});

export const serviceSchema = z.object({
  title: z.string().trim().min(2, 'Название от 2 до 80 символов').max(80, 'Название от 2 до 80 символов'),
  description: z.string().max(1000, 'Уточнения до 1000 символов').nullish(),
  price_rub: z.number().int('Цена целым числом рублей').min(1, 'Цена от 1 до 1 000 000 ₽').max(1_000_000, 'Цена от 1 до 1 000 000 ₽'),
  duration_min: z.number().int().default(services.DEFAULT_DURATION_MIN),
  prepayment: prepaymentSchema.default({ kind: 'none', value: 0 }),
  cancel_rule: cancelRuleSchema,
  template: templateSchema.default('free'),
  active: z.boolean().optional(),
});
const orderSchema = z.object({ ids: z.array(z.number().int().positive()).max(services.SERVICES_LIMIT) });
const listQuerySchema = z.object({ all: z.enum(['0', '1']).optional() });

type ServiceBody = z.infer<typeof serviceSchema>;

/** Тело API → поля домена: рубли → копейки (сумма предоплаты тоже; процент как есть). */
function fieldsOf(b: ServiceBody): ServiceFields {
  return {
    title: b.title,
    description: b.description ?? null,
    priceKopecks: rublesToKopecks(b.price_rub),
    durationMin: b.duration_min,
    prepaymentKind: b.prepayment.kind,
    prepaymentValue: b.prepayment.kind === 'amount' ? rublesToKopecks(b.prepayment.value) : b.prepayment.value,
    cancelRule: b.cancel_rule,
    template: b.template,
  };
}

export function serviceView(s: SellerService) {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    price_rub: Math.round(s.priceKopecks / 100),
    duration_min: s.durationMin,
    prepayment: { kind: s.prepaymentKind, value: s.prepaymentKind === 'amount' ? Math.round(s.prepaymentValue / 100) : s.prepaymentValue },
    cancel_rule: s.cancelRule,
    template: s.template,
    active: s.active,
    sort_order: s.sortOrder,
  };
}

function serviceError(reply: Parameters<typeof sendError>[0], e: unknown) {
  if (e instanceof ServicesLimitError) return fail(reply, 409, 'services_limit', texts.API_SERVICES_LIMIT);
  if (e instanceof NotFoundError) return fail(reply, 404, 'not_found', texts.API_SERVICE_NOT_FOUND);
  return sendError(reply, e);
}

export function registerServicesApi(app: FastifyInstance): void {
  app.get('/api/services', async (req, reply) => {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'validation', firstIssue(q.error.issues));
    const items = await services.listServices(me(req).maxUserId, q.data.all === '1');
    return { items: items.map(serviceView) };
  });

  app.post('/api/services', async (req, reply) => {
    const parsed = serviceSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'validation', firstIssue(parsed.error.issues));
    try {
      return { service: serviceView(await services.createService(me(req).maxUserId, fieldsOf(parsed.data))) };
    } catch (e) {
      return serviceError(reply, e);
    }
  });

  // Статический путь главнее параметрического: /order не спутается с /:id.
  app.put('/api/services/order', async (req, reply) => {
    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'validation', firstIssue(parsed.error.issues));
    try {
      return { items: (await services.reorderServices(me(req).maxUserId, parsed.data.ids)).map(serviceView) };
    } catch (e) {
      return serviceError(reply, e);
    }
  });

  app.put<{ Params: { id: string } }>('/api/services/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return fail(reply, 404, 'not_found', texts.API_SERVICE_NOT_FOUND);
    const parsed = serviceSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'validation', firstIssue(parsed.error.issues));
    try {
      const updated = await services.updateService(me(req).maxUserId, id, { ...fieldsOf(parsed.data), active: parsed.data.active });
      return { service: serviceView(updated) };
    } catch (e) {
      return serviceError(reply, e);
    }
  });
}
