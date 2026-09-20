// Единственная точка выхода в Bot API MAX. Всё остальное приложение работает только через MaxGateway —
// это же и шов для тестов: в сквозном тесте подставляется поддельный шлюз без сети.
// Контракт методов и ограничения — docs/CONTRACTS.md §1.7 и §1.11, лимиты — §1.2 (2 сообщения/с в один чат, 30 rps).
import { MaxError } from '@maxhub/max-bot-api';
import type { Api } from '@maxhub/max-bot-api';
import type { AttachmentRequest } from '@maxhub/max-bot-api/types';
import { log } from '../../logger.js';

export type { AttachmentRequest };

/** Куда отправлять: диалог (chat_id) предпочтительнее — по нему же считается троттлинг. */
export type Target = { chatId: number } | { userId: number };

export interface MaxGateway {
  /** Возвращает mid отправленного сообщения (нужен, чтобы потом править карточку на месте). */
  send(target: Target, text: string, attachments?: AttachmentRequest[]): Promise<string>;
  /** PUT /messages. false — сообщение не удалось изменить (например, удалено): вызывающий шлёт новое. */
  edit(mid: string, text: string, attachments?: AttachmentRequest[]): Promise<boolean>;
  /** POST /answers — обновляет то же сообщение, на кнопку в котором нажали. */
  answer(callbackId: string, text?: string, attachments?: AttachmentRequest[]): Promise<void>;
  /** Загрузка файла ПУТЁМ (не Buffer): иначе имя файла у получателя станет UUID (CONTRACTS §1.8). */
  uploadFile(path: string): Promise<AttachmentRequest>;
  /** Пересылка уже загруженного в MAX вложения по его token (чек от исполнителя клиенту). */
  attachmentFromToken(type: 'image' | 'file', token: string): AttachmentRequest;
}

const MIN_INTERVAL_MS = 500; // 2 сообщения в секунду на чат (CONTRACTS §1.2)
const MAX_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 1000;

function keyOf(t: Target): string {
  return 'chatId' in t ? `c:${t.chatId}` : `u:${t.userId}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Очередь на каждый чат: сообщения одного чата уходят строго последовательно и не чаще 2/с.
 * Разные чаты не ждут друг друга — это важно для §14 п. 15 (20 сделок × 2 карточки за ≤ 10 с).
 */
class ChatQueue {
  private tails = new Map<string, Promise<unknown>>();
  private lastSentAt = new Map<string, number>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const last = this.lastSentAt.get(key) ?? 0;
      const wait = last + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastSentAt.set(key, Date.now());
      }
    });
    // хвост не должен превращаться в rejected-цепочку, иначе следующее сообщение не отправится
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

/** 429 и 5xx — повторяем; остальное пробрасываем сразу (CONTRACTS §1.11). */
async function withRetry<T>(op: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const retriable = e instanceof MaxError && (e.status === 429 || e.status >= 500);
      if (!retriable || attempt === MAX_ATTEMPTS) break;
      log.warn({ op, attempt, status: (e as MaxError).status, code: (e as MaxError).code }, 'max: повтор запроса');
      await sleep(RETRY_PAUSE_MS * attempt);
    }
  }
  throw lastError;
}

export function createMaxGateway(api: Api): MaxGateway {
  const queue = new ChatQueue();

  return {
    async send(target, text, attachments) {
      const key = keyOf(target);
      return queue.run(key, async () => {
        const message = await withRetry('send', () =>
          'chatId' in target
            ? api.sendMessageToChat(target.chatId, text, { format: 'markdown', attachments })
            : api.sendMessageToUser(target.userId, text, { format: 'markdown', attachments }),
        );
        return message.body.mid;
      });
    },

    async edit(mid, text, attachments) {
      // Правка карточки — тоже сообщение в чат, но chat_id у нас под рукой нет; ключ по mid
      // даёт последовательность правок одной карточки, а лимит 2/с на чат обеспечивают паузы send.
      return queue.run(`m:${mid}`, async () => {
        try {
          const res = await withRetry('edit', () => api.editMessage(mid, { text, attachments, format: 'markdown' }));
          if (res.success) return true;
          log.warn({ mid, reason: res.message }, 'max: сообщение не изменено, нужна новая карточка');
          return false;
        } catch (e) {
          // Сообщение удалено пользователем или недоступно — не ошибка сценария, шлём новое
          if (e instanceof MaxError && (e.status === 400 || e.status === 404)) {
            log.warn({ mid, status: e.status, code: e.code }, 'max: правка отклонена, нужна новая карточка');
            return false;
          }
          throw e;
        }
      });
    },

    async answer(callbackId, text, attachments) {
      await withRetry('answer', () =>
        api.answerOnCallback(callbackId, {
          message: text === undefined ? null : { text, attachments, format: 'markdown' },
        }),
      );
    },

    async uploadFile(path) {
      const file = await withRetry('uploadFile', () => api.uploadFile({ source: path }));
      return file.toJson() as AttachmentRequest;
    },

    attachmentFromToken(type, token) {
      return { type, payload: { token } } as AttachmentRequest;
    },
  };
}
