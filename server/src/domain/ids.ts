// Идентификаторы. public_id — 10 символов [A-Za-z0-9] (SPEC §8, §13: ^d_[A-Za-z0-9]{10}$),
// непрозрачный и неугадываемый: ссылка на сделку — это и есть право доступа клиента.
import { customAlphabet } from 'nanoid';
import { randomUUID } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const PUBLIC_ID_LENGTH = 10;
export const PUBLIC_ID_RE = /^[A-Za-z0-9]{10}$/;
export const DEEPLINK_PAYLOAD_RE = /^d_([A-Za-z0-9]{10})$/;

const nano = customAlphabet(ALPHABET, PUBLIC_ID_LENGTH);

export function newPublicId(): string {
  return nano();
}

/** Idempotence-Key ЮKassa / OrderId Т-Банка (≤ 36 символов — UUID подходит). */
export function newIdempotenceKey(): string {
  return randomUUID();
}

/** Разбор payload диплинка: 'd_AbC123xyZ0' → 'AbC123xyZ0'; всё иное → null (SPEC §13). */
export function parseDealPayload(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const m = DEEPLINK_PAYLOAD_RE.exec(payload.trim());
  return m ? m[1] : null;
}
