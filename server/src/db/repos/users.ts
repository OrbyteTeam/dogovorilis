// Таблицы users и seller_profiles (SPEC §8). Единственное место, где живёт snake_case этих таблиц.
import type { Queryable } from '../pool.js';
import type { CancelRule, SellerProfile, TaxMode, User } from '../../types.js';

const USER_COLS =
  'max_user_id, first_name, last_name, username, dialog_chat_id, locale, phone, phone_verified_at';

const PROFILE_COLS =
  'user_id, display_name, tax_mode, payout_details, transfer_enabled, link_enabled, default_cancel_rule, digest_time, show_reliability';

/** Время сводки по умолчанию — 08:00 МСК (DEFAULT в 0005_digest_and_soon.sql). */
export const DEFAULT_DIGEST_TIME = 480;

type UserRow = {
  max_user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  dialog_chat_id: number | null;
  locale: string | null;
  phone: string | null;
  phone_verified_at: Date | null;
};

type ProfileRow = {
  user_id: number;
  display_name: string;
  tax_mode: TaxMode;
  payout_details: string | null;
  transfer_enabled: boolean;
  link_enabled: boolean;
  default_cancel_rule: CancelRule;
  digest_time: number | null;
  show_reliability: boolean;
};

function mapUser(r: UserRow): User {
  return {
    maxUserId: r.max_user_id,
    firstName: r.first_name,
    lastName: r.last_name,
    username: r.username,
    dialogChatId: r.dialog_chat_id,
    locale: r.locale,
    phone: r.phone,
    phoneVerifiedAt: r.phone_verified_at,
  };
}

function mapProfile(r: ProfileRow): SellerProfile {
  return {
    userId: r.user_id,
    displayName: r.display_name,
    taxMode: r.tax_mode,
    payoutDetails: r.payout_details,
    transferEnabled: r.transfer_enabled,
    linkEnabled: r.link_enabled,
    defaultCancelRule: r.default_cancel_rule,
    digestTime: r.digest_time,
    showReliability: r.show_reliability,
  };
}

/**
 * Создать или обновить пользователя по данным MAX.
 * Не затирает dialog_chat_id, phone и phone_verified_at — они приходят по другим путям
 * (bot_started и проверенный HMAC телефона).
 */
export async function upsertFromMax(
  q: Queryable,
  u: {
    maxUserId: number;
    firstName: string;
    lastName?: string | null;
    username?: string | null;
    locale?: string | null;
  },
): Promise<User> {
  const res = await q.query<UserRow>(
    `INSERT INTO users (max_user_id, first_name, last_name, username, locale)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (max_user_id) DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name  = COALESCE(EXCLUDED.last_name, users.last_name),
       username   = COALESCE(EXCLUDED.username, users.username),
       locale     = COALESCE(EXCLUDED.locale, users.locale),
       updated_at = now()
     RETURNING ${USER_COLS}`,
    [u.maxUserId, u.firstName, u.lastName ?? null, u.username ?? null, u.locale ?? null],
  );
  return mapUser(res.rows[0]!);
}

/** chat_id диалога с ботом; null — при dialog_removed / bot_stopped (SPEC §8). */
export async function setDialogChatId(q: Queryable, maxUserId: number, chatId: number | null): Promise<void> {
  await q.query(`UPDATE users SET dialog_chat_id = $2, updated_at = now() WHERE max_user_id = $1`, [
    maxUserId,
    chatId,
  ]);
}

export async function byId(q: Queryable, maxUserId: number): Promise<User | null> {
  const res = await q.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE max_user_id = $1`, [maxUserId]);
  return res.rows[0] ? mapUser(res.rows[0]) : null;
}

export async function byIds(q: Queryable, ids: number[]): Promise<Map<number, User>> {
  const out = new Map<number, User>();
  if (ids.length === 0) return out;
  const res = await q.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE max_user_id = ANY($1::bigint[])`, [ids]);
  for (const r of res.rows) out.set(r.max_user_id, mapUser(r));
  return out;
}

/** Телефон записывается только после проверки HMAC (SPEC §9.4). */
export async function setVerifiedPhone(q: Queryable, maxUserId: number, phone: string, at: Date): Promise<void> {
  await q.query(
    `UPDATE users SET phone = $2, phone_verified_at = $3, updated_at = now() WHERE max_user_id = $1`,
    [maxUserId, phone, at],
  );
}

export async function getProfile(q: Queryable, userId: number): Promise<SellerProfile | null> {
  const res = await q.query<ProfileRow>(`SELECT ${PROFILE_COLS} FROM seller_profiles WHERE user_id = $1`, [userId]);
  return res.rows[0] ? mapProfile(res.rows[0]) : null;
}

/**
 * Создать или обновить профиль. `digestTime`: undefined — не трогать (у нового профиля — 08:00),
 * null — сводка выключена, число — минуты от полуночи по МСК. Так старый клиент мини-приложения,
 * который поля не знает, не выключает сводку молча.
 */
export async function upsertProfile(
  q: Queryable,
  p: {
    userId: number;
    displayName: string;
    taxMode: TaxMode;
    payoutDetails?: string | null;
    transferEnabled: boolean;
    linkEnabled: boolean;
    defaultCancelRule: CancelRule;
    digestTime?: number | null;
    /** Строка надёжности клиентам (ЗАДАЧА_08 E): undefined — не трогать (у нового профиля — выключено). */
    showReliability?: boolean;
  },
): Promise<SellerProfile> {
  const setDigest = p.digestTime !== undefined;
  const setReliability = p.showReliability !== undefined;
  const res = await q.query<ProfileRow>(
    `INSERT INTO seller_profiles
       (user_id, display_name, tax_mode, payout_details, transfer_enabled, link_enabled, default_cancel_rule, digest_time, show_reliability)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::boolean THEN $9::smallint ELSE $10::smallint END, COALESCE($12::boolean, false))
     ON CONFLICT (user_id) DO UPDATE SET
       display_name        = EXCLUDED.display_name,
       tax_mode            = EXCLUDED.tax_mode,
       payout_details      = EXCLUDED.payout_details,
       transfer_enabled    = EXCLUDED.transfer_enabled,
       link_enabled        = EXCLUDED.link_enabled,
       default_cancel_rule = EXCLUDED.default_cancel_rule,
       digest_time         = CASE WHEN $8::boolean THEN EXCLUDED.digest_time ELSE seller_profiles.digest_time END,
       show_reliability    = CASE WHEN $11::boolean THEN EXCLUDED.show_reliability ELSE seller_profiles.show_reliability END,
       updated_at          = now()
     RETURNING ${PROFILE_COLS}`,
    [
      p.userId,
      p.displayName,
      p.taxMode,
      p.payoutDetails ?? null,
      p.transferEnabled,
      p.linkEnabled,
      p.defaultCancelRule,
      setDigest,
      setDigest ? p.digestTime : null,
      DEFAULT_DIGEST_TIME,
      setReliability,
      setReliability ? p.showReliability : null,
    ],
  );
  return mapProfile(res.rows[0]!);
}
