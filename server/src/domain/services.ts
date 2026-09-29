// «Мои услуги» исполнителя (ЗАДАЧА_08 C, SPEC §7.6a): проверка полей, лимит, порядок, привязка к сделке.
// Услуга — не витрина: клиент её не видит, она только заполняет форму исполнителя. Удаления нет — скрытие.
import { inTx } from '../db/pool.js';
import * as servicesRepo from '../db/repos/services.js';
import type { ServiceFields } from '../db/repos/services.js';
import { AppError, NotFoundError, ValidationError } from '../errors.js';
import type { SellerService } from '../types.js';
import { MAX_TOTAL_KOPECKS, MIN_TOTAL_KOPECKS, percentOfTotal } from './money.js';

export const SERVICES_LIMIT = 50;
export const DEFAULT_DURATION_MIN = 60;
export const DURATION_STEP_MIN = 15;
export const DURATION_MAX_MIN = 720;

/** Больше SERVICES_LIMIT услуг у исполнителя → 409 services_limit. */
export class ServicesLimitError extends AppError {
  constructor() {
    super('services_limit', `не больше ${SERVICES_LIMIT} услуг`);
    this.name = 'ServicesLimitError';
  }
}

/** Проверка полей услуги по SPEC §7.6a; текст ошибки — для поля формы. Возвращает нормализованные поля. */
export function validateService(f: ServiceFields): ServiceFields {
  const title = f.title.trim();
  if (title.length < 2 || title.length > 80) throw new ValidationError('Название от 2 до 80 символов', 'title');
  const description = f.description?.trim() ? f.description.trim() : null;
  if (description && description.length > 1000) throw new ValidationError('Уточнения до 1000 символов', 'description');
  if (!Number.isInteger(f.priceKopecks) || f.priceKopecks < MIN_TOTAL_KOPECKS || f.priceKopecks > MAX_TOTAL_KOPECKS) {
    throw new ValidationError('Сумма от 1 до 1 000 000 ₽', 'price_rub');
  }
  if (!Number.isInteger(f.durationMin) || f.durationMin < DURATION_STEP_MIN || f.durationMin > DURATION_MAX_MIN || f.durationMin % DURATION_STEP_MIN !== 0) {
    throw new ValidationError('Длительность от 15 минут до 12 часов, шаг 15 минут', 'duration_min');
  }
  const v = f.prepaymentValue;
  const prepaymentOk =
    (f.prepaymentKind === 'none' && v === 0) ||
    (f.prepaymentKind === 'percent' && Number.isInteger(v) && v >= 1 && v <= 100) ||
    (f.prepaymentKind === 'amount' && Number.isInteger(v) && v >= MIN_TOTAL_KOPECKS && v <= f.priceKopecks);
  if (!prepaymentOk) throw new ValidationError('Предоплата: процент от 1 до 100 или сумма не больше цены', 'prepayment');
  return { ...f, title, description };
}

/** Предоплата в копейках для сделки на полную цену услуги: процент — с округлением до рубля вверх (SPEC §7.2). */
export function servicePrepaymentKopecks(s: Pick<SellerService, 'prepaymentKind' | 'prepaymentValue' | 'priceKopecks'>): number {
  if (s.prepaymentKind === 'percent') return Math.min(percentOfTotal(s.priceKopecks, s.prepaymentValue), s.priceKopecks);
  if (s.prepaymentKind === 'amount') return s.prepaymentValue;
  return 0;
}

export function listServices(sellerUserId: number, includeHidden: boolean): Promise<SellerService[]> {
  return inTx((c) => servicesRepo.listBySeller(c, sellerUserId, { includeHidden }));
}

export function createService(sellerUserId: number, fields: ServiceFields): Promise<SellerService> {
  const f = validateService(fields);
  return inTx(async (c) => {
    await servicesRepo.lockSeller(c, sellerUserId); // две вкладки одновременно не обойдут лимит
    if ((await servicesRepo.countBySeller(c, sellerUserId)) >= SERVICES_LIMIT) throw new ServicesLimitError();
    return servicesRepo.create(c, sellerUserId, f);
  });
}

/** Правка своей услуги; `active` не передан — остаётся прежним. Чужая или нет такой — NotFound (id не подтверждаем). */
export function updateService(sellerUserId: number, id: number, fields: ServiceFields & { active?: boolean }): Promise<SellerService> {
  const f = validateService(fields);
  return inTx(async (c) => {
    const current = await servicesRepo.byIdForSeller(c, id, sellerUserId, true);
    if (!current) throw new NotFoundError(`услуга ${id}`);
    const updated = await servicesRepo.update(c, id, sellerUserId, { ...f, active: fields.active ?? current.active });
    if (!updated) throw new NotFoundError(`услуга ${id}`);
    return updated;
  });
}

/** Новый порядок — ровно все свои услуги, каждая один раз; иначе 400 (ничего не меняем). */
export function reorderServices(sellerUserId: number, ids: number[]): Promise<SellerService[]> {
  return inTx(async (c) => {
    await servicesRepo.lockSeller(c, sellerUserId);
    const own = await servicesRepo.listBySeller(c, sellerUserId, { includeHidden: true });
    const ownIds = new Set(own.map((s) => s.id));
    const unique = new Set(ids);
    if (unique.size !== ids.length || ids.length !== ownIds.size || ids.some((id) => !ownIds.has(id))) {
      throw new ValidationError('Порядок: нужен полный список ваших услуг без повторов', 'ids');
    }
    await servicesRepo.reorder(c, sellerUserId, ids);
    return servicesRepo.listBySeller(c, sellerUserId, { includeHidden: true });
  });
}

/** Услуга для сделки: только своя (в т. ч. скрытая — «Повторить» берёт услугу прежней сделки). */
export async function serviceForDeal(sellerUserId: number, id: number): Promise<SellerService> {
  const s = await inTx((c) => servicesRepo.byIdForSeller(c, id, sellerUserId));
  if (!s) throw new NotFoundError(`услуга ${id}`);
  return s;
}
