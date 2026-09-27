// zod-схемы тел запросов мини-приложения (SPEC §7.8). Лишние поля отбрасываются, ошибки → 400 validation.
import { z } from 'zod';
import { isValidDigestTime } from '../../domain/reminder/digest.js';

export const cancelRuleSchema = z.enum(['free_24h', 'free_48h', 'nonrefundable', 'full_refund']);
export const taxModeSchema = z.enum(['npd', 'ip_kkt', 'none']);
export const templateSchema = z.enum(['beauty', 'lesson', 'repair', 'custom_order', 'freelance', 'free']);

export const profileSchema = z.object({
  display_name: z.string().trim().min(2, 'Имя — от 2 до 40 символов').max(40, 'Имя — от 2 до 40 символов'),
  tax_mode: taxModeSchema,
  payout_details: z.string().max(200, 'Реквизиты — до 200 символов').nullish(),
  transfer_enabled: z.boolean().default(true),
  link_enabled: z.boolean().default(true),
  default_cancel_rule: cancelRuleSchema.default('free_24h'),
  // Утренняя сводка: минуты от полуночи по МСК, 06:00–12:00 с шагом 30; null — выключена; нет поля — не менять (ЗАДАЧА_04 B2).
  digest_time: z
    .number()
    .refine(isValidDigestTime, 'Время сводки — с 06:00 до 12:00, шаг 30 минут')
    .nullable()
    .optional(),
});

export const createDealSchema = z.object({
  template: templateSchema,
  title: z.string().trim().min(2, 'Название — от 2 до 80 символов').max(80, 'Название — от 2 до 80 символов'),
  description: z.string().max(1000, 'Уточнения — до 1000 символов').nullish(),
  scheduled_at: z.string().datetime({ offset: true }).nullish(),
  total_rub: z.number().int('Сумма — целое число рублей').min(1, 'Сумма — от 1 до 1 000 000 ₽').max(1_000_000, 'Сумма — от 1 до 1 000 000 ₽'),
  prepayment_rub: z.number().int('Предоплата — целое число рублей').min(0).max(1_000_000),
  cancel_rule: cancelRuleSchema,
  photo_max_token: z.string().nullish(),
  profile: profileSchema.optional(),
});

/** Query для GET /api/deals (SPEC §7.8); отсутствующие параметры — значения по умолчанию. */
export const dealListQuerySchema = z.object({
  role: z.enum(['seller', 'client', 'all']).default('all'),
  filter: z.enum(['active', 'awaiting_payment', 'done', 'all']).default('active'),
});

export const phoneSchema = z.object({
  phone: z.string().min(5).max(20),
  authDate: z.string().min(1),
  hash: z.string().min(16),
});

export type CreateDealBody = z.infer<typeof createDealSchema>;
export type ProfileBody = z.infer<typeof profileSchema>;
