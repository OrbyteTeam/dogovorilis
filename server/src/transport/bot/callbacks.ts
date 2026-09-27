// Разбор и сборка payload callback-кнопок (SPEC §13).
// Формат для действий над сделкой: `<code>[:<sub>]:<publicId>[:<arg>]`.
// Меню-кнопки (`help`, `try`, `menu`, `dm:new`, `ex:new`) публичного id не имеют — регулярное выражение из §13 их не описывает,
// расхождение зафиксировано в docs/ДОПУЩЕНИЯ.md.
import { PUBLIC_ID_RE } from '../../domain/ids.js';

/** Коды действий над сделкой (§13). */
export const DEAL_CODES = [
  'cf', // подтвердить
  'cr', // предложить изменения
  'dc', // отказаться (dc:y — подтверждение)
  'pl', // оплата по ссылке
  'pt', // перевод по реквизитам
  'tr', // tr:c|g|n|x — перевёл / получил / не вижу / отмена рейла
  'pc', // проверить оплату
  'pe', // эмулировать оплату (tbank demo)
  'nl', // новая ссылка
  'dn', // выполнено
  'ac', // принять
  'rm', // замечания
  'fx', // исправлено
  'rc', // приложить чек
  'nc', // закрыть без чека (nc:y — подтверждение)
  'cn', // отменить сделку (cn:y — подтверждение)
  'ka', // оставить как есть
  'rs', // напомнить клиенту
  'dm', // открыть как клиент (демо)
  'op', // открыть карточку
  'pdf', // квитанция
  'rf', // rf:s — исполнитель «Вернул(а)», rf:c — клиент «Возврат получил(а)» (SPEC §5.3)
] as const;

export type DealCode = (typeof DEAL_CODES)[number];

export type ParsedCallback =
  | { kind: 'help' }
  | { kind: 'try' }
  | { kind: 'menu' }
  | { kind: 'demo_new' }
  | { kind: 'example_new' }
  | { kind: 'deal'; code: DealCode; sub: string | null; publicId: string; arg: string | null };

const SUBS = new Set(['y', 'c', 'g', 'n', 'x', 's']);

export function parseCallback(payload: string | undefined | null): ParsedCallback | null {
  if (!payload) return null;
  const parts = payload.trim().split(':');
  const code = parts[0];
  if (code === 'help') return { kind: 'help' };
  if (code === 'try' && parts.length === 1) return { kind: 'try' };
  if (code === 'menu' && parts.length === 1) return { kind: 'menu' };
  if (code === 'dm' && parts[1] === 'new') return { kind: 'demo_new' };
  if (code === 'ex' && parts[1] === 'new') return { kind: 'example_new' };
  if (!(DEAL_CODES as readonly string[]).includes(code)) return null;

  let rest = parts.slice(1);
  let sub: string | null = null;
  if (rest.length && rest[0].length === 1 && SUBS.has(rest[0])) {
    sub = rest[0];
    rest = rest.slice(1);
  }
  const publicId = rest[0];
  if (!publicId || !PUBLIC_ID_RE.test(publicId)) return null;
  return { kind: 'deal', code: code as DealCode, sub, publicId, arg: rest[1] ?? null };
}

export function cb(code: DealCode, publicId: string, sub?: string, arg?: string | number): string {
  return [code, sub, publicId, arg].filter((p) => p !== undefined && p !== null).join(':');
}
