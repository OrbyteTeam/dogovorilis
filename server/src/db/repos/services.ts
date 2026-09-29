// Таблица seller_services — «Мои услуги» исполнителя (ЗАДАЧА_08 C, SPEC §7.6a, миграция 0006).
// Каждый запрос ограничен исполнителем: чужую услугу нельзя ни прочитать, ни изменить — она просто «не найдена».
import type { Queryable } from '../pool.js';
import type { CancelRule, PrepaymentKind, SellerService, TemplateKey } from '../../types.js';

const COLS = `id, seller_user_id, title, description, price_kopecks, duration_min, prepayment_kind, prepayment_value,
  cancel_rule, template, sort_order, active, created_at, updated_at`;

type ServiceRow = {
  id: string | number;
  seller_user_id: string | number;
  title: string;
  description: string | null;
  price_kopecks: string | number;
  duration_min: number;
  prepayment_kind: PrepaymentKind;
  prepayment_value: string | number;
  cancel_rule: CancelRule;
  template: TemplateKey;
  sort_order: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

function mapService(r: ServiceRow): SellerService {
  return {
    id: Number(r.id),
    sellerUserId: Number(r.seller_user_id),
    title: r.title,
    description: r.description,
    priceKopecks: Number(r.price_kopecks),
    durationMin: r.duration_min,
    prepaymentKind: r.prepayment_kind,
    prepaymentValue: Number(r.prepayment_value),
    cancelRule: r.cancel_rule,
    template: r.template,
    sortOrder: r.sort_order,
    active: r.active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Поля услуги, которые задаёт исполнитель. */
export type ServiceFields = Pick<
  SellerService,
  'title' | 'description' | 'priceKopecks' | 'durationMin' | 'prepaymentKind' | 'prepaymentValue' | 'cancelRule' | 'template'
>;

export async function listBySeller(q: Queryable, sellerUserId: number, a: { includeHidden: boolean }): Promise<SellerService[]> {
  const res = await q.query<ServiceRow>(
    `SELECT ${COLS} FROM seller_services
     WHERE seller_user_id = $1 ${a.includeHidden ? '' : 'AND active'}
     ORDER BY sort_order, id`,
    [sellerUserId],
  );
  return res.rows.map(mapService);
}

export async function countBySeller(q: Queryable, sellerUserId: number): Promise<number> {
  const res = await q.query<{ n: string }>('SELECT count(*) AS n FROM seller_services WHERE seller_user_id = $1', [sellerUserId]);
  return Number(res.rows[0]?.n ?? 0);
}

/** Своя услуга по id; чужая или несуществующая — null. `lock` — под FOR UPDATE (правка). */
export async function byIdForSeller(q: Queryable, id: number, sellerUserId: number, lock = false): Promise<SellerService | null> {
  const res = await q.query<ServiceRow>(
    `SELECT ${COLS} FROM seller_services WHERE id = $1 AND seller_user_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [id, sellerUserId],
  );
  return res.rows[0] ? mapService(res.rows[0]) : null;
}

/** Новая услуга встаёт в конец списка. */
export async function create(q: Queryable, sellerUserId: number, f: ServiceFields): Promise<SellerService> {
  const res = await q.query<ServiceRow>(
    `INSERT INTO seller_services
       (seller_user_id, title, description, price_kopecks, duration_min, prepayment_kind, prepayment_value, cancel_rule, template, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
       COALESCE((SELECT max(sort_order) + 1 FROM seller_services WHERE seller_user_id = $1), 0))
     RETURNING ${COLS}`,
    [sellerUserId, f.title, f.description, f.priceKopecks, f.durationMin, f.prepaymentKind, f.prepaymentValue, f.cancelRule, f.template],
  );
  return mapService(res.rows[0]!);
}

export async function update(
  q: Queryable,
  id: number,
  sellerUserId: number,
  f: ServiceFields & { active: boolean },
): Promise<SellerService | null> {
  const res = await q.query<ServiceRow>(
    `UPDATE seller_services
     SET title = $3, description = $4, price_kopecks = $5, duration_min = $6, prepayment_kind = $7,
         prepayment_value = $8, cancel_rule = $9, template = $10, active = $11, updated_at = now()
     WHERE id = $1 AND seller_user_id = $2
     RETURNING ${COLS}`,
    [id, sellerUserId, f.title, f.description, f.priceKopecks, f.durationMin, f.prepaymentKind, f.prepaymentValue, f.cancelRule, f.template, f.active],
  );
  return res.rows[0] ? mapService(res.rows[0]) : null;
}

/** Новый порядок: позиция в массиве становится sort_order. Проверку «все и только свои» делает домен. */
export async function reorder(q: Queryable, sellerUserId: number, ids: number[]): Promise<void> {
  await q.query(
    `UPDATE seller_services s SET sort_order = o.pos - 1, updated_at = now()
     FROM unnest($2::bigint[]) WITH ORDINALITY AS o(id, pos)
     WHERE s.id = o.id AND s.seller_user_id = $1`,
    [sellerUserId, ids],
  );
}

/** Сериализация изменений списка услуг одного исполнителя (лимит 50, порядок): блокировка его профиля пользователя. */
export async function lockSeller(q: Queryable, sellerUserId: number): Promise<void> {
  await q.query('SELECT 1 FROM users WHERE max_user_id = $1 FOR UPDATE', [sellerUserId]);
}
