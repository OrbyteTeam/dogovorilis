// Поддельный MAX Bot API: подменяем `clientOptions.fetch` у SDK и поднимаем локальный сервер под загрузку файлов.
// Так сквозной тест идёт по НАСТОЯЩЕЙ цепочке: наши обработчики → gateway → SDK → HTTP-запрос,
// и мы проверяем то, что реально ушло бы в сеть (CONTRACTS §1.2, §1.7, §1.8).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type SentMessage = {
  kind: 'send' | 'edit' | 'answer';
  chatId?: number;
  userId?: number;
  mid?: string;
  callbackId?: string;
  text: string;
  buttons: { type: string; text: string; payload?: string; url?: string }[];
  attachmentTypes: string[];
};

export type MaxFake = {
  fetch: typeof globalThis.fetch;
  sent: SentMessage[];
  /** сообщения, отправленные в конкретный чат */
  inChat(chatId: number): SentMessage[];
  /** последнее сообщение с заданным mid (после правки текст обновляется) */
  byMid(mid: string): SentMessage | undefined;
  /** текст всех сообщений — для быстрых проверок «пришло ли N8» */
  texts(): string[];
  uploads: number;
  reset(): void;
  close(): Promise<void>;
};

const BOT_INFO = {
  user_id: 409922712,
  first_name: 'Хакатон МАХ 713',
  is_bot: true,
  username: 't713_hakaton_max_bot',
  last_activity_time: Date.now(),
  name: 'Хакатон МАХ 713',
};

export async function createMaxFake(): Promise<MaxFake> {
  const sent: SentMessage[] = [];
  const byMidMap = new Map<string, SentMessage>();
  let midCounter = 0;
  let uploads = 0;

  // Загрузка файла идёт мимо clientOptions.fetch (отдельный транспорт https.request),
  // поэтому под неё нужен настоящий http-сервер (CONTRACTS §1.8).
  const uploadServer: Server = createServer((req, res) => {
    uploads += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: `upload-token-${uploads}` }));
    });
  });
  await new Promise<void>((resolve) => uploadServer.listen(0, '127.0.0.1', resolve));
  const uploadPort = (uploadServer.address() as AddressInfo).port;

  function extract(body: Record<string, unknown> | undefined): Pick<SentMessage, 'text' | 'buttons' | 'attachmentTypes'> {
    const attachments = (body?.attachments as { type: string; payload?: { buttons?: unknown[][] } }[] | undefined) ?? [];
    const buttons: SentMessage['buttons'] = [];
    for (const a of attachments) {
      if (a.type === 'inline_keyboard') {
        for (const row of a.payload?.buttons ?? []) for (const b of row as SentMessage['buttons']) buttons.push(b);
      }
    }
    return {
      text: String(body?.text ?? ''),
      buttons,
      attachmentTypes: attachments.map((a) => a.type),
    };
  }

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

    if (url.pathname === '/me' && method === 'GET') return json(BOT_INFO);
    if (url.pathname === '/me/commands') return json({ commands: body?.commands ?? [] });
    if (url.pathname === '/subscriptions') return json(method === 'GET' ? [] : { success: true });

    if (url.pathname === '/messages' && method === 'POST') {
      const mid = `mid-${++midCounter}`;
      const chatId = url.searchParams.get('chat_id');
      const userId = url.searchParams.get('user_id');
      const message: SentMessage = {
        kind: 'send',
        chatId: chatId ? Number(chatId) : undefined,
        userId: userId ? Number(userId) : undefined,
        mid,
        ...extract(body),
      };
      sent.push(message);
      byMidMap.set(mid, message);
      return json({ message: { sender: null, recipient: { chat_id: Number(chatId ?? 0), chat_type: 'DIALOG', user_id: Number(userId ?? 0), post_id: null }, timestamp: Date.now(), body: { mid, seq: midCounter, text: String(body?.text ?? ''), attachments: body?.attachments ?? null } } });
    }

    if (url.pathname === '/messages' && method === 'PUT') {
      const mid = url.searchParams.get('message_id') ?? '';
      const existing = byMidMap.get(mid);
      // Правка сообщения, которого нет (пользователь его удалил), возвращает success:false —
      // именно так это выглядит со стороны MAX (CONTRACTS §1.7, SPEC §14 п. 4).
      if (!existing) return json({ success: false, message: 'message not found' });
      const updated: SentMessage = { kind: 'edit', mid, chatId: existing.chatId, userId: existing.userId, ...extract(body) };
      sent.push(updated);
      byMidMap.set(mid, { ...existing, ...extract(body) });
      return json({ success: true });
    }

    if (url.pathname === '/answers' && method === 'POST') {
      const callbackId = url.searchParams.get('callback_id') ?? '';
      const inner = (body?.message ?? undefined) as Record<string, unknown> | undefined;
      sent.push({ kind: 'answer', callbackId, ...extract(inner) });
      return json({ success: true });
    }

    if (url.pathname === '/uploads' && method === 'POST') {
      return json({ url: `http://127.0.0.1:${uploadPort}/upload`, token: `upload-token-${uploads + 1}` });
    }

    if (url.pathname === '/updates') return json({ updates: [], marker: 1 });

    return new Response(JSON.stringify({ code: 'not.found', message: `поддельный MAX не знает ${method} ${url.pathname}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    fetch: fetchImpl,
    sent,
    inChat: (chatId) => sent.filter((m) => m.chatId === chatId),
    byMid: (mid) => byMidMap.get(mid),
    texts: () => sent.map((m) => m.text),
    get uploads() {
      return uploads;
    },
    reset: () => {
      sent.length = 0;
    },
    close: () => new Promise<void>((resolve) => uploadServer.close(() => resolve())),
  };
}

export { BOT_INFO };
