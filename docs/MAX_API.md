# MAX_API.md — что платформа MAX реально умеет (сводка для проектирования)

Дата: 20.09.2026. Все факты — из официальной документации https://dev.max.ru и официальных SDK.
Метки: **[док]** — страница dev.max.ru; **[SDK]** — типы/код официальных клиентов (`@maxhub/max-bot-api` 0.3.1,
`@maxhub/max-ui` 0.5.0, Go-клиент); **[нет]** — искали, в документации отсутствует; **[допущение]** — наш вывод.
Полные разборы с цитатами и всеми ссылками — `../research/max_bot_api.md` и `../research/max_miniapps.md`.

---

## 1. Архитектурные факты, от которых зависит продукт

| # | Факт | Следствие для нас | Источник |
|---|---|---|---|
| 1 | База `https://platform-api2.max.ru`, токен только в заголовке `Authorization: <token>`; для TLS нужен корневой сертификат Минцифры в доверенных | В Docker-образ кладём сертификат Минцифры (или используем официальный SDK, где это учтено); в README — отдельный пункт | [док] https://dev.max.ru/docs-api |
| 2 | Получение событий: **Webhook** `POST /subscriptions` (только HTTPS:443, доверенный CA или Минцифры, self-signed нельзя, ответ 200 за 30 с, секрет в `X-Max-Bot-Api-Secret`, автоотписка через 8 ч неудач) **или** **Long Polling** `GET /updates` (документация: «не подходит для production»). Одновременно — запрещено | Для MVP и проверки жюри — **Long Polling** (запускается одной командой в Docker без домена). Webhook — как опция через `.env` (`MAX_MODE=webhook`), если будет VPS с доменом и Let's Encrypt. В README честно указать | [док] https://dev.max.ru/docs-api/methods/POST/subscriptions , …/GET/updates |
| 3 | Лимиты: 30 rps на API; 2 сообщения/с в один чат; текст ≤ 4000 симв.; ≤ 12 вложений; клавиатура ≤ 210 кнопок (30 рядов × 7; в ряду ≤ 3 для link/open_app/geo/contact); ≤ 32 команды | Очередь отправки с троттлингом 2 msg/s на чат; длинные списки — пагинация через callback | [док] https://dev.max.ru/docs-api |
| 4 | **Бот не может создать чат** и не может добавить участников (метод `POST /chats/{chatId}/members` удаляется 30.09.2026). Кнопки `chat` и события `message_chat_created` в MAX **нет** | Второго участника в сценарий приводим **диплинком** `https://max.ru/<bot>?start=<payload>` или `?startapp=<payload>`, либо пользователи сами добавляют бота в свою группу | [док] https://dev.max.ru/docs-api/changelog-api ; [нет] |
| 5 | Бот **не может написать пользователю первым**: `chat_id` диалога появляется только из событий (`bot_started` и др.) | Уведомить контрагента можно только после того, как он хотя бы раз открыл бота (по диплинку). Это надо заложить в сценарий: «клиент нажал ссылку → теперь получает статусы» | [док] https://dev.max.ru/docs-api (раздел о chat_id); [допущение] |
| 6 | Диплинки: `?start=<payload>` (≤128 симв., приходит в `bot_started.payload`); `?startapp=<payload>` (≤512 симв., `A-Za-z0-9_-`, приходит в `initDataUnsafe.start_param`); `https://max.ru/:share?text=…` открывает экран «Отправить в MAX» | Ключевой рельс для «второго участника» и для шеринга. Payload — только непрозрачные одноразовые идентификаторы | [док] https://dev.max.ru/docs/chatbots/bots-coding/prepare , https://dev.max.ru/help/deeplinks |
| 7 | Мини-приложение = HTTPS-страница, URL которой привязывается к боту в кабинете business.max.ru/self (для хакатона — через форму организаторов). Через API URL не задать. Открывается: кнопкой в профиле/чате бота, inline-кнопкой `open_app` (`web_app`, `contact_id`, `payload`), диплинком `?startapp` | Нужен **стабильный HTTPS-URL с самого начала** (домен/VPS или GitHub Pages для статики). Смена URL = повторная форма организаторам | [док] https://dev.max.ru/docs/webapps/introduction , https://dev.max.ru/help/miniapps |
| 8 | MAX Bridge — **не npm-пакет**, а скрипт `https://st.max.ru/js/max-web-app.js` → `window.WebApp`. `initData` подписан HMAC-SHA256 (алгоритм как в Telegram: `secret = HMAC('WebAppData', BOT_TOKEN)`, `hash = HMAC(secret, "k=v\n…")`) | Бэкенд валидирует `initData` по официальному алгоритму — это и есть авторизация в мини-приложении без логина/пароля. Срок жизни `auth_date` не задан — ограничиваем сами (напр. 24 ч) | [док] https://dev.max.ru/docs/webapps/bridge , https://dev.max.ru/docs/webapps/validation |
| 9 | В Bridge **нет** `sendData`, `MainButton`, `close()`, `openInvoice`, `themeParams` | Связь мини-приложение → бот только через наш бэкенд (webapp → API → Bot API `POST /messages`). Кнопка действия — своя, внизу экрана. Тема — через MAX UI (`prefers-color-scheme`) | [нет] |
| 10 | **Платежей в MAX нет**: ни в Bot API, ни в Bridge, ни в changelog, ни на business.max.ru. Оплата = внешняя ссылка (`link`-кнопка / `openLink`) на страницу провайдера | Мы формируем ссылку/QR через эквайринг (песочница), плательщик платит в браузере/банке, статус — вебхуком провайдера. Мы денег не касаемся | [нет] см. research/max_bot_api.md §8 |
| 11 | Телефон пользователя — только через кнопку `request_contact` (вложение `contact` с `hash = HMAC-SHA256(token, vcf_info)`) или `WebApp.requestContact()` (`hash = HMAC_SHA256(authDate+phone+userId, botToken)`) | Верифицированный телефон без SMS — годится как «подпись» стороны в договорённости и как реквизит для чека/акта | [док] https://dev.max.ru/docs-api , …/webapps/bridge |
| 12 | `POST /answers` по `callback_id` **обновляет сообщение на месте** (текст + клавиатура). В личных чатах сообщения с inline-клавиатурой редактируемы всегда | «Живая карточка» сделки/смены/заказа в чате: одно сообщение, статус меняется на месте, без спама | [док] https://dev.max.ru/docs-api/methods/POST/answers , …/PUT/messages |
| 13 | Форматирование markdown/html: жирный, курсив, `^^выделение^^`, заголовки, цитаты, упоминания `[Имя](max://user/id)`, моноширинный | Карточки документов читаемы прямо в чате | [док] https://dev.max.ru/docs-api |
| 14 | Вложения: image/video/audio/file (через `POST /uploads` + token; после загрузки — пауза, иначе `attachment.not.ready`), contact, location, share, sticker | PDF акта/счёта — вложение `file`; чек — `image`/`file` от пользователя | [док] https://dev.max.ru/docs-api/methods/POST/uploads |
| 15 | Групповые чаты: бот получает `bot_added`, `user_added/removed`, `message_created`, `message_callback`; шлёт по `chat_id`; список участников — только если бот админ; закреп/переименование/описание чата. Добавление бота в группы по умолчанию **запрещено** в настройках бота | Групповые сценарии возможны, но что бот видит в группе без прав админа — не описано. Настройку «разрешить добавление в группы» держат организаторы (кабинет у них) → **не закладывать группы в основной сценарий** | [док] https://dev.max.ru/docs/chatbots/bots-create/manage ; [нет] |
| 16 | Ник бота изменить нельзя; любое изменение данных бота — повторная модерация до 48 рабочих часов | Имя/описание бота — как есть; узнать ник: `GET /me` | [док] https://dev.max.ru/docs/chatbots/bots-create/manage |
| 17 | Каналы + комментарии к постам (`/messages/{id}/comments`, события `comment_*`, август 2026) | Возможный рельс для «предзаказ в канале» | [док] https://dev.max.ru/docs-api/changelog-api |
| 18 | Официальные SDK: **TS/JS `@maxhub/max-bot-api` 0.3.1** (03.09.2026), **Go** клиент v1.7.1 + фреймворк `maxbot`; Python `maxapi` — «неофициальная, форк проверен командой MAX», обновлялась июль 2025 | Бэкенд бота — **Node/TypeScript на официальном SDK** (регламент тоже советует JS/React). Python — риск отставания от API v2 | [док] https://dev.max.ru/docs/chatbots/bots-coding/js |
| 19 | MAX UI `@maxhub/max-ui` 0.5.0 (15.09.2026): ESM, peer `react 19.2.8`/`react-dom 19.2.8` (точно), `<MaxUI platform colorScheme>`; компоненты Button, IconButton, Cell*, Input, Textarea, Switch, Radio, Counter, Spinner, Avatar, Typography, Panel/Container/Flex/Grid. **Нет** модалок, табов, шапки, тостов, Select/Checkbox | Мини-приложение: React 19.2.8 + Vite + MAX UI; недостающие элементы — свои на токенах MAX UI | [SDK] research/max_miniapps.md §3 |
| 20 | Токены MAX UI (из `styles.css`): акцент `#007aff`; light фон `#fff / #f5f7fa / #edeef2`, текст `#060708`; dark фон `#17181c / #25262d / #0f0f12`, текст `#fff`; negative `#ff303c`/`#ce4257`; positive `#1abe43`/`#2bc644`; радиусы кнопок 8/12/16/20, карточка 16, spacing 2–24; шрифт системный (SF/Roboto) | База для `DESIGN.md` (шаг 10) | [SDK] |

---

## 2. Bot API — краткий справочник методов

Полный перечень с полями — `../research/max_bot_api.md` §2.

- **Bots:** `GET /me`; `PATCH /me/commands` (меню «/», ≤ 32).
- **Messages:** `POST /messages?user_id|chat_id` (NewMessageBody: `text`, `attachments[]`, `link {reply|forward, mid}`, `notify`, `format markdown|html`); `PUT /messages?message_id`; `DELETE /messages`; `GET /messages`, `GET /messages/{id}`; `POST /answers?callback_id` (ответ на кнопку, обновление на месте); `GET /videos/{token}`.
- **Chats:** `GET /chats/{id}`, `PATCH /chats/{id}` (title, icon, description), `POST /chats/{id}/actions` (`typing_on`…), `GET|PUT|DELETE /chats/{id}/pin`, `GET|DELETE /chats/{id}/members/me`, `GET /chats/{id}/members` (админ), `GET|POST /chats/{id}/members/admins`, `DELETE …/admins/{userId}`, `DELETE /chats/{id}/members`. Удалены/удаляются: `GET /chats` (июнь 2026), `POST /chats/{id}/members` (30.09.2026).
- **Comments (каналы):** `GET|POST|PUT|DELETE /messages/{id}/comments`, `GET …/comments/{commentId}`.
- **Subscriptions:** `GET|POST|DELETE /subscriptions`; `GET /updates` (long polling: `limit` 1–1000, `timeout` 0–90, `marker`, `types`).
- **Uploads:** `POST /uploads?type=image|video|audio|file` → URL → загрузка → `token`.

**События (update_type):** `bot_started {chat_id, user, payload?, user_locale?}`, `bot_stopped`, `bot_added/removed {chat_id, user, is_channel}`, `message_created {message, user_locale?}`, `message_edited`, `message_removed`, `message_callback {callback {callback_id, payload, user}, message?}`, `user_added/removed`, `chat_title_changed`, `dialog_cleared/muted/unmuted/removed`, `comment_created/edited/removed`.

**Кнопки inline-клавиатуры:** `callback {text, payload}`, `link {text, url}`, `request_contact {text}`, `request_geo_location {text, quick?}`, `open_app {text, web_app?, contact_id?, payload?}`, `message {text}`, `clipboard {text, payload}`.

**Объект User:** `user_id, first_name, last_name?, username?, is_bot, last_activity_time?`; телефона нет.

---

## 3. Мини-приложения — краткий справочник Bridge

`window.WebApp`: `initData` (строка для валидации), `initDataUnsafe {query_id, auth_date, hash, ip?, user{id, first_name, last_name, username, language_code, photo_url}, chat{id, type DIALOG|CHAT|CHANNEL}, start_param}`, `platform` (`ios|android|desktop|web`), `version`, `deviceName`, `getLaunchContext()` → `{entryPoint: 'tabbar'|'default'}`.

Методы: `requestContact()` → `{phone, authDate, hash}`; `openLink(url)` (внешний браузер, требует клика); `openMaxLink(url)` (диплинк max.ru внутри MAX); `downloadFile(url, name)`; `shareContent({text?, link?})`, `shareMaxContent({text?, link?} | {mid, chatType})`; `openCodeReader(fileSelect?)` → строка QR; `BackButton.show/hide/onClick/offClick/isVisible`; `enableClosingConfirmation()/disable…`; `getViewportSize()`; `requestScreenMaxBrightness()/restore…`; `ScreenCapture.enable/disable`; `DeviceStorage`/`SecureStorage` (get/set/remove/clear; ≤10 ключей; только mobile); `BiometricManager` (mobile); `HapticFeedback.impactOccurred/notificationOccurred/selectionChanged` (mobile); `NfcManager` (Android).

Ошибки — `reject({error: {code}})`.

---

## 4. Возможности для платформенного бонуса (+0,15)

Критерий бонуса: возможность **сверх минимума**, органично встроена, создаёт ценность, работает от начала до результата, описана. Кандидаты, ранжированные по «ценность для бизнес-сценария × заметность для жюри»:

1. **Диплинк с payload как «приглашение второго участника»** (`?start=deal_…` / `?startapp=…`) + `shareMaxContent`/`:share` для отправки приглашения в существующий чат — превращает бота из однопользовательского в двусторонний. [док]
2. **Мини-приложение с серверной валидацией `initData`** — авторизация без логина; плюс `requestContact()` с HMAC-проверкой телефона как «подпись стороны». [док]
3. **Живая карточка через `POST /answers`** — статус объекта обновляется в том же сообщении у обеих сторон. [док]
4. **`openCodeReader()`** — сканирование QR (чек-ин на смене, сканирование чека/счёта). [док]
5. **`request_geo_location` + `location`** — геометка отметки на объекте. [док]
6. **`clipboard`-кнопка** — реквизиты/номер счёта в один тап. [док]
7. **`PATCH /me/commands`** — меню команд; `typing_on` — отзывчивость. [док]
8. **Каналы + комментарии** — если сценарий про предзаказы. [док]
9. **HapticFeedback / BackButton / DeviceStorage** в мини-приложении — «нативность». [док]

Правило: в MVP закладываем **одну** связку (п.1 + п.2 или п.1 + п.3), делаем её сквозной и описываем в README/презентации как «расширенное использование возможностей MAX».

---

## 5. Чего в MAX нет (чтобы не спроектировать лишнего)

- Платёжного API, инвойсов, кошелька, `openInvoice` — **[нет]**.
- Создания чатов ботом, добавления участников (с 30.09.2026), кнопки `chat` — **[нет]**.
- `sendData` из мини-приложения в бота; `MainButton`; `close()`; `themeParams` — **[нет]**.
- Инициативного первого сообщения пользователю — **[нет]** (только после события от пользователя).
- API рассылок/уведомлений по номеру телефона для разработчиков — **[нет]** (продукт business.max.ru без публичного API; массовые рассылки через API запрещены правилами без договора).
- Официального Python SDK, React/Vite-шаблона мини-приложения — **[нет]**.
- Записей changelog за 2025 год — на страницах только 2026 (июнь–сентябрь).

---

## 6. Не удалось проверить

- Прямой вызов API (`GET /me`) из этой среды — хост `platform-api2.max.ru` закрыт сетевым прокси и из контейнера, и из оболочки на вашем компьютере. Ник бота и его ссылку узнаем при первом запуске кода (или вы выполните в Терминале: `cd "~/Desktop/Max bot 2026" && set -a && . ./.env && curl -H "Authorization: $MAX_BOT_TOKEN" https://platform-api2.max.ru/me`).
- Как для хакатонного бота включено/выключено добавление в группы и какая кнопка мини-приложения выбрана — кабинет у организаторов.
- Что бот видит в группе без прав администратора.
- Срок жизни `auth_date` в initData; минимальные версии клиентов для биометрии/NFC/хранилищ.
- Storybook MAX UI и Figma-гайдлайн (`MAXUI-Figma.fig`) — не открывались; токены взяты из `styles.css` пакета 0.5.0 (для DESIGN.md этого достаточно, Figma сверим на шаге 10).
