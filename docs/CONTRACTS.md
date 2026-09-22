# CONTRACTS.md — исполнимая спецификация контрактов внешних API

Дата проверки: 2026-09-20. Код пишется **строго** по этому файлу.

Правила чтения:
- Каждое утверждение помечено источником: **[SDK-типы]** — файл `.d.ts` из tarball `@maxhub/max-bot-api@0.3.1` (скачан с registry.npmjs.org, прочитан целиком); **[SDK-код]** — соответствующий `.js` из того же tarball; **[док]** — страница официальной документации с URL; **[SDK-docs]** — `docs/*.md` из официального репозитория `max-messenger/max-bot-api-client-ts`.
- Если чего-то нет в документации/типах — написано **«не описано»**. Догадки в этом файле отсутствуют; всё, что не удалось открыть, вынесено в конец каждого раздела в «Не удалось проверить».
- Цитаты на русском из документации приведены в кавычках «…» дословно.

---

## 1. MAX Bot API через официальный TS SDK `@maxhub/max-bot-api` 0.3.1

### 1.1. Пакет

Источник: `package.json` из tarball (https://cdn.jsdelivr.net/npm/@maxhub/max-bot-api@0.3.1/package.json).

| Поле | Значение |
|---|---|
| name / version | `@maxhub/max-bot-api` / `0.3.1` |
| description | «Max Bot Framework» |
| main / types | `./dist/index.js` / `./dist/index.d.ts` |
| exports | `.` (dist) и `./types` |
| dependencies | `debug ^4.4.3`, `form-data ^4.0.6`, `vcf ^2.1.2` |
| engines | `node >=20.19.0` |
| repository | https://github.com/max-messenger/max-bot-api-client-ts |
| license | MIT |
| Сборка | CommonJS (`"use strict"; Object.defineProperty(exports, "__esModule"…)`), `import` работает через interop [SDK-код] |

Публичные экспорты `dist/index.d.ts` [SDK-типы] (дословно):

```ts
export { Api } from './api';
export { Bot } from './bot';
export { Webhook, type WebhookOptions } from './core/network/webhook';
export { Composer } from './core/composer';
export { Context } from './core/context';
export { allOf, anyOf, createdMessageBodyHas, messageCallback, messageEdited, } from './core/composer/modules/filters';
export type { AsyncPredicate, DispatchResult, Predicate, TriggerFn, Triggers, } from './core/composer';
export type { FilteredContext } from './core/context';
export type { Middleware, MiddlewareFn, MiddlewareList, MiddlewareObj, NextFn, } from './core/middleware';
export { MemorySessionStore, session } from './session';
export type { AsyncSessionStore, SessionContext, SessionOptions, SessionStore, SyncSessionStore, } from './session';
export { ScenarioEngine, defineScenario, transition } from './scenario';
export type { ScenarioContext, ScenarioController, ScenarioDefinition, ScenarioEngineOptions, ScenarioSession, ScenarioState, ScenarioStep, ScenarioStepInput, ScenarioTransition, } from './scenario';
export { AudioAttachment, FileAttachment, ImageAttachment, Keyboard, LocationAttachment, ShareAttachment, StickerAttachment, VideoAttachment, fmt, } from './helpers';
export { MaxError } from './core/network/api';
export type { ClientOptions, FetchFn } from './core/network/api';
```

Changelog 0.3.1 (2026-09-03) [док https://raw.githubusercontent.com/max-messenger/max-bot-api-client-ts/main/CHANGELOG.md]: «Добавлена возможность передачи кастомной fetch-функции в api client»; «задокументированы ограничения clientOptions.fetch». 0.3.0 (2026-08-31): «Add comments API», «add sessions, conversations, and advanced middleware utilities», «добавление кнопки для запуска мини-приложения через inlineKeyboard», «конечный retry с backoff и AbortSignal для attachment.not.ready», «simplify Composer structure and keyboard helper».

### 1.2. HTTP-транспорт SDK (что реально уходит в сеть)

Источник: `dist/core/network/api/client.js`, `client.d.ts` [SDK-код/типы]; https://dev.max.ru/docs-api [док].

- Базовый URL по умолчанию: `https://platform-api2.max.ru` [SDK-код: `defaultOptions.baseUrl`]. Документация: «Для корректной работы ваших чат-ботов и мини-приложений направляйте запросы на домен `platform-api2.max.ru` вместо `platform-api.max.ru`. Также убедитесь, что добавили сертификат Минцифры в список доверенных» [док https://dev.max.ru/docs-api]. «С **19 июля 2026** для корректной работы чат-ботов и мини-приложений необходимо направлять запросы на домен `platform-api2.max.ru`» [док https://dev.max.ru/docs-api/changelog-api].
- Авторизация: заголовок `Authorization: <token>` — токен **без** префикса `Bearer` [SDK-код: `init.headers = { ...init.headers, Authorization: token }`]. Документация: «Authorization: <token>», передача токена в query больше не поддерживается [док https://dev.max.ru/docs-api].
- Тело JSON, `content-type: application/json` [SDK-код]. Query-параметры со значением `false`/`0`/`''`/`null`/`undefined` **не отправляются** (`if (!value) return;`) [SDK-код] — следствие: `notify: false` работает только в body (там оно есть), а `disable_link_preview: false` в query не уйдёт.
- Пустой токен → SDK не делает запрос и возвращает `{status: 401, data: {code: 'verify.token', message: 'Empty access_token'}}`; HTTP 401 от сервера → `{code: 'verify.token', message: 'Invalid access_token'}`; не-JSON ответ → `{code: 'unexpected.response', message: 'Failed to parse JSON. Content-Type was "…"'}` [SDK-код].
- Любой `status !== 200` → `throw new MaxError(status, data)` [SDK-код `base-api.js`].
- `ClientOptions` [SDK-типы, дословно]:

```ts
export type FetchFn = typeof globalThis.fetch;
export type ClientOptions = {
    baseUrl?: string;
    /** Custom fetch implementation used by the Bot API client.
     *  Applies only to Bot API requests, such as `/me`, `/updates`, `/messages`, and the request that obtains an upload URL via `/uploads`.
     *  Does not affect the subsequent file content upload to the returned upload URL, which is performed by `StreamUploadClient` using a separate `http`/`https.request`-based transport. */
    fetch?: FetchFn;
};
```

- Опция **timeout для HTTP-запросов** в `ClientOptions` — **отсутствует** [SDK-типы]. Есть только `signal?: AbortSignal` в `ReqOptions`/`SendMessageExtra`/`getUpdates` и `timeout` (мс) у загрузки файлов (по умолчанию 20000) [SDK-код `upload.js`].
- Лимиты платформы [док https://dev.max.ru/docs-api]: «не более 30 rps» к `platform-api2.max.ru`; «Максимум 2 сообщения в секунду» в один диалог/чат/канал [док https://dev.max.ru/docs-api/methods/POST/messages]; текст ≤ 4000 символов; вложений ≤ 12 (пример: «6 видео, 5 изображений, 1 клавиатура»); клавиатура ≤ 210 кнопок, ≤ 30 рядов, ≤ 7 кнопок в ряду (≤ 3 для `link`, `open_app`, `request_geo_location`, `request_contact`); команд ≤ 32.
- HTTP-коды ошибок, перечисленные в документации [док https://dev.max.ru/docs-api]: 200, 400, 401, 404, 405, 429, 503. Формат тела ошибки на docs-api не задокументирован отдельно; единственный документированный пример (в POST /uploads): `{"code": "attachment.not.ready", "message": "Key: errors.process.attachment.file.not.processed"}` — т.е. `{code: string, message: string}`, что совпадает с `ErrorResponse` SDK [SDK-типы].

### 1.3. Класс `Bot`

Источник: `dist/bot.d.ts`, `dist/bot.js` [SDK-типы/код].

```ts
type BotConfig<Ctx extends Context> = {
    clientOptions?: ClientOptions;
    contextType: new (...args: ConstructorParameters<typeof Context>) => Ctx;
};
type PollingLaunchOptions = Partial<{ allowedUpdates: UpdateType[]; retry: boolean; }>;
type WebhookLaunchOptions = WebhookOptions & { allowedUpdates?: UpdateType[]; };
type StartPollingConfig = { mode: 'polling'; options?: PollingLaunchOptions; };
type StartWebhookConfig = { mode: 'webhook'; options: WebhookLaunchOptions; };
type StartConfig = StartPollingConfig | StartWebhookConfig;

export declare class Bot<Ctx extends Context = Context> extends Composer<Ctx> {
    api: Api;
    botInfo?: BotInfo;
    constructor(token: string, config?: Partial<BotConfig<Ctx>>);
    catch(handler: (err: unknown, ctx: Ctx) => MaybePromise<void>): this;
    start: (config?: StartConfig) => Promise<void>;
    startPolling: (options?: PollingLaunchOptions) => Promise<void>;
    webhookCallback(options: WebhookLaunchOptions): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;
    createWebhook: (options: WebhookLaunchOptions) => Promise<(req: IncomingMessage, res: ServerResponse) => void>;
    startWebhook: (options: WebhookLaunchOptions) => Promise<void>;
    /** @deprecated Используйте stopPolling. В ближайших версиях будет удалено. */
    stop: () => void;
    stopPolling: () => void;
    stopWebhook: () => Promise<void>;
}
```

`WebhookOptions` [SDK-типы `core/network/webhook.d.ts`]:

```ts
export type WebhookOptions = { domain: string; port?: number; path?: string; secret?: string; };
```

Поведение (из `bot.js`, `polling.js`, `webhook.js`) [SDK-код]:

| Действие | Что делает SDK |
|---|---|
| `new Bot(token, {clientOptions, contextType})` | `this.api = new Api(createClient(token, clientOptions))`. `contextType` по умолчанию `Context`. |
| `bot.start()` без аргумента | эквивалент `start({mode:'polling'})`. Сначала `botInfo = await api.getMyInfo()` (`GET /me`; при ошибке — `console.error('Failed to fetch bot info on startup')` и `throw`). Затем **`Webhook.clearSubscriptions(api)` — удаляет ВСЕ webhook-подписки бота** (`GET /subscriptions` → `DELETE /subscriptions?url=` для каждой). Потом `startPolling(options)`. |
| `bot.start({mode:'webhook', options})` | `getMyInfo()`, затем `startWebhook(options)`. |
| `startPolling({allowedUpdates, retry})` | Цикл `GET /updates?marker=…&types=a,b` (см. 1.7). Ошибка `MaxError` со `status === 429 || status >= 500` или `TypeError` (сетевая) → повтор с задержкой 5000 мс, удваивается до 60000 мс. Любая другая ошибка → выход из цикла, `console.error('Unhandled error while polling')`, и если `options.retry !== false` — перезапуск polling через 5000 мс. Polling и webhook одновременно не запускаются (guard-флаги). |
| `startWebhook({domain, port=3000, path, secret, allowedUpdates})` | Поднимает **собственный** `node:http` сервер `createServer(...)` на `port`, регистрирует подписку `POST /subscriptions` c `url = https://<host(domain)><path>` (`path` по умолчанию `/webhook/<sha256(token).hex>`), `secret`, `update_types = allowedUpdates`. Затем удаляет остальные подписки (кроме своего url). При ошибке регистрации — останавливает сервер и `throw`. |
| `webhookCallback(options)` | **Не подписывает** бота и не поднимает сервер; возвращает обработчик `(req, res)` для встраивания в свой http-сервер/фреймворк. Подписку нужно сделать самому: `bot.api.subscribe(url, secret, types)`. |
| `createWebhook(options)` | Подписывает (`subscribe`) + возвращает тот же обработчик `(req, res)`. Сервер не поднимает. |
| Обработчик webhook | Принимает только `POST` на `hookPath` с валидным заголовком `x-max-bot-api-secret` (сравнение `timingSafeEqual`; если `secret` не задан — заголовок не проверяется). Отвечает `200 'OK'` (`Content-Type: text/plain`) **до** обработки update, затем `handleUpdate(update)`; невалидный JSON → `400 'Invalid JSON'`; иначе → `404 'Not Found'`. Ошибки middleware попадают в `bot.catch` (через `handleUpdate`); если обработчик ошибок сам бросает (поведение по умолчанию: `process.exitCode = 1; throw err`), исключение перехватывается в webhook-слое и только логируется через `debug` — процесс **не** завершается, но `process.exitCode` остаётся `1`. |
| `stopPolling()` | `abortController.abort()`. `stop()` — deprecated-алиас. |
| `stopWebhook()` | Только если бот запускался через `startWebhook` (флаг `webhookIsStarted`): `server.close()` + `DELETE /subscriptions?url=`. После `createWebhook`/`webhookCallback` флаг не ставится — вызов ничего не делает (debug «Webhook is not running»); проверено тестом `server/test/webhook-mode.test.ts`. |
| `bot.catch(handler)` | Заменяет `handleError`. По умолчанию: `process.exitCode = 1; console.error('Unhandled error while processing', ctx.update); throw err;`. README: «По умолчанию `bot.handleError` просто завершает работу программы… ⚠️ Завершайте работу программы при неизвестных ошибках, иначе бот может зависнуть в состоянии ошибки.» |
| `handleUpdate(update)` | `ctx = new contextType(update, api, botInfo)`; `await this.middleware()(ctx, () => Promise.resolve())`; ошибки → `handleError(err, ctx)`. При polling все update из одной пачки обрабатываются **параллельно** (`Promise.all(updates.map(handleUpdate))`). |

Отладочный вывод: `DEBUG=max:*` (`debug('max:main')`, `max:client`, `max:polling`, `max:webhook`, `max:messages`) [SDK-код].

Документация платформы о режимах [док https://dev.max.ru/docs-api/methods/GET/updates]: Long Polling «ограничено по скорости и сроку хранения событий», «Для production-окружения используйте только Webhook»; одновременно с webhook-подпиской использовать нельзя. Webhook [док https://dev.max.ru/docs-api/methods/POST/subscriptions]: `url` — «URL HTTPS-endpoint вашего бота. Должен начинаться с `https://`»; порт только 443 (в URL не указывать); сертификат от доверенного CA или Минцифры, «Самоподписанные сертификаты не поддерживаются»; `secret` — 5–256 символов, паттерн `^[a-zA-Z0-9_-]{5,256}$`, приходит в заголовке `X-Max-Bot-Api-Secret`; ответ «HTTP 200 в течение 30 секунд»; ретраи до 10 попыток с экспоненциальной задержкой (60 с, 150 с, 375 с …); автоотписка, если нет успешного ответа 8 часов [док там же и https://dev.max.ru/help/events: «Если в течение 8 часов ответ не получен, бот автоматически от него отписывается»].

### 1.4. Обработчики (Composer)

Источник: `dist/core/composer/composer.d.ts`, `composer.js`, `modules/triggers.js` [SDK-типы/код]. `Bot extends Composer`, поэтому всё доступно на `bot`.

```ts
export type TriggerFn<Ctx extends Context> = (value: string, ctx: Ctx) => RegExpExecArray | null;
export type Triggers<Ctx extends Context = Context> = MaybeArray<string | RegExp | TriggerFn<Ctx>>;
export type NextFn = () => Promise<void>;
export type MiddlewareFn<Ctx extends Context> = (ctx: Ctx, next: NextFn) => MaybePromise<unknown>;

class Composer<Ctx extends Context> {
    use(...middlewares: MiddlewareList<Ctx>): this;
    on<Filter extends UpdateType | Guard<Ctx['update']>>(filters: MaybeArray<Filter>, ...middlewares: MiddlewareList<FilteredContext<Ctx, Filter>>): this;
    command(commands: Triggers<FilteredContext<Ctx, 'message_created'>>, ...middlewares: MiddlewareList<FilteredContext<Ctx, 'message_created'>>): this;
    hears(triggers: Triggers<FilteredContext<Ctx, 'message_created'>>, ...middlewares: MiddlewareList<FilteredContext<Ctx, 'message_created'>>): this;
    action(triggers: Triggers<FilteredContext<Ctx, 'message_callback'>>, ...middlewares: MiddlewareList<FilteredContext<Ctx, 'message_callback'>>): this;
    filter<Filter extends UpdateFilter<Ctx>>(filters: MaybeArray<Filter>, ...middlewares): MiddlewareFn<Ctx>;
    drop(predicate: Predicate<Ctx>): this;  fork(mw): this;  tap(mw): this;  lazy(factory): this;
    branch(predicate, onTrue, onFalse): this;  optional(predicate, ...mw): this;
    dispatch(route, handlers, fallback?): this;
    help(...mw): this;      // «Сокращение для команды `/help`»
    settings(...mw): this;  // «Сокращение для команды `/settings`»
    static reply(...args: Parameters<Context['reply']>): MiddlewareFn<Context>;
    static log(logger: (message: string) => void): MiddlewareFn<Context>;
    static catch(errorHandler, ...mw): MiddlewareFn;
}
```

Семантика триггеров [SDK-код `triggers.js`, `composer.js`]:
- **Строковый триггер совпадает только со всей строкой** (`new RegExp('^' + escape(trigger) + '$')`, после `trim()`), комментарий в коде: «Строковый триггер совпадает только со всей строкой и не трактуется как RegExp». Следствие: `bot.command('start')` сработает на `/start`, но **не** на `/start abc`. Для команд с аргументом использовать RegExp: `bot.command(/^start(?:\s+(.+))?$/, ctx => ctx.match?.[1])`.
- `command`: фильтр `message_created` с непустым `body.text`; текст обязан начинаться с `/`; триггер получает строку после `/` («В `/name value` триггер получает всю строку после слеша: `name value`»). В групповом чате начальное упоминание бота (`markup.type === 'user_mention'`, `from === 0`, `user_id === myId`) отрезается.
- `hears`: тот же фильтр, триггер получает весь текст.
- `action`: фильтр `message_callback`; триггер получает `ctx.update.callback.payload`; если `payload` пустой — обработчик пропускается.
- Совпадение (`RegExpExecArray`) кладётся в `ctx.match`.
- `on(filters)`: `filters` — `UpdateType` или type-guard (`(update) => update is …`); хелперы `anyOf`, `allOf`, `createdMessageBodyHas('text')`, `messageCallback`, `messageEdited` [SDK-типы `filters.d.ts`].
- Цепочка onion: обработчик продолжает её вызовом `next()`; если `next()` не вызван — остальные обработчики не выполняются [SDK-docs 09-sdk-concepts.md].

Типы событий (`UpdateType`) [SDK-типы `types/subcription.d.ts`]: `bot_added | bot_started | bot_stopped | bot_removed | chat_title_changed | comment_created | comment_edited | comment_removed | dialog_cleared | dialog_muted | dialog_removed | dialog_unmuted | message_callback | message_created | message_edited | message_removed | user_added | user_removed`.

### 1.5. `Context` (что есть в `ctx`)

Источник: `dist/core/context.d.ts`, `context.js` [SDK-типы/код].

```ts
export declare class Context<U extends Update = Update> {
    readonly update: U;
    readonly api: Api;
    readonly botInfo?: BotInfo | undefined;
    /** Совпадение, найденное `command`, `hears` или `action`. */
    match?: RegExpExecArray;
    /** Временные данные одного update; состояние между update хранится в session. */
    state: Record<string | symbol, unknown>;
    has(filters): this is FilteredContext<…>;
    get updateType(): UpdateType;
    get myId(): number | undefined;                // botInfo?.user_id
    get startPayload(): GetStartPayload<U>;        // только для bot_started: update.payload (string | null | undefined)
    get chat(): GetChat<U>;                        // update.chat — ни один из 18 типов Update не содержит поле chat → фактически всегда undefined
    get chatId(): GetChatId<U>;                    // update.chat_id, иначе update.message.recipient.chat_id (может быть null)
    get message(): GetMessage<U>;                  // update.message
    get messageId(): GetMsgId<U>;                  // update.message_id, иначе update.message?.body.mid
    get callback(): GetCallback<U>;                // update.callback (только message_callback)
    get user(): GetUser<U>;                        // update.user | callback.user | message.sender
    get contactInfo(): { tel?: string; fullName?: string } | undefined; // из вложения type:'contact' (vcf_info), парсится пакетом vcf
    get location(): { latitude: number; longitude: number } | undefined;
    get sticker(): { width; height; url; code } | undefined;

    reply(text: string, extra?: SendMessageExtra): Promise<Message>;                 // → api.sendMessageToChat(ctx.chatId, …)  (НЕ по user_id!)
    editMessage(extra: EditMessageExtra): Promise<ActionResponse>;                  // → api.editMessage(ctx.messageId, extra)
    deleteMessage(messageId?: string): Promise<ActionResponse>;                     // → api.deleteMessage(messageId ?? ctx.messageId)
    answerOnCallback(extra: AnswerOnCallbackExtra): Promise<ActionResponse>;        // → api.answerOnCallback(ctx.callback.callback_id, extra)
    sendAction(action: SenderAction): Promise<ActionResponse>;                      // → api.sendAction(ctx.chatId, action)
    getChat(chatId?: number): Promise<Chat>;  getMessage(id: string): Promise<Message>;  getMessages(extra?); getPinnedMessage(); pinMessage(messageId, extra?); unpinMessage();
    getChatMembership(); getChatAdmins(); addChatAdmins(admins, extra?); removeChatAdmin(userId); addChatMembers(userIds); getChatMembers(extra?); removeChatMember(userId); leaveChat();
    editChatInfo(extra); getAllChats(extra?); getVideoInfo(videoToken);
    getComments(messageId, extra?); getComment(messageId, commentId); deleteComment(messageId, commentId);
}
```

- Если нужного идентификатора в update нет, метод бросает `TypeError('Max: "<method>" isn\'t available for "<updateType>"')` [SDK-код `assert`].
- `ctx.reply` для `message_callback` берёт `chat_id` из `update.message.recipient.chat_id`; `update.message` там `Message | null | undefined` [SDK-типы] — при `null` будет `TypeError`.
- Методов `ctx.answerCallback`, `ctx.editMessageText`, `ctx.replyToUser` — **нет** [SDK-типы]. Точные имена: `ctx.answerOnCallback`, `ctx.editMessage`, `ctx.reply`.

### 1.6. Типы Update, используемые в проекте (дословно из `types/subcription.d.ts`) [SDK-типы]

```ts
type MakeUpdate<Type extends string, Payload extends object> = { update_type: Type; timestamp: number; } & { [key in keyof Payload]: Payload[key]; };
export type BotStartedUpdate = MakeUpdate<'bot_started', { chat_id: number; user: User; payload?: string | null; user_locale?: UserLocale; }>;
export type MessageCallbackUpdate = MakeUpdate<'message_callback', {
    callback: { timestamp: number; callback_id: string; payload?: string; user: User; };
    message?: Message | null;
    user_locale?: UserLocale | null;
}>;
export type MessageCreatedUpdate = MakeUpdate<'message_created', { message: Message; user_locale?: UserLocale | null; }>;
export type BotAddedUpdate = MakeUpdate<'bot_added', { chat_id: number; user: User; is_channel: boolean; }>;
export type MessageRemovedUpdate = MakeUpdate<'message_removed', { message_id: string; chat_id: number; user_id: number; post_id: string | null; }>;
```

Документация подтверждает состав [док https://dev.max.ru/docs-api/objects/Update]: `message_callback.callback` = `{timestamp (int64, мс), callback_id (string), payload (string), user (User)}`, `message` (Message), `user_locale`; `bot_started` = `{chat_id (int64), user, payload (string, опц.), user_locale}`.

`Message`/`User` [SDK-типы `types/message.d.ts`, `types/user.d.ts`]:

```ts
export type MessageBody = { mid: string; seq: number; text: string | null; attachments?: Attachment[] | null; markup?: MarkupElement[] | null; };
export type MessageRecipient = { chat_id: number | null; chat_type: ChatType; user_id: number | null; post_id: number | null; };
export type Message = { sender?: User | null; recipient: MessageRecipient; timestamp: number; link?: LinkedMessage | null; body: MessageBody; stat?: MessageStat | null; url?: string | null; };
export type User = { user_id: number; /** @deprecated */ name: string; first_name: string; last_name?: string; username: string | null; is_bot: boolean; last_activity_time: number; };
export type BotCommand = { name: string; description?: string | null; };
export type BotInfo = UserWithPhoto & { commands?: BotCommand[] | null; };  // UserWithPhoto = User & { description?, avatar_url?, full_avatar_url? }
export type ActionResponse = { success: true } | { success: false; message: string };
```

### 1.7. `bot.api.*` — сигнатуры TS и соответствующие HTTP-вызовы

Источник: `dist/api.d.ts`, `api.js`, `core/network/api/modules/*/api.js`, `*/types.d.ts` [SDK-типы/код]; методы/пути подтверждены списком на https://dev.max.ru/docs-api [док].

| Метод SDK (точная сигнатура) | HTTP | Тело / query | Возвращает |
|---|---|---|---|
| `getMyInfo: () => Promise<BotInfo>` | `GET /me` | — | `BotInfo` (см. 1.6). Док [https://dev.max.ru/docs-api/methods/GET/me]: поля `user_id, first_name, last_name, username, is_bot, last_activity_time, name (deprecated), description (≤16000), avatar_url, full_avatar_url, commands (≤32)`. |
| `setMyCommands: (commands: BotCommand[]) => Promise<{commands: BotCommand[]}>` | `PATCH /me/commands` | body `{ commands }` | `{commands}` [док https://dev.max.ru/docs-api/methods/PATCH/me/commands: массив ≤ 32, пустой массив удаляет команды] |
| `deleteMyCommands: () => Promise<…>` | `PATCH /me/commands` | body `{ commands: [] }` | |
| `sendMessageToUser: (userId: number, text: string, extra?: SendMessageExtra) => Promise<Message>` | `POST /messages?user_id=<userId>[&disable_link_preview=true]` | body `{ text, attachments?, link?, notify?, format? }` | `Message` (SDK разворачивает `{message}`) |
| `sendMessageToChat: (chatId: number, text: string, extra?: SendMessageExtra) => Promise<Message>` | `POST /messages?chat_id=<chatId>` | то же | `Message` |
| `editMessage: (messageId: string, extra?: EditMessageExtra) => Promise<ActionResponse>` | `PUT /messages?message_id=<mid>` | body `{ text?, attachments?, link?, notify?, format? }` | `ActionResponse` |
| `deleteMessage: (messageId: string, extra?) => Promise<ActionResponse>` | `DELETE /messages?message_id=<mid>` | — | `ActionResponse` |
| `getMessage: (id: string) => Promise<Message>` | `GET /messages/{message_id}` | path | `Message` |
| `getMessages: (chatId: number, {message_ids?: string[], from?, to?, count?}) => Promise<{messages: Message[]}>` | `GET /messages?chat_id=&message_ids=a,b&from=&to=&count=` | query | |
| `answerOnCallback: (callbackId: string, extra?: AnswerOnCallbackExtra) => Promise<ActionResponse>` | `POST /answers?callback_id=<id>` | body `{ message?: NewMessageBody \| null }` | `ActionResponse` |
| `sendAction: (chatId: number, action: SenderAction) => Promise<ActionResponse>` | `POST /chats/{chat_id}/actions` | body `{ action }` | |
| `getUpdates: (types?: MaybeArray<UpdateType>, extra?: {limit?, timeout?, marker?, signal?}) => Promise<{updates: Update[]; marker: number}>` | `GET /updates?types=a,b&limit=&timeout=&marker=` | query | [док https://dev.max.ru/docs-api/methods/GET/updates: `limit` 1–1000 (по умолч. 100), `timeout` 0–90 с (по умолч. 30), `marker` int64] |
| `getSubscriptions: () => Promise<Subscription[]>` | `GET /subscriptions` | — | `[{url, time, updateTypes}]` |
| `subscribe: (url: string, secret?: string, update_types?: UpdateType[]) => Promise<ActionResponse>` | `POST /subscriptions` | body `{ url, secret, update_types }` | |
| `unsubscribe: (url: string) => Promise<ActionResponse>` | `DELETE /subscriptions?url=` | query | |
| `uploadImage: (options: UploadImageOptions) => Promise<ImageAttachment>` | `POST /uploads?type=image` + загрузка на `url` | см. 1.8 | объект-хелпер `ImageAttachment` |
| `uploadFile: (options: UploadFileOptions) => Promise<FileAttachment>` | `POST /uploads?type=file` + загрузка | | `FileAttachment` |
| `uploadVideo / uploadAudio` | `POST /uploads?type=video|audio` + загрузка | | `VideoAttachment / AudioAttachment` |
| `getChat(id)`, `editChatInfo(chatId, extra)`, `getAllChats(extra?)`, `getChatMembership(chatId)`, `getChatAdmins`, `addChatAdmins`, `removeChatAdmin`, `addChatMembers`, `getChatMembers`, `removeChatMember`, `getPinnedMessage`, `pinMessage`, `unpinMessage`, `leaveChat`, `getVideoInfo`, `getComments`, `getComment`, `sendComment`, `editComment`, `deleteComment` | см. `raw-api.d.ts` | | |

Низкоуровневый доступ: `bot.api.raw.get/post/patch/put/delete('<path>', {path?, query?, body?, signal?})` [SDK-типы `raw-api.d.ts`]; пример из документации [док https://dev.max.ru/docs/chatbots/bots-coding/js]:

```javascript
await ctx.api.raw.patch('chats/{chat_id}', {
    path: { chat_id: 123 },
    body: { title: 'New Title' },
    query: { notify: false },
});
```

Типы тел [SDK-типы `modules/messages/types.d.ts`, дословно]:

```ts
export type SendMessageDTO = {
    query: { user_id?: number; chat_id?: number; disable_link_preview?: boolean; };
    body: {
        text?: string | null;
        attachments?: AttachmentRequest[] | null;
        link?: { type: MessageLinkType; mid: string; } | null;   // MessageLinkType = 'forward' | 'reply'
        notify?: boolean;
        format?: MessageTextFormat | null;                        // 'markdown' | 'html'
    };
};
export type SendMessageExtra = Omit<FlattenReq<SendMessageDTO>, 'chat_id' | 'user_id' | 'text'> & { signal?: AbortSignal; };
// т.е. extra = { attachments?, link?, notify?, format?, disable_link_preview?, signal? }
export type EditMessageDTO = { query: { message_id: string; }; body: SendMessageDTO['body']; };
export type EditMessageExtra = Omit<FlattenReq<EditMessageDTO>, 'message_id'>;
export type AnswerOnCallbackDTO = { query: { callback_id: string; }; body: { message?: SendMessageDTO['body'] | null; }; };
export type AnswerOnCallbackExtra = Omit<FlattenReq<AnswerOnCallbackDTO>, 'callback_id'>;
```

Документация по этим методам [док]:
- `POST /messages` (https://dev.max.ru/docs-api/methods/POST/messages): query `user_id` (int64), `chat_id` (int64), `disable_link_preview` (bool); body `text` (≤ 4000), `attachments` (AttachmentRequest[]), `link` (NewMessageLink), `notify` (bool, по умолчанию `true`), `format` (`markdown`|`html`); ответ — объект `Message`; коды 200/401/500; «Максимум 2 сообщения в секунду».
- `PUT /messages` (https://dev.max.ru/docs-api/methods/PUT/messages): query `message_id` (обязателен); body как у отправки; `attachments: null` — без изменений, `[]` — удалить все вложения; ответ `{success, message?}`; «сообщения в диалогах редактируются только 7 дней, кроме сообщений с inline-клавиатурой (без ограничения)»; ≤ 2 правок/с в один чат.
- `POST /answers` (https://dev.max.ru/docs-api/methods/POST/answers): query `callback_id` («Идентификатор кнопки, на которую нажал пользователь», обязателен); body `message` (NewMessageBody, «Заполните это, если хотите изменить текущее сообщение»), `disable_link_preview` (bool; **в типах SDK 0.3.1 отсутствует**); ответ `{success, message?}`; коды 200/401/405/500; «Можно отправлять не более двух ответов в секунду в один диалог». Поле `notification` в документации **не описано**.
- `GET /me`, `PATCH /me/commands` — см. таблицу.
- `POST /subscriptions` — см. 1.3.

### 1.8. Загрузка файлов (getUploadUrl → upload → attachment)

Источник: `helpers/upload/upload.js`, `helpers/upload/types.d.ts`, `modules/uploads/*`, `stream-client.js`, `helpers/attachments.*` [SDK-код/типы]; https://dev.max.ru/docs-api/methods/POST/uploads [док].

Шаги SDK (`Upload.upload(type, file, options)`):
1. `POST /uploads?type=<image|video|audio|file>` → `{ url: string; token?: string }` [SDK-типы `GetUploadUrlResponse`]. Док: «`type` — `image` (JPG, JPEG, PNG, GIF, TIFF, BMP, HEIC), `video` (MP4, MOV, MKV, WEBM), `audio` (MP3, WAV, M4A…), `file`»; лимиты: image ≤ 50 МБ и ≤ 7680×7680; video ≤ 250 МБ; audio ≤ 256 МБ и ≤ 60 мин; file ≤ 4 ГБ [док].
2. Загрузка на `url` **отдельным транспортом** `node:https.request` (не через `clientOptions.fetch`) [SDK-код `stream-client.js`]:
   - если `token` есть в ответе `/uploads` (video/audio) и источник — поток: `POST` чанками с заголовками `Content-Range: bytes <start>-<end>/<size>`, `Content-Disposition: attachment; filename="…"`, `Content-Type: application/x-binary; charset=x-user-defined`, `X-File-Name`, `X-Uploading-Mode: parallel`; результат `{ token }` из шага 1;
   - иначе: `multipart/form-data` с полем **`data`** (`form-data`), ответ парсится как JSON; если тело не JSON (док: для видео Bot API отвечает `<retval>1</retval>`) — возвращается `{ token }` из шага 1.
   - Док (curl): `curl -X POST -H "Content-Type: multipart/form-data" -F "data=@filename.ext" "{url}"`; ответ загрузки: `{"token": "…"}` — «для `type = image`: `token` возвращается в ответе на загрузку файла» [док].
3. Таймаут всей загрузки: `options.timeout ?? 20000` мс (AbortController) [SDK-код].
4. `api.uploadFile(options)` возвращает `new FileAttachment({ token })`; `uploadImage` — `new ImageAttachment(data)` (принимает `{token}` | `{photos}` | `{url}`).

Опции [SDK-типы `helpers/upload/types.d.ts`]:

```ts
export type FileSource = string | ReadStream | Buffer;   // string = путь к файлу
export type UploadImageOptions = ({ source: FileSource } | { url: string }) & { timeout?: number; onUploadProgress?: (e: {ratio, loaded, total, percent}) => void };
export type UploadFileOptions  = { source: FileSource } & { timeout?: number; onUploadProgress?: … };
export type UploadVideoOptions = UploadAudioOptions = то же, что UploadFileOptions;
```

Для `Buffer` имя файла = `randomUUID()` (без расширения) [SDK-код] — для PDF-счетов передавать **путь к файлу** или `ReadStream` с осмысленным `path`, иначе имя файла у получателя будет UUID.

Отправка вложения [док https://dev.max.ru/docs/chatbots/bots-coding/js, дословно]:

```javascript
const image = await ctx.api.uploadImage({ source: '/path/to/image' });
await ctx.reply('Это фото загружено из файла', {
  attachments: [image.toJson()],
});
```
```javascript
const file = new FileAttachment({ token: 'existingFileToken' });
await ctx.reply('', { attachments: [file.toJson()] });
```

Обязательно вызывать **`.toJson()`** (именно `toJson`, не `toJSON`): классы вложений не сериализуются `JSON.stringify` сами [SDK-код `attachments.js`]. Формат `AttachmentRequest` [SDK-типы `types/attachment-request.d.ts`]: `{type:'file', payload:{token}}`, `{type:'image', payload:{token?|url?|photos?}}`, `{type:'inline_keyboard', payload:{buttons: Button[][]}}`, `{type:'location', latitude, longitude}` и т.д.

`attachment.not.ready` [док https://dev.max.ru/docs-api/methods/POST/uploads]: после загрузки при немедленной отправке возможна ошибка `{"code": "attachment.not.ready", "message": "Key: errors.process.attachment.file.not.processed"}`; рекомендация: «После загрузки файла добавьте паузу перед отправкой сообщения. Если отправка не удалась — повторите через некоторое время, увеличивая интервал с каждой попыткой. Предварительно загружайте часто используемые файлы и переиспользуйте token». SDK делает это сам — см. 1.11.

### 1.9. Keyboard builder и типы кнопок

Источник: `helpers/keyboard.d.ts`, `helpers/buttons.d.ts`, `buttons.js`, `types/keyboard.d.ts` [SDK-типы/код]; `docs/04-keyboard.md` [SDK-docs]; https://dev.max.ru/docs/chatbots/bots-coding/js и https://dev.max.ru/docs-api [док].

```ts
// helpers/index.d.ts: export * as Keyboard from './keyboard';
// helpers/keyboard.d.ts:
export declare const inlineKeyboard: (buttons: InlineKeyboardAttachmentRequest["payload"]["buttons"]) => InlineKeyboardAttachmentRequest;
export * as button from './buttons';
// helpers/buttons.d.ts (дословно):
export declare const callback: (text: string, payload: string) => CallbackButton;
export declare const clipboard: (text: string, payload: string) => ClipboardButton;
export declare const link: (text: string, url: string) => LinkButton;
export declare const requestContact: (text: string) => RequestContactButton;
export declare const requestGeoLocation: (text: string, extra?: MakeExtra<RequestGeoLocationButton>) => RequestGeoLocationButton; // extra = { quick?: boolean }
export declare const message: (text: string) => MessageButton;
export declare const openApp: (text: string, webApp: string, contactId?: number, payload?: string) => OpenAppButton;
// types/keyboard.d.ts (дословно):
export type CallbackButton = { type: 'callback'; text: string; payload: string; };
export type LinkButton = { type: 'link'; text: string; url: string; };
export type ClipboardButton = { type: 'clipboard'; text: string; payload: string; };
export type RequestContactButton = { type: 'request_contact'; text: string; };
export type RequestGeoLocationButton = { type: 'request_geo_location'; text: string; quick?: boolean; };
export type MessageButton = { type: 'message'; text: string; };
export type OpenAppButton = { type: 'open_app'; text: string; web_app?: string | null; contact_id?: number | null; payload?: string | null; };
export type Button = CallbackButton | LinkButton | RequestContactButton | RequestGeoLocationButton | OpenAppButton | ClipboardButton | MessageButton;
```

Что реально строится [SDK-код `buttons.js`, `keyboard.js`]: `callback(text, payload)` → `{type:'callback', text, payload}`; `openApp(text, webApp, contactId, payload)` → `{type:'open_app', text, web_app: webApp, contact_id: contactId, payload}`; `inlineKeyboard(buttons)` → `{type:'inline_keyboard', payload:{buttons}}`. Результат `inlineKeyboard` — обычный объект, его кладут прямо в `attachments` (без `toJson`) — пример из документации [док https://dev.max.ru/docs/chatbots/bots-coding/js, дословно]:

```typescript
const keyboard = Keyboard.inlineKeyboard([
  [
    Keyboard.button.callback('default', 'color: default'),
    Keyboard.button.callback('positive', 'color: positive'),
    Keyboard.button.callback('negative', 'color: negative'),
  ],
  [Keyboard.button.link('Открыть MAX', 'https://max.ru')],
]);

bot.command('start', (ctx: Context) => {
  ctx.reply('Добро пожаловать!', {attachments: [keyboard]})
});
```

Параметр **`intent`** у `Keyboard.button.callback` в 0.3.1 **отсутствует** (сигнатура `(text, payload)`; в типе `CallbackButton` поля `intent` нет) [SDK-типы]. На странице https://dev.max.ru/docs-api слово «intent» не встречается [док]. Единственный официальный источник значений — Go-клиент `github.com/max-messenger/max-bot-api-client-go/schemes`: `Intent string; POSITIVE="positive", NEGATIVE="negative", DEFAULT="default"`; `CallbackButton{ Payload string \`json:"payload"\`; Intent Intent \`json:"intent,omitempty"\` }` [док https://pkg.go.dev/github.com/max-messenger/max-bot-api-client-go/schemes]. Если нужен `intent`, отправлять литерал `{ type: 'callback', text, payload, intent: 'positive' } as CallbackButton` — поведение сервера при этом в TS-документации не описано. Существует issue #216 в репозитории SDK о расхождении документации и типа `callback` [док https://github.com/max-messenger/max-bot-api-client-ts/issues/216].

Описание типов кнопок [док https://dev.max.ru/docs-api, дословно]: `callback` — «Сервер MAX отправляет событие с типом `message_callback`»; `link` — «Открывает ссылку в новой вкладке. Длина ссылки ограничена 2048 символами.»; `request_contact` — «Запрашивает у пользователя его контакт и номер телефона.»; `request_geo_location` — «Запрашивает у пользователя его местоположение.»; `open_app` — «Открывает мини-приложение внутри чат-бота.»; `message` — «Отправляет боту заранее заданный текст.»; `clipboard` — «Копирует текст, указанный в свойстве `payload`, в буфер обмена.» Пример JSON [док]:

```json
{ "text": "Это сообщение с видео, изображением и кнопками",
  "attachments": [ { "type": "inline_keyboard", "payload": { "buttons": [ [ { "type": "callback", "text": "Кнопка 1", "payload": "Кнопка 1 нажата" } ] ] } } ] }
```

`request_contact` [SDK-docs 04-keyboard.md]: «При нажатии на неё боту будет отправлено сообщение с номером телефона, полным именем и почтой пользователя во вложении в формате `VCF`» — SDK парсит его в `ctx.contactInfo.tel` / `fullName` [SDK-код]. Тип вложения: `ContactAttachment = { type:'contact'; payload:{ vcf_info: string; max_info: User; hash: string } }` [SDK-типы]. Что означает `hash` — **не описано**.

Кнопка `chat` описана в `docs/04-keyboard.md` (`button.chat(text, chatTitle, extra)`), но в коде 0.3.1 её **нет** (`buttons.d.ts`) и в списке типов кнопок на dev.max.ru её нет [SDK-типы, док].

### 1.10. Форматы `payload`, `mid`, `callback_id`

- `payload` callback-кнопки: тип `string` [SDK-типы, док]. Приходит обратно в `update.callback.payload` (`payload?: string`) [SDK-типы], в `bot.action(trigger)` триггер применяется к нему. **Максимальная длина — не описана** ни на dev.max.ru (страницы `objects/CallbackButton` нет — 404; в схеме `POST /messages` лимит не указан), ни в SDK.
- `message.body.mid`: `string` [SDK-типы]; документация формат не описывает («mid — Message identifier»; формат не указан) [док https://dev.max.ru/docs-api/objects/Message]. Получать из ответа `sendMessageToUser/Chat(...)` → `message.body.mid` (пример из документации: `const message = await bot.api.sendMessageToUser(12345, "Привет!"); console.log(message.body.mid);`) [док https://dev.max.ru/docs/chatbots/bots-coding/js]. Используется в `link: { type: 'reply', mid }`, `editMessage(mid)`, `deleteMessage(mid)`.
- `callback_id`: `update.callback.callback_id` (`string`) → `ctx.callback.callback_id`; `ctx.answerOnCallback(extra)` подставляет его сам [SDK-код]. Док: «Идентификатор кнопки, на которую нажал пользователь» [док https://dev.max.ru/docs-api/methods/POST/answers]. Срок жизни `callback_id` — **не описан**.
- `bot_started.payload`: строка из диплинка `?start=` (см. раздел 5), `ctx.startPayload` [SDK-код].

### 1.11. Ошибки SDK и retry

Источник: `core/network/api/error.d.ts`, `error.js`, `modules/messages/api.js`, `const.js`, `polling.js`, `stream-client.js` [SDK-типы/код].

```ts
type KnownErrorCodes = 'attachment.not.ready';
export type ErrorCode = KnownErrorCodes | (string & {});
export type ErrorResponse = { code: ErrorCode; message: string; };
export declare class MaxError extends Error {
    readonly status: number;
    constructor(status: number, response: ErrorResponse);
    get code(): ErrorCode;         // response.code
    get description(): string;     // response.message
}
// error.js: super(`${status}: ${response.message}`)  → err.message === '400: …'
```

- Поля: `err.status` (HTTP-код или 401/499/500 синтетический), `err.code`, `err.description`, `err.message` = `"<status>: <message>"`. Поля `err.response` нет в публичном типе (private).
- Синтетические коды клиента [SDK-код]: `verify.token` (401: «Empty access_token» / «Invalid access_token»), `unexpected.response` (не-JSON), `upload.length.error`, `upload.request.aborted`, `upload.request.error`, `upload.stream.error` (все со `status = 499`).
- `attachment.not.ready` при отправке сообщения: `MessagesApi.send` делает **`SEND_MESSAGE_RETRIES_COUNT = 3`** попытки с задержкой `SEND_MESSAGE_RETRY_DELAY_BASE_TIME * 2**attempt` = 1000, 2000, 4000 мс (уважает `signal`); любая другая ошибка пробрасывается сразу; после 3 неудач — `throw lastError` (последний `MaxError` с `code: 'attachment.not.ready'`), либо `new MaxError(500, {code:'attachment.not.ready', message:'Attachment not ready after 3 retries'})` [SDK-код `messages/api.js`, `const.js`]. Это и есть «retry в 0.3.0» из changelog («конечный retry с backoff и AbortSignal для attachment.not.ready»).
- Polling: retry при `MaxError.status === 429 || >= 500` или `TypeError` — задержка 5 с × 2 до 60 с (см. 1.3). Ошибок 401/400 polling **не переживает** — цикл падает, затем перезапуск через 5 с (если `retry !== false`) [SDK-код].
- Ошибки в обработчиках → `bot.catch(handler)`; по умолчанию процесс завершается с `exitCode = 1` [SDK-код].
- `Composer.catch(errorHandler, ...middlewares)` — локальный перехват для части цепочки [SDK-типы].

### 1.12. Пример минимального бота (README из tarball, дословно)

Источник: `package/readme.md` (тот же текст, что https://github.com/max-messenger/max-bot-api-client-ts/blob/main/readme.md) [SDK-docs].

```javascript
import { Bot } from '@maxhub/max-bot-api';

const bot = new Bot(process.env.BOT_TOKEN);

// Установка подсказок с доступными командами
bot.api.setMyCommands([
  { 
    name: 'ping',
    description: 'Сыграть в пинг-понг'
  },
]);

// Обработчик события запуска бота
bot.on('bot_started', (ctx) => ctx.reply('Привет! Отправь мне команду /ping, чтобы сыграть в пинг-понг'));

// Обработчик команды '/ping'
bot.command('ping', (ctx) => ctx.reply('pong'));

// Обработчик для сообщения с текстом 'hello'
bot.hears('hello', (ctx) => ctx.reply('world'));

// Обработчик для всех остальных входящих сообщений
bot.on('message_created', (ctx) => ctx.reply(ctx.message.body.text));

bot.start();
```

Пользовательский fetch (README, дословно):

```typescript
const bot = new Bot(token, {
  clientOptions: {
    fetch: customFetch,
  },
});
```

«`clientOptions.fetch` используется только API-клиентом Bot API. Через него проходят обычные API-запросы, например `/me`, `/updates`, `/messages`, а также запрос за upload URL через `/uploads`. Эта настройка не влияет на загрузку содержимого файлов через `StreamUploadClient`… Поэтому `clientOptions.fetch` не следует считать полноценной поддержкой proxy для всего исходящего трафика SDK.»

Расширение контекста (TS) [док https://dev.max.ru/docs/chatbots/bots-coding/js, дословно]:

```typescript
interface MyContext extends Context {
  isAdmin?: boolean;
}
const ADMIN_ID = 12345;
const bot = new Bot<MyContext>(process.env.BOT_TOKEN);
bot.use(async (ctx, next) => {
  ctx.isAdmin = ctx.user?.user_id === ADMIN_ID;
  return next();
});
```

Сессии [README]: «По умолчанию `session()` хранит данные только в памяти процесса. При остановке, падении или перезапуске бота все сессии и незавершённые сценарии будут потеряны.» Подключение: `bot.use(session({ defaultSession: () => ({...}) }))`, тип контекста `Context & { session: S }` [SDK-docs 06-sessions-and-scenarios.md].

### 1.13. Сертификат Минцифры и `platform-api2.max.ru`

- Требование [док https://dev.max.ru/docs-api]: «…убедитесь, что добавили сертификат Минцифры в список доверенных». Релиз SDK v0.2.4 [док https://github.com/max-messenger/max-bot-api-client-ts/releases]: «URL для HTTP-запросов изменён с platform-api.max.ru на platform-api2.max.ru. Для работы с новым адресом добавьте сертификат Минцифры в список доверенных.»
- Ссылки на скачивание сертификата на dev.max.ru **отсутствуют** (проверены https://dev.max.ru/docs-api, /docs-api/changelog-api, /help/platform_connection, /help/miniapps, /docs/changelog-platform). Страница https://www.gosuslugi.ru/crt из задания **не открылась** (ошибка DNS/robots в среде проверки) — ссылка не подтверждена.
- SDK **никак не настраивает TLS**: Bot API — через `globalThis.fetch` (или переданный `clientOptions.fetch`), загрузка файлов — через `node:https.request` без опций `ca`/`agent` [SDK-код `client.js`, `stream-client.js`]. Значит, доверие к корневому сертификату задаётся на уровне Node.js.
- Механизм Node.js [док https://nodejs.org/api/cli.html, раздел `NODE_EXTRA_CA_CERTS=file`]: переменная окружения задаёт файл с дополнительными CA-сертификатами в PEM, которые **добавляются** к встроенному набору доверенных корней; читается один раз при старте процесса. Применимость к `globalThis.fetch` (undici) явно в этом разделе не оговорена — **допущение**, что undici использует тот же TLS-стек Node.
- Практический контракт для кода: (1) положить PEM (корневой + промежуточный сертификат Минцифры) в образ, (2) запускать `NODE_EXTRA_CA_CERTS=/certs/russian_trusted.pem node dist/index.js`, (3) при старте вызывать `bot.api.getMyInfo()` и при `TypeError: fetch failed` с `cause.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'`/`SELF_SIGNED_CERT_IN_CHAIN` печатать понятную подсказку. Какой именно сертификат (Russian Trusted Root CA / Sub CA) предъявляет `platform-api2.max.ru` — **проверить не удалось** (хост недоступен из среды проверки).

### 1.14. Замеченные расхождения SDK ↔ документация

1. `Keyboard.button.callback(text, payload)` — без `intent`; `docs/04-keyboard.md` и dev.max.ru тоже дают `(text: string, payload: string)`, но issue #216 и Go-клиент показывают, что API принимает `intent`. Тип `CallbackButton` в TS его не содержит.
2. `docs/04-keyboard.md` описывает `button.chat(...)` и `openApp(text, webApp?: string, …)` (webApp необязателен); в коде 0.3.1 `chat` нет, а `webApp: string` обязателен.
3. Тип `ImageUploadResult = { photos: {[key]: {token}} }` [SDK-типы], а документация `POST /uploads` говорит, что для `image` загрузка возвращает `{"token": "…"}`. Код `ImageAttachment` принимает оба варианта, поэтому на поведение не влияет.
4. `POST /answers` в документации имеет `disable_link_preview`; в `AnswerOnCallbackDTO` его нет.
5. `bot.start()` в режиме polling **удаляет все webhook-подписки** бота — в документации SDK это не описано, только в коде.
6. Webhook-обработчик SDK отвечает `200 OK` до обработки; при polling необработанная ошибка (после `bot.catch`, если он бросает) роняет цикл polling с перезапуском через 5 с, а при webhook — только логируется через `debug` (процесс продолжает работать с `process.exitCode = 1`). Поведение по режимам различается и в документации не описано.
7. `Context.chat` (getter) всегда `undefined` — ни один тип Update не содержит `chat`.
8. **`bot.command(...)` роняет обработку любого `message_created` с `body.text === null`.** Фильтр команд вызывает
   `text.startsWith('/')` без проверки на `null`, поэтому сообщение с одним вложением и без текста (именно так
   приходит фото или PDF — например чек из «Мой налог») даёт `TypeError: Cannot read properties of null (reading
   'startsWith')`. Ошибка уходит в `bot.catch`, то есть без него процесс завершится. Проверено на 0.3.1 20.09.2026:
   с зарегистрированным `bot.command(/^start.../)` обновление с `body: { text: null, attachments: [{type:'image', …}] }`
   до пользовательских обработчиков не доходит. В документации и в `docs/` SDK это не описано.
   **Обход, применённый в проекте:** middleware `bot.on('message_created', …)`, зарегистрированный **до** любого
   `bot.command`, перехватывает сообщения без текста и не вызывает `next()`
   (`server/src/transport/bot/handlers/input.ts::registerTextlessGuard`). Командам такие сообщения не нужны.
9. **Возврат значения из `onRequest`-хука Fastify не завершает запрос** (это не про SDK MAX, но ловится в той же
   связке): обработчик маршрута всё равно выполняется. Ошибки авторизации `/api` поэтому бросаются исключением,
   а формат ответа задаёт единый `setErrorHandler` (`server/src/transport/http/server.ts`).
10. **Обработчик из `webhookCallback()`/`createWebhook()` нельзя просто повесить на маршрут Fastify.** Он принимает сырые
    `(IncomingMessage, ServerResponse)`: сам читает тело из потока запроса и сам пишет ответ. Fastify по умолчанию
    делает и то и другое раньше — и обе стороны ломаются:
    - JSON-парсер Fastify **вычитывает поток до обработчика**, поэтому обработчик SDK ждёт события `data`/`end`,
      которых уже не будет. Запрос висит до таймаута, update не обрабатывается — в режиме `webhook` это
      означает молча замолчавшего бота;
    - без `reply.hijack()` Fastify после обработчика продолжает ждать `reply.send()`, которого не будет.
    Проверено на `@maxhub/max-bot-api` 0.3.1 + Fastify 5, 21.09.2026 (тест `server/test/webhook-mode.test.ts`).
    В документации SDK встраивание в фреймворк не описано — только «зарегистрируйте возвращённый обработчик».
    **Решение в проекте:** отдельный плагин `server/src/transport/http/routes/max-webhook.ts` со своей областью
    видимости: парсер содержимого, который не трогает поток (`done(null, undefined)`), и `reply.hijack()`.
    Разбор JSON для `/api` и `/webhooks/yookassa` остаётся обычным, потому что парсер в Fastify инкапсулирован.

11. **`?access_token=` в query больше не работает — только заголовок `Authorization`.** Проверено вживую
    21.09.2026 на `platform-api2.max.ru`: `GET /subscriptions?access_token=<токен>` отвечает
    `401 {"code":"verify.token","message":"Query parameter access_token is deprecated, use Authorization header"}`,
    а `GET /me?access_token=<токен>` возвращает пустой объект вместо ошибки. С заголовком
    `Authorization: <токен>` (без префикса `Bearer`) оба метода работают. На код проекта это не влияет —
    SDK всегда слал заголовок, — но ручная диагностика по документации ломается, поэтому зафиксировано здесь
    и в `deploy/README.md` §5.

12. **Имя загружаемого файла обязано быть ASCII, иначе загрузка падает целиком.** SDK подставляет имя
    в заголовок `Content-Disposition` без кодирования по RFC 5987, поэтому кириллица даёт
    `TypeError: Invalid character in header content ["content-disposition"]` — файл не уходит вообще,
    а не «уходит с кривым именем». Проверено 21.09.2026 попыткой назвать квитанцию `Квитанция_<id>.pdf`.
13. **Получатель видит базовое имя файла по пути, который вы загрузили.** Никакого отдельного поля
    «имя вложения» нет: как назван временный файл — так и подписано вложение в чате. Проверено вживую
    21.09.2026: квитанция приходила как `dogovorilis-<id>-<таймстамп>.pdf`, потому что таков был путь
    во временном каталоге. Следствие для кода: уникальность пути обеспечивать **каталогом**
    (`mkdtemp`), а не суффиксом в имени файла — иначе таймстамп видит пользователь.

### 1.15. Не удалось проверить (раздел 1)

- Максимальная длина `payload` callback-кнопки и `text` кнопки — в документации не описаны.
- Формат `mid`, срок жизни `callback_id` — не описаны.
- Значения и поведение `intent` на dev.max.ru — не описаны (есть только в Go-клиенте).
- Ссылка на скачивание сертификата Минцифры (gosuslugi.ru/crt не открылся); какой сертификат предъявляет `platform-api2.max.ru`.
- Точный список файлов `docs/*.md` репозитория SDK (GitHub tree/API недоступны; прочитаны только `04-keyboard.md`, `06-sessions-and-scenarios.md`, `09-sdk-concepts.md`).
- Страница `https://dev.max.ru/docs/chatbots/bots-coding/library/js` вернула только навигацию.
- Поле `hash` в `contact`-вложении — назначение не описано.

---

## 2. ЮKassa API v3 (тестовый магазин)

### 2.1. Базовые правила

Источник: https://yookassa.ru/developers/using-api/interaction-format [док].

- Базовый URL: «API endpoint: `https://api.yookassa.ru/v3/`». Ответ всегда JSON: «API всегда возвращает ответ в формате JSON».
- Аутентификация: HTTP Basic Auth — «в качестве имени пользователя необходимо передать идентификатор вашего магазина или шлюза в ЮKassa, в качестве пароля — ваш секретный ключ». Заголовок: `Authorization: Basic base64(<shopId>:<secretKey>)`. OAuth 2.0 — только для партнёрской программы.
- `Content-Type: application/json` для POST (см. curl из quick-start ниже).
- Идемпотентность: «В заголовке `Idempotence-Key` можно передавать любое значение, уникальное для этой операции на вашей стороне. Длина не больше 64 символов. Рекомендуется использовать V4 UUID»; «ЮKassa обеспечивает идемпотентность в течение 24 часов после первого запроса»; «получив повторный запрос с теми же параметрами, ЮKassa выдаст в ответе результат исходного запроса»; те же данные + другой ключ = новый запрос. Поведение при **том же ключе и других параметрах** — в полученном фрагменте не описано.
- Синхронность: «Если в течение 30 секунд невозможно дать точный ответ» — возвращается HTTP 500.

### 2.2. `POST /v3/payments` — сценарий «redirect + capture:true + description + metadata + return_url»

Источник: https://yookassa.ru/developers/api (раздел «Создание платежа», параметры — через индекс официального сайта), https://yookassa.ru/developers/payment-acceptance/getting-started/quick-start [док].

Quick-start (дословно) [док quick-start]:

```
POST https://api.yookassa.ru/v3/payments
Authorization: Basic <shopId:secretKey>
Idempotence-Key: <случайное значение>
Content-Type: application/json
```
```json
{
  "amount": { "value": "100.00", "currency": "RUB" },
  "capture": true,
  "confirmation": { "type": "redirect", "return_url": "https://www.example.com/return_url" },
  "description": "Заказ №1"
}
```

Поля тела (для нашего сценария) [док api?lang=ru]:

| Поле | Тип | Обяз. | Описание (дословно/лимиты) |
|---|---|---|---|
| `amount.value` | string | да | «Сумма в выбранной валюте… в виде строки с точкой-разделителем, например `10.00`» |
| `amount.currency` | string | да | «Трехбуквенный код валюты в формате ISO-4217. Пример: `RUB`» |
| `capture` | boolean | нет | «Автоматический прием поступившего платежа. Возможные значения: `true` — оплата списывается сразу (платеж в одну стадию); `false` — оплата холдируется и списывается по вашему запросу (платеж в две стадии). По умолчанию `false`.» → **для нашего сценария передавать `capture: true` явно** |
| `confirmation.type` | string | да (для redirect) | `redirect` |
| `confirmation.return_url` | string | передаётся в quick-start вместе с `type: redirect` (дословный признак обязательности не получен) | URL возврата пользователя после подтверждения/отмены. Лимит «Не более 2048 символов», «URI должен соответствовать стандарту RFC-3986» — дословно подтверждён для `return_url` в аналогичном объекте `confirmation` метода `/v3/payment_methods`; для платежей текст лимита в полученном фрагменте не выведен |
| `confirmation.locale` | string | нет | `ru_RU` / `en_US` (пример на сайте: `"locale": "en_US"`) |
| `description` | string | нет | «Описание транзакции (не более 128 символов), которое вы увидите в личном кабинете ЮKassa, а пользователь — при оплате.» |
| `metadata` | object | нет | «Любые дополнительные данные… Ограничения: максимум 16 ключей, имя ключа не больше 32 символов, значение ключа не больше 512 символов, тип данных — строка в формате UTF-8.» |
| `client_ip` | string | нет | «IPv4 или IPv6-адрес пользователя. Если не указан, используется IP-адрес TCP-подключения.» |
| `receipt` | object | нет* | «Данные для формирования чека» — нужен при работе по 54-ФЗ через ЮKassa (в тестовом магазине «Взаимодействие с онлайн-кассой и ОФД только имитируется») |
| `payment_method_data` | object | нет | Не передавать — тогда способ выбирается на странице ЮKassa |
| `save_payment_method`, `merchant_customer_id`, `deal`, `transfers` | | нет | не нужны |

Пример ответа (дословно, api?lang=ru):

```json
{
  "id": "22e12f66-000f-5000-8000-18db351245c7",
  "status": "pending",
  "paid": false,
  "amount": { "value": "2.00", "currency": "RUB" },
  "confirmation": {
    "type": "redirect",
    "return_url": "https://www.example.com/return_url",
    "confirmation_url": "https://yoomoney.ru/payments/external/confirmation?orderId=22e12f66-000f-5000-8000-18db351245c7"
  },
  "created_at": "2018-07-18T10:51:18.139Z",
  "description": "Заказ №72",
  "metadata": {},
  "payment_method": { "type": "bank_card", "id": "22e12f66-000f-5000-8000-18db351245c7", "saved": false },
  "recipient": { "account_id": "100500", "gateway_id": "100700" },
  "refundable": false,
  "test": false
}
```

Объект `Payment` [док api?lang=ru / ?lang=en, дословные описания]:

| Поле | Тип | Описание |
|---|---|---|
| `id` | string, обяз. | «Идентификатор платежа в ЮKassa» |
| `status` | string, обяз. | «Статус платежа. Возможные значения: `pending`, `waiting_for_capture`, `succeeded`, `canceled`» |
| `paid` | boolean, обяз. | «Признак оплаты заказа.» |
| `amount` | object, обяз. | сумма с валютой (`value`, `currency`) |
| `income_amount` | object, опц. | сумма к зачислению (пример `"1.97"`) |
| `description` | string, опц. | ≤ 128 |
| `recipient` | object, обяз. | `account_id` (магазин), `gateway_id` (субаккаунт) |
| `payment_method` | object, опц. | `type` (`bank_card`, `yoo_money`, `sbp`…), `id`, `saved`, `card{first6,last4,expiry_month,expiry_year,card_type,issuer_country,issuer_name}`, `title` |
| `captured_at` | string, опц. | «Time of payment capture, based on UTC… ISO 8601» |
| `created_at` | string, обяз. | «Время создания заказа… ISO 8601. Пример: `2017-11-03T11:52:31.827Z`» |
| `expires_at` | string, опц. | «The period during which you can cancel or capture a payment for free. The payment with the `waiting_for_capture` status will be automatically canceled at the specified time» — т.е. заполняется для `waiting_for_capture`; для `pending` — не описано |
| `confirmation` | object, опц. | «Выбранный способ подтверждения платежа. Присутствует, когда платеж ожидает подтверждения от пользователя.» Для `redirect`: `type`, `return_url`, `confirmation_url` |
| `test` | boolean, обяз. | «Признак тестовой операции» |
| `refunded_amount` | object, опц. | |
| `refundable` | boolean, обяз. | |
| `receipt_registration` | string, опц. | статус регистрации чека |
| `metadata` | object, опц. | те же лимиты |
| `cancellation_details` | object, опц. | «Комментарий к статусу `canceled`: кто отменил платеж и по какой причине.» `party` (`yoo_money`, `payment_network`, `merchant`), `reason` (строка; полный перечень — на странице «неуспешные платежи») |
| `authorization_details` | object, опц. | `rrn`, `auth_code`, `three_d_secure.applied` |

### 2.3. Статусы и переходы

Источник: https://yookassa.ru/developers/payment-acceptance/getting-started/payment-process [док].

- `pending` — «платеж создан и ожидает действий от пользователя» → `succeeded` | `waiting_for_capture` | `canceled`.
- `waiting_for_capture` — «платеж оплачен, деньги авторизованы и ожидают списания» → `succeeded` | `canceled`; «у вас есть от 2 часов до 7 дней, чтобы списать деньги. Точное время передается в параметре `expires_at`»; по истечении — `canceled` с причиной `expired_on_capture`.
- `succeeded` — «платеж успешно завершен, деньги будут перечислены на ваш расчетный счет…» (финальный).
- `canceled` — «платеж отменен» (финальный). «Пользователь может подтвердить платеж только за определенный срок. Если он не сделает этого, ЮKassa отменит платеж» → причина `expired_on_confirmation`.
- Срок подтверждения (жизни `confirmation_url`) по способам [док https://yookassa.ru/developers/payment-acceptance/getting-started/payment-methods, «Срок оплаты»]: «Банковская карта `bank_card` — 1 час», «ЮMoney `yoo_money` — 1 час», «SberPay `sberbank` — 1 час», «T-Pay `tinkoff_bank` — 1 час», «СБП `sbp` — 1 час»; «СберБанк Бизнес Онлайн — 8 часов»; «Наличные — Без ограничений».
- При `capture: true`: «сразу после оплаты платеж успешно завершится и перейдет в статус `succeeded`».
- Redirect-сценарий: мерчант «перенаправить пользователя на `confirmation_url`»; после завершения «ЮKassa вернет пользователя на `return_url`». Какие query-параметры добавляются к `return_url` — **не описано** → статус узнавать только через webhook или `GET`.

### 2.4. `GET /v3/payments/{payment_id}`

Источник: https://yookassa.ru/developers/api [док], дословно:

```bash
curl https://api.yookassa.ru/v3/payments/{payment_id} \
  -u <Идентификатор магазина>:<Секретный ключ>
```

«Request parameters: None.» Ответ — «объект платежа с текущим статусом» (тот же `Payment`). `Idempotence-Key` не нужен (GET).

### 2.5. Webhook (HTTP-уведомления)

Источник: https://yookassa.ru/developers/using-api/webhooks [док].

- Настройка: личный кабинет ЮKassa → «Интеграция — HTTP-уведомления»: указать URL и выбрать события. Для тестового магазина — свой URL в настройках тестового магазина («Для тестовых уведомлений от ЮKassa используйте специальный URL (его нужно прописать в настройках тестового магазина в личном кабинете)» [док testing]).
- Требования к URL: «протокол HTTPS и TCP-порт 443 или 8443», TLS 1.2+; сертификат любой, в т.ч. самоподписанный.
- События (формат `<объект>.<статус>`): `payment.waiting_for_capture`, `payment.succeeded`, `payment.canceled`, `refund.succeeded`, `payout.succeeded`, `payout.canceled`, `deal.closed`, `payment_method.active`.
- Тело: `{ "type": "notification", "event": "payment.succeeded", "object": { …полный объект Payment с текущим статусом… } }`. Пример (дословно, сокращённый на сайте):

```json
{
  "type": "notification",
  "event": "payment.succeeded",
  "object": {
    "id": "22d6d597-000f-5000-9000-145f6df21d6f",
    "status": "waiting_for_capture",
    "paid": true,
    "amount": {"value": "2.00", "currency": "RUB"},
    "authorization_details": {...},
    "created_at": "2018-07-10T14:27:54.691Z"
  }
}
```

- Ответ: «HTTP 200». Заголовки и тело ответа игнорируются. «Любой другой код считается невалидным, и ЮKassa продолжит доставлять уведомление в течение 24 часов, начиная с момента, когда событие произошло». Интервалы повторов — **не описаны**.
- IP-адреса ЮKassa (дословно): `185.71.76.0/27`, `185.71.77.0/27`, `77.75.153.0/25`, `77.75.156.11`, `77.75.156.35`, `77.75.154.128/25`, `2a02:5180::/32`.
- Проверка подлинности: сверить IP отправителя со списком **и/или** запросить актуальный статус `GET /v3/payments/{id}` (документация рекомендует проверять статус объекта через GET). Подписи уведомлений (HMAC) **нет** — не описана.
- Контракт для кода: принять POST → быстро ответить 200 → по `object.id` вызвать `GET /v3/payments/{id}` → обновлять заказ только по статусу из GET; идемпотентно (уведомление может прийти повторно).

### 2.6. Ошибки

Источник: https://yookassa.ru/developers/using-api/response-handling/response-format [док].

```json
{
  "type" : "error",
  "id" : "e65a8f85-f8b7-4f4f-9fd3-bfef99aacbbb",
  "code" : "invalid_request",
  "description" : "Idempotence key is too long. Send the value in accordance with the documentation",
  "parameter" : "Idempotence-Key"
}
```

| HTTP | `code` | Значение (дословно) |
|---|---|---|
| 400 | `invalid_request` | «неправильный запрос, например ошибка в значении параметра или нарушение логики проведения операции» |
| 401 | `invalid_credentials` | «некорректные данные для аутентификации запросов» |
| 403 | `forbidden` | «не хватает прав для выполнения операции» |
| 404 | `not_found` | «запрашиваемый ресурс не найден» |
| 429 | `too_many_requests` | «превышен лимит запросов в единицу времени» |
| 500 | `internal_server_error` | «технические неполадки на стороне ЮKassa» |

Поля: `type` («Фиксированное значение — `error`»), `id` («Идентификатор ошибки. Используйте его, если вам необходимо обратиться в техническую поддержку»), `code`, `description` («Описание ошибки на английском языке», опц.), `parameter` («Название заголовка или параметра тела ответа, из-за которого произошла ошибка», опц.). Поле `retry_after` — **не описано**. Рекомендации по повторам при 429/500 — **не описаны**; безопасно повторять POST только с тем же `Idempotence-Key`.

### 2.7. Тестовый магазин и тестовые карты

Источник: https://yookassa.ru/developers/payment-acceptance/testing-and-going-live/testing [док].

- Получение: регистрация с параметром `createTestShop=true` либо добавить тестовый магазин в ЛК (до 20 тестовых магазинов); «Получите идентификатор и секретный ключ тестового магазина. Они нужны для аутентификации запросов».
- Недоступно в тестовом магазине (дословно): «Выставление счетов через MCP-сервер»; «Все способы оплаты кроме банковских карт и кошелька ЮMoney» (→ **СБП недоступна**); «Взаимодействие с онлайн-кассой и ОФД только имитируется; физический чек не формируется»; ГИС ЖКХ — имитация. Кошелёк ЮMoney: «тестовый кошелек не понадобится: в тестовом магазине платежи проходят без участия реального кошелька».
- Для всех тестовых карт: «В качестве срока действия укажите любую дату (но больше текущей), CVC и код 3-D Secure — любые числа».
- Успешная оплата: `5555555555554477` (Mastercard, с 3-DS), `5555555555554444` (Mastercard, без 3-DS), `4793128161644804` (Visa, с 3-DS), `4111111111111111` (Visa, без 3-DS), `2200000000000004` (Mir, с 3-DS), `2202474301322987` (Mir, без 3-DS), `6759649826438453` (Maestro), `4175001000000017` (Visa Electron), `370000000000002` (AmEx), `3528000700000000` (JCB), `36700102000000` (Diners).
- Отказ платёжной сетью (`cancellation_details.party = payment_network`), карта → `reason`: `5555555555554592`/`4839665499603842`/`2200000000000012` → `3d_secure_failed`; `5555555555554535`/`4926946416239025`/`2200000000000020` → `call_issuer`; `5555555555554543`/`4141435412630840`/`2200000000000038` → `card_expired`; `5555555555554568`/`4483274282299972`/`2200000000000046` → `fraud_suspected`; `5555555555554527`/`4889971706588753`/`2202202212312379` → `general_decline`; `5555555555554600`/`4562265587712390`/`2200000000000053` → `insufficient_funds`; `5555555555554618`/`4951017853630544`/`2201382000000013` → `invalid_card_number`; `5555555555554626`/`4194180666146368`/`2200770212727079` → `invalid_csc`; `5555555555554501`/`4654130848359150`/`2201382000000021` → `issuer_unavailable`; `5555555555554576`/`4565231022577548`/`2201382000000039` → `payment_method_limit_exceeded`; `5555555555554550`/`4233961169071671`/`2201382000000047` → `payment_method_restricted`.
- Отказ стороной ЮKassa (`party = yoo_money`): `5555555555554584`/`4969751510013864`/`2201382000000054` → `country_forbidden`; `5555555555554634`/`4119098878796485`/`2201696981989955` → `fraud_suspected`.
- Лимиты сумм в тестовом режиме — **не описаны**. Для боевых карт [док https://yookassa.ru/developers/payment-acceptance/integration-scenarios/manual-integration/bank-card]: минимум «1 рубль», максимум «350 000 рублей», «Срок оплаты: 1 час».

### 2.8. SDK для Node.js

- Официальных SDK от ЮKassa (org `yoomoney` на GitHub) — PHP и Python (`yookassa-sdk-php`, `yookassa-sdk-python`); официального Node/TS SDK на странице SDK и в org `yoomoney` **не найдено**.
- `@a2seven/yoo-checkout` [npm registry]: версия `1.1.4`, дата публикации `2022-08-29`, README озаглавлен «Yoo.Checkout API SDK (unofficial)», автор A2Seven, зависимости `axios ^0.21.1`, `uuid ^8.3.2`, `@types/axios`. **Неофициальный, не обновлялся 4 года** → использовать **простой `fetch`** (Node ≥ 20) с ручными заголовками `Authorization: Basic …`, `Idempotence-Key: randomUUID()`, `Content-Type: application/json`.

### 2.9. Не удалось проверить (раздел 2)

- Страница https://yookassa.ru/developers/api рендерится динамически: параметры получены через индекс официального сайта (Context7 `/websites/yookassa_ru_developers_api`, ссылки на `https://yookassa.ru/developers/api?lang=ru`); OpenAPI-файл https://yookassa.ru/developers/api/yookassa-openapi-specification.yaml (OpenAPI 3.0.2, официальная ссылка со страницы https://yookassa.ru/developers/using-api/openapi-specification) прочитать не удалось (инструмент вернул «binary data»).
- Дословный текст лимита `return_url` именно для `POST /v3/payments` (подтверждён только для `payment_methods`).
- Полный перечень `cancellation_details.reason`.
- Интервалы повторных отправок webhook (документация даёт только «в течение 24 часов»).
- Поле `retry_after` и рекомендации по 429/500.
- Наличие/содержимое `expires_at` для статуса `pending`; query-параметры при возврате на `return_url`.
- Поведение при повторе с тем же `Idempotence-Key` и другими параметрами.

---

## 3. Т-Банк Интернет-эквайринг API v2 — СБП, DEMO-терминал, тест

### 3.1. Базовые URL и окружения

Источники: https://developer.tbank.ru/eacq/intro/errors/test , https://developer.tbank.ru/eacq/intro/errors/test-cases , https://developer.tbank.ru/eacq/intro/errors/test-sbp , https://developer.tbank.ru/eacq/intro/developer/openapi [док].

| Окружение | URL | Терминал | Когда |
|---|---|---|---|
| Боевое | `https://securepay.tinkoff.ru/v2` | рабочий **или** `DEMO` | Все методы (`/v2/Init`, `/v2/GetQr`, `/v2/GetState`, …). «Для прохождения тест-кейсов используйте тестовый терминал с приставкой `DEMO`», запросы — на боевую среду `https://securepay.tinkoff.ru/v2` [док test-cases]; «Тестирование СБП… использовать терминал с приставкой DEMO и направлять запросы на боевую среду» [док test-sbp]. |
| Тестовая среда | `https://rest-api-test.tinkoff.ru/v2` | «боевой терминал без приставки `DEMO`» | «Тестовая среда позволяет проверить работу методов без реальных списаний.» «Запросы с него нужно отправлять на тестовую среду `https://rest-api-test.tinkoff.ru/v2`». «Чтобы пользоваться тестовой средой, добавьте ваш IP-адрес в белый список тестовой среды.» (ИНН, наименование, IP — в чат ЛК Т-Бизнеса). Тестовые карты работают **только** здесь. |

OpenAPI: `https://developer.tbank.ru/schemas/eacq/openapi.yaml` («полное описание API интернет-эквайринга… в формате OpenAPI 3.0.2»; «Два окружения: production `https://securepay.tinkoff.ru`, test `https://rest-api-test.tinkoff.ru`») [док openapi].

**Вывод для СБП-теста**: использовать терминал `…DEMO` + боевой URL `https://securepay.tinkoff.ru/v2` + `SbpPayTest` для эмуляции оплаты. Белый список IP для этого пути документацией не требуется (требование описано только для `rest-api-test`).

Терминалы и ключи [док https://www.tbank.ru/business/help/business-payments/internet-acquiring/how-use/terminal/]: «Мы автоматически подключаем два терминала: тестовый и рабочий. Тестовый нужен, чтобы провести пробный платеж…»; «Зайдите в личный кабинет интернет-эквайринга → «Магазины». Выберите нужный магазин → «Терминалы» → «Тестовый» или «Рабочий» → «Настроить».» Параметры терминала [док https://developer.tbank.ru/eacq/intro/developer/terminal]: `TerminalKey` (20 символов), `Password` (20 символов; «Пароль находится в личном кабинете интернет-эквайринга»), `SuccessURL`/`FailURL`/`NotificationURL` (по 250 символов), режим терминала (рабочий/неактивный/тестовый). Лимиты сумм для DEMO-терминала — **не описаны**.

Все запросы: `POST`, `Content-Type: application/json`, тело JSON с обязательным `Token` (кроме отдельных методов с Bearer, не используемых здесь). Ответы 200 (в т.ч. с `Success: false`) и 500 [док страницы методов].

### 3.2. Алгоритм формирования `Token` (подпись запроса)

Источник: https://developer.tbank.ru/eacq/intro/developer/token [док], дословно по шагам.

«Токен, или подпись запроса — это строка в запросе методов, в которой мерчант должен шифровать данные с помощью пароля».

1. Собрать массив пар из **корневых** параметров запроса: «В массив нужно добавить только параметры корневого объекта — вложенные объекты и массивы не участвуют в формировании токена» (`Receipt`, `DATA`, `Shops` не входят; `Token` не входит).
   `[{"TerminalKey": "MerchantTerminalKey"},{"Amount": "19200"},{"OrderId": "00000"},{"Description": "Подарочная карта на 1000 рублей"}]`
2. Добавить пару `Password` («Пароль можно найти в личном кабинете интернет-эквайринга»):
   `[…,{"Password": "11111111111111"}]`
3. Отсортировать по ключу по алфавиту:
   `[{"Amount": "19200"},{"Description": "Подарочная карта на 1000 рублей"},{"OrderId": "00000"},{"Password": "11111111111111"},{"TerminalKey": "MerchantTerminalKey"}]`
4. Конкатенировать **только значения** в одну строку:
   `"19200Подарочная карта на 1000 рублей0000011111111111111MerchantTerminalKey"`
5. «Примените к строке хеш-функцию SHA-256 (с поддержкой UTF-8)» → hex (в примере — нижний регистр):
   `"72dd466f8ace0a37a1f740ce5fb78101712bc0665d91a8108c7c8a0ccd426db2"`
6. Положить результат в поле `Token` запроса. Пример итогового запроса (дословно):

```json
{
"TerminalKey": "MerchantTerminalKey",
"Amount": 19200,
"OrderId": "21090",
"Description": "Подарочная карта на 1000 рублей",
"DATA": { "Phone": "+71234567890", "Email": "a@test.com" },
"Receipt": { "Email": "a@test.ru", "Phone": "+79031234567", "Taxation": "osn", "Items": [ … ] },
"Token": "72dd466f8ace0a37a1f740ce5fb78101712bc0665d91a8108c7c8a0ccd426db2"
}
```

Правила преобразования значений: числа — как десятичная строка (`19200`), булевы — как `true`/`false` в нижнем регистре (в примере уведомления `{"Success": true}` даёт «…AUTHORIZED**true**1234567890DEMO») [док notification]. Сортировка — «по алфавиту по ключу» (в примерах порядок совпадает с побайтовым ASCII: `Amount, CardId, ErrorCode, ExpDate, OrderId, Pan, Password, PaymentId, RebillId, Status, Success, TerminalKey`). Проверка корректности токена: в ЛК в операциях есть признак `inittokenisvalid` (`true`/`false`) [док token].

Реализация (Node):

```ts
import { createHash } from 'node:crypto';
export function tbankToken(params: Record<string, unknown>, password: string): string {
  const flat = Object.entries(params).filter(([k, v]) => k !== 'Token' && v !== undefined && v !== null && typeof v !== 'object');
  flat.push(['Password', password]);
  flat.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(flat.map(([, v]) => String(v)).join(''), 'utf8').digest('hex');
}
```

### 3.3. `POST /v2/Init` — «Инициировать платеж»

Источник: https://developer.tbank.ru/eacq/api/init [док].

| Параметр | Тип | Обяз. | Лимит | Описание (дословно) |
|---|---|---|---|---|
| `TerminalKey` | String | да | ≤ 64 | «Идентификатор терминала. Выдается мерчанту в Т‑Бизнес при заведении терминала.» |
| `Amount` | Integer (int64) | да | | «Сумма в копейках. Например, 3 руб. 12коп. — это число 312.» Минимум по СБП — 10 рублей; должна равняться сумме `Receipt.Items[].Amount` |
| `OrderId` | String | да | ≤ 50 (35 для цифрового рубля) | «Идентификатор заказа в системе мерчанта. Должен быть уникальным для каждой операции.» |
| `Token` | String | да | | «Подпись запроса.» |
| `Description` | String | нет | 140 (250 — для карт и СБП, по странице) | «Описание заказа. Значение параметра будет отображено на платежной форме.» |
| `PayType` | String | нет | `O` / `T` | «O — одностадийная, T — двухстадийная»; если не передан — настройки терминала. СБП: «Только одностадийная оплата» |
| `Language` | String | нет | `ru`/`en` | по умолчанию `ru` |
| `NotificationURL` | String (URI) | нет | | «URL на веб-сайте мерчанта, куда будет отправлен POST-запрос о статусе выполнения вызываемых методов.» |
| `SuccessURL` | String (URI) | нет | | «URL на веб-сайте мерчанта, куда будет переведен покупатель в случае успешной оплаты.» |
| `FailURL` | String (URI) | нет | | «URL на веб-сайте мерчанта, куда будет переведен покупатель в случае неуспешной оплаты.» |
| `RedirectDueDate` | String (date-time) | нет | формат `YYYY-MM-DDTHH24:MI:SS+GMT`; от 1 минуты до 90 дней | Срок жизни платёжной ссылки / динамического QR СБП; если не указан — `REDIRECT_TIMEOUT` терминала или по умолчанию 24 часа (1440 минут) |
| `DATA` | Object | нет | ключ ≤ 20 симв., значение ≤ 100 симв., ≤ 20 пар | «JSON-объект с дополнительными параметрами по операции и настройками в формате `ключ:значение`.» Спецсимволы — URL-encode |
| `Receipt` | Object | нет* | | «JSON-объект с данными чека. Обязателен, если подключена онлайн-касса.» |
| `CustomerKey`, `Recurrent`, `OperationInitiatorType`, `Shops`, `DeviceType`, `DeviceOs`, `DeviceWebView`, `TinkoffPayWeb` | | нет | | не нужны для разового СБП-платежа |

Ответ (200):

| Поле | Тип | Описание |
|---|---|---|
| `Success` | Boolean | успех |
| `ErrorCode` | String | `"0"` при успехе |
| `Message` | String | сообщение |
| `Details` | String | детали ошибки |
| `TerminalKey` | String | |
| `Status` | String | статус платежа — после Init `NEW` |
| `PaymentId` | String | идентификатор платежа в Т-Бизнес (≤ 20 символов — по описанию параметра в других методах) |
| `OrderId` | String | из запроса |
| `Amount` | Integer | копейки |
| `PaymentURL` | String (URI) | ссылка на платёжную форму (для СБП можно не использовать — нужен `GetQr`) |

Пример ответа (со страницы): `{"Success": true, "ErrorCode": "0", "Message": "OK", "TerminalKey": "1234567890123456", "Status": "NEW", "PaymentId": "1234567890", "OrderId": "ORDER-123456", "Amount": 31200, "PaymentURL": "https://securepay.tinkoff.ru/form/checkout?paymentId=1234567890"}`.

### 3.4. `POST /v2/GetQr` — «Сформировать QR»

Источник: https://developer.tbank.ru/eacq/api/get-qr [док].

«Метод регистрирует QR и возвращает информацию о нем. Вызывается после метода Инициировать платеж».

| Параметр | Тип | Обяз. | Описание (дословно) |
|---|---|---|---|
| `TerminalKey` | String (≤ 64) | да | «Идентификатор терминала…» |
| `PaymentId` | String | да | «Идентификатор платежа в системе Т‑Бизнес» |
| `Token` | String | да | подпись (корневые: `TerminalKey`, `PaymentId`, `DataType`, `PaymentMethod`, `BankId` если передан) |
| `DataType` | String | нет | «Тип возвращаемых данных: `PAYLOAD` — в ответе возвращается только Payload; `IMAGE` — в ответе возвращается SVG изображение QR. Значение по умолчанию — `PAYLOAD`.» |
| `PaymentMethod` | String | нет | «Способ оплаты.» `SBP` или `DR` |
| `BankId` | String | нет | внутренний идентификатор банка; только при `DataType = PAYLOAD` — тогда «в ответе в параметре `Data` вместо функциональной платежной ссылки (payload) возвращается deeplink» |

Ответ: поле `Data` — при `PAYLOAD` платёжная ссылка (payload СБП), при `IMAGE` — SVG. **Полная схема ответа (`TerminalKey`, `OrderId`, `Success`, `PaymentId`, `ErrorCode`, `Message`, `Details`, `RequestKey`) на странице не раскрылась** — см. «Не удалось проверить». Контракт для кода: читать `Success`, `ErrorCode`, `Message`, `Data`; логировать весь ответ.

### 3.5. `POST /v2/SbpPayTest` — «Создать тестовую платежную сессию»

Источник: https://developer.tbank.ru/eacq/api/sbp-pay-test , https://developer.tbank.ru/eacq/intro/errors/test-sbp [док].

«Метод создает тестовую платежную сессию с предопределенным статусом по СБП.»

| Параметр | Тип | Обяз. | Описание (дословно) |
|---|---|---|---|
| `TerminalKey` | String (≤ 64) | да | терминал с приставкой `DEMO` |
| `PaymentId` | String (≤ 20) | да | «Идентификатор платежа в системе Т‑Бизнес.» |
| `Token` | String | да | «Подпись запроса.» |
| `IsDeadlineExpired` | Boolean | нет | «Признак эмуляции отказа проведения платежа банком по таймауту: false — эмуляция не требуется; true — требуется эмуляция.» |
| `IsRejected` | Boolean | нет | «Признак эмуляции отказа банка в проведении платежа: false — эмуляция не требуется; true — требуется эмуляция.» |

«`IsDeadlineExpired` и `IsRejected` не могут использоваться одновременно.» Ответ: 200 / 500; поля ответа на странице **не описаны**.

Сценарии [док test-sbp]:
- Успех: `Init` → `GetQr` → показать QR → `SbpPayTest {PaymentId}` → `GetState` → `Status = CONFIRMED`.
- Таймаут: … → `SbpPayTest {PaymentId, IsDeadlineExpired: true}` → `GetState` → `DEADLINE_EXPIRED`.
- Отказ: … → `SbpPayTest {PaymentId, IsRejected: true}` → `GetState` → `REJECTED`.
- Возврат: `Cancel` по успешному тестовому QR-платежу → `GetState` → `REFUNDED`.
- «При выполнении тестовых сценариев по СБП уведомления на электронную почту не поступают» (про HTTP-нотификации — не сказано).

### 3.6. `POST /v2/GetState` — «Получить статус платежа»

Источник: https://developer.tbank.ru/eacq/api/get-state [док].

Запрос: `TerminalKey` (≤ 64, обяз.), `PaymentId` (≤ 20, обяз.), `Token` (обяз.), `IP` (опц.), `GetPhone` (Boolean, опц.). Пример: `{"TerminalKey": "TBankTest", "PaymentId": "13660", "Token": "7241ac83…", "IP": "192.168.0.52"}`.

Ответ: `Success` (Boolean), `ErrorCode` (String), `Message` (String), `TerminalKey`, `Status` (String), `PaymentId`, `OrderId`, `Amount` (Number, копейки), `Params` (массив `{Key, Value}`, например `Route`, `Source`). Пример: `{"Success": true, "ErrorCode": "0", "Message": "OK", "TerminalKey": "TBankTest", "Status": "AUTHORIZED", "PaymentId": "13660", "OrderId": "21050", "Amount": 1230}`.

### 3.7. `POST /v2/CheckOrder`, `POST /v2/Cancel`

- `CheckOrder` [док https://developer.tbank.ru/eacq/api/check-order]: запрос `TerminalKey`, `OrderId` (≤ 50), `Token`; ответ `TerminalKey`, `OrderId`, `Success`, `ErrorCode`, `Message`, `Details`, `Payments[]` (`PaymentId`, `Amount`, `Status`, `RRN`, `Success`, `ErrorCode`, `Message`, `SbpPaymentId`, `SbpCustomerId`, …). Пример: `{"TerminalKey":"TBankTest","OrderId":"21057","Success":true,"ErrorCode":"0","Message":"OK","Details":"None","Payments":[{"PaymentId":"124671934","Amount":13660,"Status":"NEW","RRN":"12345678","Success":true,"ErrorCode":0,"Message":"None","SbpPaymentId":"A42631655397753A0000030011340501","SbpCustomerId":"c4494ca1…"}]}` (обратить внимание: `ErrorCode` внутри `Payments[]` — число, снаружи — строка).
- `Cancel` [док https://developer.tbank.ru/eacq/api/cancel]: запрос `TerminalKey`, `PaymentId`, `Token`; опц. `IP`, `Amount` (копейки; без него — полная сумма), `Receipt`, `Shops`, `QrMemberId`, `Route`, `Source`, `ExternalRequestId` (≤ 255, ключ идемпотентности). Ответ: `TerminalKey`, `OrderId`, `Success`, `Status`, `OriginalAmount`, `NewAmount`, `PaymentId`, `ErrorCode`, `Message`, `Details`, `ExternalRequestId`. Переходы: `NEW → CANCELED`, `AUTHORIZED → REVERSED`, `CONFIRMED → REFUNDED | PARTIAL_REFUNDED` [док cancel, https://developer.tbank.ru/eacq/scenarios/cancel_confirm].

### 3.8. Статусы платежа

Источник: https://developer.tbank.ru/eacq/intro/developer/operation-statuses [док] (дословно описания; «Конечный» — как на странице).

| Статус | Конечный | Описание |
|---|---|---|
| `NEW` | Да | начальный статус после получения запроса `Init` |
| `FORM_SHOWED` | Да | «Платежная форма загрузилась у покупателя в браузере» |
| `PREAUTHORIZING` | Нет | «Проверка платежных данных покупателя» |
| `AUTHORIZING` | Нет | «Платеж обрабатывается системой банка и платежной системой» |
| `3DS_CHECKING` | Да | «Платеж проходит проверку 3DS» |
| `3DS_CHECKED` | Нет | «Платеж успешно прошел проверку 3DS» |
| `PAY_CHECKING` | Нет | таймаут соединения / критические ошибки авторизации |
| `AUTHORIZED` | Да | «Платеж авторизован. Деньги заблокированы на счете покупателя» |
| `CONFIRMING` | Нет | «Подтверждение платежа обрабатывается системой банка и платежной системой» |
| `CONFIRM_CHECKING` | Нет | таймаут / сетевая ошибка / неизвестный статус операции |
| `CONFIRMED` | Да | «Платеж подтвержден. Деньги списаны со счета покупателя» |
| `REVERSING` | Нет | «Мерчант запросил отмену авторизованного, но еще неподтвержденного платежа» |
| `PARTIAL_REVERSED` | Да | «Частичный возврат по авторизованному платежу» |
| `REVERSED` | Да | «Полный возврат по авторизованному платежу» |
| `REFUNDING` | Нет | «Мерчант запросил отмену подтвержденного платежа» |
| `ASYNC_REFUNDING` | Нет | «Обработка возврата денег по QR» |
| `PARTIAL_REFUNDED` | Да | «Частичный возврат по подтвержденному платежу» |
| `REFUNDED` | Да | «Полный возврат по подтвержденному платежу» |
| `CANCELED` | Да | «Мерчант отменил платеж» |
| `DEADLINE_EXPIRED` | Да | «Покупатель не завершил платеж в срок жизни ссылки на платежную форму» |
| `ATTEMPTS_EXPIRED` | Да | «Покупатель превысил количество попыток открытия формы» |
| `AUTH_FAIL` | Да | «Платеж завершился ошибкой или не прошел проверку 3DS» |
| `REJECTED` | Да | «Платеж отклонен» |

Путь СБП-платежа по динамическому QR [док https://developer.tbank.ru/eacq/scenarios/payments/PCI_DSS/sbp/ , дословно]: «1. Вызовите метод Инициировать платеж. 2. Вызовите метод Сформировать QR и сгенерируйте динамический QR-код. 3. После получения QR-кода в виде картинки или ссылки отобразите картинку покупателю или перенаправьте его по ссылке. — При успешном сценарии операция перейдет в статус `CONFIRMED`, и покупатель будет перенаправлен на страницу `SuccessURL`. — При неуспешном — останется в статусе `FORM_SHOWED`, а после трех попыток неудачной оплаты перейдет в статус `REJECTED`.» Особенности СБП: «Срок оплаты: можно настроить от 1 минуты до 90 дней. Значение по умолчанию: 24 часа»; «Минимальная сумма операции: 10 рублей»; «Только одностадийная оплата»; «Возврат: частичный и полный». Итого для нашего кода: `NEW` (после Init) → `FORM_SHOWED` (после показа QR) → `CONFIRMED` | `REJECTED` | `DEADLINE_EXPIRED`; возврат → `REFUNDED`/`PARTIAL_REFUNDED`. `AUTHORIZED` в СБП-потоке не возникает (одностадийность).

### 3.9. Нотификации (`NotificationURL`)

Источник: https://developer.tbank.ru/eacq/intro/developer/notification [док].

- Отправка: «POST‑запрос на адрес `NotificationURL`», тело JSON. `NotificationURL` задаётся в ЛК (https://business.tbank.ru/oplata/main → Магазины → Терминалы → Настроить) **или** параметром `Init`.
- Отправляются при операциях «Подтвердить списание», «Отменить платеж», «Подтвердить платеж», «Провести платеж по сохраненным реквизитам», «Привязать карту» (т.е. при смене статуса на `AUTHORIZED`/`CONFIRMED`/`REVERSED`/`REFUNDED`/… — точная таблица статусов-триггеров на странице не выведена).
- Поля тела платёжного уведомления: `TerminalKey`, `OrderId`, `Success`, `Status`, `PaymentId`, `ErrorCode`, `Amount`, `CardId`, `Pan`, `ExpDate`, `RebillId`, `Token` (+ параметры `DATA` — по запросу менеджеру). Пример массива из документации: `[{"TerminalKey": "1234567890DEMO"},{"OrderId": "000000"},{"Success": true},{"Status": "AUTHORIZED"},{"PaymentId": "0000000"},{"ErrorCode": "0"},{"Amount": "1111"},{"CardId": "000000"},{"Pan": "200000******0000"},{"ExpDate": "1111"},{"RebillId": "000000"}]`.
- Проверка `Token` (дословно по шагам): 1) собрать все параметры уведомления **кроме `Token` и вложенных объектов** как пары ключ-значение; 2) добавить `{"Password": "<пароль терминала>"}`; 3) отсортировать по алфавиту по ключу — `[{"Amount": "1111"},{"CardId": "000000"},{"ErrorCode": "0"},{"ExpDate": "1111"},{"OrderId": "000000"},{"Pan": "200000******0000"},{"Password": "11111111111"},{"PaymentId": "0000000"},{"RebillId": "000000"},{"Status": "AUTHORIZED"},{"Success": true},{"TerminalKey": "1234567890DEMO"}]`; 4) конкатенировать значения — `111100000001111000000200000******0000111111111110000000000000AUTHORIZEDtrue1234567890DEMO`; 5) SHA-256 (UTF-8); 6) сравнить с полученным `Token`. Для СБП-уведомлений набор полей может отличаться (например, без `CardId`/`Pan`/`ExpDate`) — алгоритм тот же: **все** пришедшие скалярные поля, кроме `Token`.
- Ответ: «При успешной обработке уведомления вам нужно вернуть ответ `HTTP CODE = 200` с телом сообщения `OK`» (заглавные латинские буквы, без тегов). Иначе: «Сервис будет повторно отправлять его раз в час в течение 24 часов, а затем раз в сутки в течение месяца.» После — архив, доступный 90 дней для ручной переотправки.
- IP-адреса отправителя: страница ссылается на «Список внешних сетей, которые использует Т-Банк», сам список **не получен**.
- Обязательная сверка [док https://developer.tbank.ru/eacq/intro/security]: «Сверяйте параметры созданных заказов при любых способах интеграции» — сравнивать `Amount`, `OrderId`, `TerminalKey` уведомления с заказом и/или подтверждать через `GetState`.

### 3.10. Ошибки

Источник: https://developer.tbank.ru/eacq/intro/errors/error-codes [док]; формат — из примеров ответов методов: `{ "Success": false, "ErrorCode": "<код>", "Message": "<сообщение>", "Details": "<детали>" }` (HTTP 200; HTTP 500 — «внутренняя ошибка сервера»). `ErrorCode` — **строка** (`"0"` = успех).

| Код | Сообщение (дословно) | Детали |
|---|---|---|
| 0 | None (успех) | |
| 7 | «Неверный статус покупателя» | |
| 8 | «Неверный статус транзакции» | |
| 53 | «Обратитесь к продавцу» | |
| 99 | «Попробуйте повторить попытку позже» | «Банк, выпустивший карту, отклонил операцию» |
| 100 | «Попробуйте еще раз. Если ошибка повторится, обратитесь в поддержку…» | |
| 101 | «Не пройдена идентификация 3DS» | |
| 102 | «Обратитесь в поддержку, чтобы уточнить детали…» | |
| 103 | «Недостаточно средств на счете» | |
| 104 | «Ошибка выполнения рекуррента» | |
| 202 | «Терминал заблокирован» | |
| 204 | «Неверный токен. Проверьте пару `TerminalKeySecretKey`» | |
| 308 | «Сумма всех позиций в чеке должна равняться сумме всех видов оплаты» | |
| 309 | «Поле `Receipt` не должно быть пустым» | |
| 314 | «Ошибка создания кассы в Receipt Service» | |
| 315 | «Касса не найдена» | |
| 331 | «Неверный терминал» | |
| 332 | «Поле `Fee` в объекте `Shops` должно быть больше или равно 0» | |
| 333 | «Поле `Amount` в объекте `Shops` должно быть больше или равно 1» | |
| 500 | «Добавление карты к данному терминалу запрещено» | |
| 1001 | «Свяжитесь с банком» | «Свяжитесь с банком, выпустившим карту, чтобы провести платеж» |
| 1051 | «Недостаточно средств на карте» | |
| 1057 | «Покупатель запретил такие операции для своей карты» | |

Коды 400, 3001, 3004, 3016 в таблице на странице отсутствуют (по индексу сайта: серия 3000 — ошибки СБП; 3001 — «способ оплаты СБП не активирован в настройках магазина», 3016 — сумма вне диапазона «от 10 рублей до 1 миллиона рублей» — дословно не подтверждено).

### 3.11. TLS для `securepay.tinkoff.ru`

Источник: https://developer.tbank.ru/eacq/intro/certificates/ [док]: «Раньше наши API были защищены сертификатами глобальных удостоверяющих центров. В связи с изменением политики глобальных УЦ мы переходим на сертификаты Национального удостоверяющего центра Минцифры России (Russian Trusted CA).» «На переходный период мы также используем сертификаты центра Trust Asia.» «…на серверах вашей CMS/CRM должны быть установлены оба корневых сертификата». → тот же `NODE_EXTRA_CA_CERTS` (см. 1.13) с корнем Минцифры покрывает и Т-Банк.

### 3.12. Не удалось проверить (раздел 3)

- Полная схема ответа `GetQr` (кроме `Data`) и ответа `SbpPayTest`; примеры JSON для них (секции схем на страницах не раскрылись; OpenAPI YAML прочитать не удалось).
- Список IP-адресов Т-Банка для нотификаций («Список внешних сетей»).
- Примеры тел уведомлений (`notify-samples`): страница вернула только заголовки разделов; точный набор полей уведомления для СБП.
- Лимиты/ограничения по суммам для DEMO-терминала; максимум по СБП (1 000 000 ₽ — не подтверждено дословно).
- Точная таблица статусов, по которым шлются уведомления.
- Тестовая среда `rest-api-test`: конкретный текст про белый список IP получен, но процедура получения доступа — только «направьте ИНН, наименование и IP в чат ЛК».

---

## 4. Валидация MAX `initData` и номера телефона

### 4.1. Проверка `WebAppData` (initData)

Источник: https://dev.max.ru/docs/webapps/validation [док]. Алгоритм (дословно):

1. «Извлеките фрагмент из `USER_URL` — данные после символа `#`»
2. «Преобразуйте значение `WebAppData` из `key=value` в `[['key', 'value']]`»
3. «Убедитесь, что ключ `hash` присутствует в параметрах ровно один раз»
4. «Примените URL-декодирование для всех значений (`value`)»
5. «Отсортируйте массив по ключам в алфавитном порядке `a` → `z`»
6. «Сформируйте строку: `key1=value1\nkey2=value2`» (без `hash`)
7. «Вычислите `secret_key` — HMAC-SHA256('WebAppData', BOT_TOKEN)» — ключ HMAC = строка `WebAppData`, сообщение = токен бота
8. «Вычислите собственную подпись: HMAC-SHA256(secret_key, launch_params)» — ключ = `secret_key` (байты), сообщение = строка из шага 6
9. «Преобразуйте подпись из шага 8 в hex-строку» (в примере — нижний регистр, по 2 символа на байт)
10. «Если hex-строка подписи равна значению параметра `hash` — данные подлинные»

Пример URL (дословно): `https://example.com#WebAppData=chat%3D%257B%2522id%2522%253A12345%252C%2522type%2522%253A%2522DIALOG%2522%257D&ip=192.168.0.1&user=...&hash=<calculated_hash>&WebAppPlatform=web&WebAppVersion=26.2.8`

Пример строки для подписи (дословно):

```
auth_date=1771409719\nchat={"id":12345,"type":"DIALOG"}\nip=192.168.0.1\nquery_id=4c0ab423-342b-4e45-aea4-2747dbc500cd\nuser={"id":67890,"first_name":"Max","last_name":"User","username":null,"language_code":"ru","photo_url":null}
```

Замечания по примеру: `WebAppPlatform` и `WebAppVersion` — отдельные параметры фрагмента, **не** входят в `WebAppData` и в подпись; значения `chat`/`user` — JSON без пробелов; `ip` входит в подпись.

Пример кода (TypeScript, дословно со страницы):

```typescript
// Вводные параметры
const BOT_TOKEN = 'YOUR_BOT_TOKEN';
const USER_LINK = 'https://example.com#WebAppData=...&WebAppPlatform=web&WebAppVersion=26.2.8';

// Извлекаем параметры платформы из фрагмента URL
const hashParams = new URLSearchParams(new URL(USER_LINK).hash.slice(1));
const appData: string = hashParams.get('WebAppData') || '';
const platform: string = hashParams.get('WebAppPlatform') || '';
const appVersion: string = hashParams.get('WebAppVersion') || '';

const validateAppData = async (appData: string, botToken: string): Promise<boolean> => {
    // Преобразуем appData из key1=value1&key2=value2 в [["key", "value"], ["key2", "value2"]]
    const params: string[][] = appData.split('&').map((x) => x.split('='));

    // Если hash встречается больше одного раза — прерываем проверку
    if (params.filter((x) => x[0] === 'hash').length !== 1) {
        return false;
    }

    // Сохраняем хеш, который пришёл вместе с параметрами
    const originalHash = params.find((x) => x[0] === 'hash');

    // Если хеш отсутствует — валидация невозможна
    if (!originalHash || typeof originalHash[1] !== 'string') {
        return false;
    }

    // Производим URL-декодирование значений параметров
    for (const param of params) {
        param[1] = decodeURIComponent(param[1]);
    }

    // Сортируем параметры по названию ключа a -> z
    params.sort((a, b) => a[0].localeCompare(b[0]));

    // Формируем строку для подписи с разделителем \n, исключаем hash
    const launchParams = params
        .filter((x) => x[0] !== 'hash')
        .map((x) => `${x[0]}=${x[1]}`)
        .join('\n');

    // Преобразуем строку для подписи и токен бота в массивы байтов
    const encoder = new TextEncoder();
    const botTokenBytes = encoder.encode(botToken);
    const launchParamsBytes = encoder.encode(launchParams);

    // Создаём secret_key: подписываем токен бота с помощью HMAC-SHA256,
    // используя строку "WebAppData" в качестве ключа
    const launchParamsKeyBytes = await crypto.subtle.sign(
        'HMAC',
        await crypto.subtle.importKey(
            'raw',
            encoder.encode('WebAppData'),
            {
                name: 'HMAC',
                hash: {
                    name: 'SHA-256',
                },
            },
            false,
            ['sign'],
        ),
        botTokenBytes,
    );

    // Создаём подпись параметров с помощью HMAC-SHA256, используя secret_key
    const signature = await crypto.subtle.sign(
        'HMAC',
        await crypto.subtle.importKey(
            'raw',
            launchParamsKeyBytes,
            {
                name: 'HMAC',
                hash: {
                    name: 'SHA-256',
                },
            },
            false,
            ['sign'],
        ),
        launchParamsBytes,
    );

    // Переводим подпись из массива байтов в hex-формат
    const hash = Array.from(new Uint8Array(signature))
        .map(b => ('00' + b.toString(16))
        .slice(-2))
        .join('');

    // Сравниваем с полученным хешем
    return hash === originalHash[1];
};

console.log(await validateAppData(appData, BOT_TOKEN));
```

Эквивалент на `node:crypto`: `secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest(); hash = createHmac('sha256', secret).update(launchParams).digest('hex');` (прямое переложение шагов 7–9; сравнивать через `timingSafeEqual`).

Связь с Bridge [док https://dev.max.ru/docs/webapps/bridge]: `WebApp.initData` — «Строка со стартовыми параметрами в URL-кодировке. Содержит данные о пользователе и другие инициализационные данные в виде закодированной в UTF-8 строки для валидации на стороне сервера» (возвращает `string`); `WebApp.initDataUnsafe` — «Объект, который содержит данные из `initData` в виде JSON-объекта», «объект **нельзя использовать** для валидации данных». Структура `initDataUnsafe` (со страницы):

```javascript
interface InitData {
    query_id: string;
    ip?: string;
    auth_date: number;
    hash: string;
    user: { id: number; first_name: string; last_name: string; username: string; language_code: string; photo_url: string; };
    chat: { id: number; type: 'DIALOG' | 'CHAT' | 'CHANNEL'; };
    start_param: string;
}
```

`auth_date` — «Рекомендуемый интервал составляет 1 час» для отсечения устаревших данных. Подключение бриджа: `<script src="https://st.max.ru/js/max-web-app.js"></script>`, далее `window.WebApp`. Что строка `initData` **в точности равна** значению `WebAppData` из фрагмента URL — в документации явно не сказано (следует из описаний обеих страниц; при реализации сервер должен принимать `initData` от клиента и валидировать его как `WebAppData`).

### 4.2. Запрос номера телефона и проверка `hash`

Источник: https://dev.max.ru/docs/webapps/bridge, раздел «Запрос номера телефона» [док].

```javascript
window.WebApp.requestContact()
// Promise<{ phone: string; authDate: string; /* timestamp создания hash */ hash: string; }>
```

Ошибка: `{ "error": { "code": "client.request_phone.<reason>" } }`, где reason — `user_refused_provide_phone_number` (01) или `request_error` (02).

Проверка (дословно):

«Для проверки, что полученный на запрос номер телефона совпадает с номером, привязанным к аккаунту пользователя в MAX, сравните:
- Значение поля `hash`, полученное от клиента
- Значение функции `HMAC_SHA256(authDate + phone + userId, botToken)`, где:
  * `HMAC_SHA256` — стандартная для большинства языков программирования криптографическая функция
  * `authDate + phone + userId` — параметры в алфавитном порядке, используемые для вычисления хеша: сформируйте строку, объединив пары `key=value` с разделителем `\n`
  * `botToken` — токен бота, чьё мини-приложение запрашивает номер телефона пользователя

Если значения совпадают, это подтверждает, что пользователь поделился номером телефона, привязанным к его аккаунту в MAX»

«При вычислении хеша значение `phone` не должно содержать `+`: вместо `+7**********` используется `7**********`».

Что документация задаёт однозначно: ключ HMAC — `botToken` (напрямую, **без** промежуточного `secret_key` как в 4.1); сообщение — пары `key=value`, отсортированные по ключу по алфавиту, разделитель `\n`; `phone` без `+`; порядок: `authDate`, `phone`, `userId` (алфавитный).

Что документация **не описывает** (нужно проверить на реальном клиенте, реализовать конфигурируемо): (а) точные имена ключей в строке — `authDate`/`auth_date`, `userId`/`user_id`; (б) регистр hex (по аналогии с 4.1 — нижний); (в) откуда брать `userId` — в ответе `requestContact()` его нет, единственный документированный источник — `initDataUnsafe.user.id` (после валидации `initData`); (г) формат `authDate` (строка timestamp — секунды или миллисекунды).

Рекомендуемая реализация: вычислять `HMAC_SHA256(botToken, "authDate=<authDate>\nphone=<phone без +>\nuserId=<user.id>")` в hex нижнего регистра; при несовпадении — пробовать вариант с ключами `auth_date`/`user_id`; логировать, какой вариант совпал, и зафиксировать в коде. Обязательно: `phone` без `+`, `userId` — из проверенного `initData`.

### 4.3. Не удалось проверить (раздел 4)

- Точные имена ключей и регистр hex для телефонного `hash`; источник `userId` (не указан на странице).
- Формула `HMAC_SHA256(authDate + phone + userId, botToken)`: первый аргумент — сообщение, второй — ключ (по тексту «где botToken — токен бота»); в документации нет примера с числами/готовым хешем для самопроверки.
- Тождество `WebApp.initData` ≡ значение `WebAppData` из фрагмента URL.

---

## 5. Диплинки

Источники: https://dev.max.ru/docs/chatbots/bots-coding/prepare , https://dev.max.ru/help/deeplinks , https://dev.max.ru/docs/webapps/introduction [док].

### 5.1. Чат-бот: `?start=`

- Формат: `https://max.ru/<botName>?start=<payload>` — «`<botName>` — никнейм бота», `<payload>` — «дополнительные данные (до 128 символов)» [док prepare, deeplinks].
- «Если `payload` превышает 128 символов, он не будет передан боту» [док prepare]. Допустимые символы для `?start=` — **не описаны**.
- «Для получения нескольких параметров в `payload` их нужно закодировать в одну строку», например `?start=param1_value1_param2_value2` [док prepare].
- Куда приходит: событие `bot_started` (Webhook или Long Polling), пример (дословно) [док prepare]:

```json
{
    "update_type": "bot_started",
    "timestamp": 1573226679188,
    "chat_id": 1234567890,
    "user": {
        "user_id": 1234567890,
        "name": "Иван",
        "username": "ivan_petrov"
    },
    "payload": "promo_summer2025"
}
```

`payload` «может быть `null`, если не указан». В SDK: `bot.on('bot_started', ctx => ctx.startPayload)` [SDK-код]. `chat_id` из этого события — то, что нужно для `sendMessageToChat`/`ctx.reply`.

### 5.2. Мини-приложение: `?startapp=`

- Формат: `https://max.ru/<botName>?startapp=<payload>` — «`<botName>` — имя бота с прикреплённым мини-приложением», `<payload>` — «необязательный параметр с дополнительными данными (до 512 символов)» [док deeplinks, introduction].
- Ограничения `payload` [док introduction, дословно]: «до 512 символов»; «Латинские буквы: `A-Z`, `a-z`»; «Цифры: `0-9`»; «Специальные символы: `_` (подчёркивание), `-` (дефис)»; «Если payload превышает 512 символов или содержит недопустимые символы, он будет удалён из URL-ответа».
- Куда приходит: `window.WebApp.initDataUnsafe.start_param` («объект [WebAppStartParam] с данными из URL») и внутрь строки `initData` («содержит все стартовые параметры в текстовом формате») [док introduction]. В подписанной строке `WebAppData` ключ `start_param` (по структуре `InitData`); в примере строки для подписи на странице validation его нет (пример без диплинка).
- Настройка URL мини-приложения (ЛК → «Настройки»): «Длина: не более 1024 символов», «Протокол: только https://», «Допустимые символы: буквы (латиница), цифры, точка (.) и дефис (-)», «Пробелы не поддерживаются» [док introduction]. Кнопка запуска в чате — `open_app` (`Keyboard.button.openApp(text, webApp, contactId?, payload?)`, см. 1.9); связь `OpenAppButton.payload` ↔ `start_param` в документации **не описана**.

### 5.3. Шеринг: `:share`

- Формат: `https://max.ru/:share?text=<текст сообщения>` — «Диплинк `:share` открывает экран «Отправить в MAX» и позволяет пользователю поделиться заранее подготовленным контентом в выбранном чате или канале» [док introduction]; «Применяйте URL encoding для параметра `text`, если текст содержит пробелы, спецсимволы или эмодзи» [док deeplinks].
- Поддержка клиентов: iOS 2.7.0+, Android 2.9.0+ [док deeplinks]. Лимит длины `text` — **не описан**.

### 5.4. Не удалось проверить (раздел 5)

- Допустимые символы `?start=` payload; поведение при недопустимых символах.
- Лимит длины `text` в `:share`.
- Как `OpenAppButton.payload` попадает в мини-приложение (`start_param`?).
- Есть ли `payload` в `bot_stopped` на стороне сервера (в типах SDK есть, в документации не найдено).

---

## Приложение А. Сводка URL-источников

MAX: https://dev.max.ru/docs-api · https://dev.max.ru/docs-api/methods/POST/messages · …/PUT/messages · …/POST/answers · …/POST/uploads · …/GET/updates · …/POST/subscriptions · …/GET/me · …/PATCH/me/commands · https://dev.max.ru/docs-api/objects/Update · …/objects/Message · https://dev.max.ru/docs-api/changelog-api · https://dev.max.ru/docs/chatbots/bots-coding/js · https://dev.max.ru/docs/chatbots/bots-coding/prepare · https://dev.max.ru/help/deeplinks · https://dev.max.ru/help/events · https://dev.max.ru/docs/webapps/introduction · https://dev.max.ru/docs/webapps/validation · https://dev.max.ru/docs/webapps/bridge · https://registry.npmjs.org/@maxhub/max-bot-api/-/max-bot-api-0.3.1.tgz · https://raw.githubusercontent.com/max-messenger/max-bot-api-client-ts/main/{readme.md,CHANGELOG.md,docs/04-keyboard.md,docs/06-sessions-and-scenarios.md,docs/09-sdk-concepts.md} · https://github.com/max-messenger/max-bot-api-client-ts/releases · https://github.com/max-messenger/max-bot-api-client-ts/issues/216 · https://pkg.go.dev/github.com/max-messenger/max-bot-api-client-go/schemes · https://nodejs.org/api/cli.html

ЮKassa: https://yookassa.ru/developers/using-api/interaction-format · https://yookassa.ru/developers/using-api/response-handling/response-format · https://yookassa.ru/developers/using-api/webhooks · https://yookassa.ru/developers/using-api/openapi-specification · https://yookassa.ru/developers/api (?lang=ru / ?lang=en) · https://yookassa.ru/developers/payment-acceptance/getting-started/quick-start · https://yookassa.ru/developers/payment-acceptance/getting-started/payment-process · https://yookassa.ru/developers/payment-acceptance/getting-started/payment-methods · https://yookassa.ru/developers/payment-acceptance/testing-and-going-live/testing · https://yookassa.ru/developers/payment-acceptance/integration-scenarios/manual-integration/bank-card · https://registry.npmjs.org/@a2seven/yoo-checkout

Т-Банк: https://developer.tbank.ru/eacq/intro · https://developer.tbank.ru/eacq/intro/developer/token · https://developer.tbank.ru/eacq/intro/developer/notification · https://developer.tbank.ru/eacq/intro/developer/operation-statuses · https://developer.tbank.ru/eacq/intro/developer/terminal · https://developer.tbank.ru/eacq/intro/developer/openapi · https://developer.tbank.ru/eacq/intro/certificates/ · https://developer.tbank.ru/eacq/intro/security · https://developer.tbank.ru/eacq/intro/errors/test · https://developer.tbank.ru/eacq/intro/errors/test-cases · https://developer.tbank.ru/eacq/intro/errors/test-sbp · https://developer.tbank.ru/eacq/intro/errors/error-codes · https://developer.tbank.ru/eacq/api/init · …/api/get-qr · …/api/sbp-pay-test · …/api/get-state · …/api/check-order · …/api/cancel · …/api/sbp · https://developer.tbank.ru/eacq/scenarios/payments/PCI_DSS/sbp/ · https://developer.tbank.ru/eacq/scenarios/cancel_confirm · https://www.tbank.ru/business/help/business-payments/internet-acquiring/how-use/terminal/
