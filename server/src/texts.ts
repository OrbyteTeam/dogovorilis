// Единственное место, где живут тексты бота и уведомлений.
// Правила языка: docs/DESIGN_BRIEF.md §2 (разделители, суммы, даты, статусы, тон, словарь, кнопки), §3 (карточка),
// §4 (уведомления). Эталон перечня сообщений: docs/SPEC.md §6. Никаких длинных и коротких тире, «·» и «•» в
// текстах: это проверяет test/texts.test.ts разбором исходника, комментарии проверка не трогает.
//
// Модуль намеренно «чистый»: из зависимостей только доменные типы и форматтеры, никакого config,
// БД и SDK. Так тексты проверяются юнит-тестами без окружения, а часовой пояс берётся по умолчанию
// из domain/time.ts (APP_TIMEZONE подставляется на уровне транспорта, если когда-то понадобится).

import type { CancelRule, CardRole, DealStatus, PaymentProvider, PaymentRail, PaymentStatus, ReminderKind, Role, TermsField } from './types.js';
import { formatMoney, formatPercent, prepaymentPercent } from './domain/money.js';
import {
  formatDateTime,
  formatDayMonthShort,
  formatMoment,
  formatTime,
  formatWeekdayDay,
  listDateTime,
  zoneLabel,
  zoneOnce,
} from './domain/time.js';

// --- инфраструктура ---

// Обратный слэш экранируем тоже: иначе пользовательский «\*» превратится в наш же escape-символ.
const ESCAPE_RE = /[\\*_`[\]^~>#]/g;

/** Экранирование ЛЮБОГО пользовательского текста перед вставкой в markdown: * _ ` [ ] ^ ~ > # (SPEC §6). */
export function esc(text: string): string {
  return text.replace(ESCAPE_RE, (ch) => `\\${ch}`);
}

/** Цитата для N3/N11: каждая строка с префиксом «> ». Текст внутри уже должен быть экранирован. */
export function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
}

/** Пользовательский текст в одну строку: переносы ломают лимит строк карточки. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Первая буква строчная: статус после «Статус:» и фраза после двоеточия. */
function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

function upperFirst(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Как прошла оплата, словами после «получена»: «переводом по реквизитам», «по ссылке ЮKassa» (DESIGN_BRIEF §3.1).
 * Пометка теста идёт отдельной строкой, см. railTestLine.
 */
export function railHow(rail: PaymentRail, provider: PaymentProvider): string {
  if (rail === 'transfer') return 'переводом по реквизитам';
  if (provider === 'yookassa') return 'по ссылке ЮKassa';
  if (provider === 'tbank') return 'по ссылке Т-Банка';
  return 'по ссылке';
}

/** Отдельная строка о тестовой среде платежа, который уже прошёл; для перевода её нет (SPEC §18). */
export function railTestLine(rail: PaymentRail, provider: PaymentProvider): string | null {
  if (rail !== 'link') return null;
  if (provider === 'yookassa') return '🧪 Тестовый магазин, деньги не списывались';
  if (provider === 'tbank') return '🧪 DEMO-терминал Т-Банка, деньги не списывались';
  return null;
}

/** Демо-карточка клиента (SPEC §12, DESIGN_BRIEF §3.2): первая строка, чтобы её нельзя было спутать с настоящей. */
export const DEMO_CARD_PREFIX = '🧪 **Демо: так видит клиент**';

/** В демо обе стороны сидят в одном чате, поэтому уведомление помечается получателем (SPEC §12). */
export function demoNotifyPrefix(to: 'seller' | 'client'): string {
  return to === 'client' ? '🧪 (клиенту) ' : '🧪 (исполнителю) ';
}

// --- команды для setMyCommands (SPEC §6.1) ---

/** `name` без слэша: так его ждёт `PATCH /me/commands` (CONTRACTS §1). */
export const COMMANDS: readonly { name: string; description: string }[] = [
  { name: 'start', description: 'Главное меню' },
  { name: 'new', description: 'Новая сделка' },
  { name: 'deals', description: 'Сделки' },
  { name: 'settings', description: 'Настройки' },
  { name: 'help', description: 'Как это работает' },
  { name: 'cancel', description: 'Отменить ввод' },
];

// --- меню, помощь, общее ---

/** Единственная фраза со словом «договорённость», кроме названия продукта (DESIGN_BRIEF §2.7). */
export const S1 = `Это «Договорились»: карточка договорённости прямо в чате MAX.

Вы описываете, что, когда и за сколько, клиент подтверждает одной кнопкой. Предоплата, статус, напоминания, чек и квитанция здесь же, у обеих сторон.

Что дальше?`;

export function S2(sellerName: string): string {
  return `Исполнитель **${esc(sellerName)}** предлагает сделку. Проверьте условия и подтвердите или предложите изменения.`;
}

/** «Повторить сделку» с тем же клиентом (ЗАДАЧА_04 F): карточка приходит клиенту сама, без ссылки; над ней это приветствие. */
export function S2_REPEAT(sellerName: string): string {
  return `Исполнитель **${esc(sellerName)}** предлагает новую сделку. Проверьте условия и подтвердите.`;
}

/** Исполнителю: карточка повторной сделки ушла клиенту в его чат с ботом. */
export function REPEAT_CARD_SENT(clientName: string): string {
  return notice(`📨 Карточка отправлена клиенту (${esc(clientName)}).`, 'Ждём подтверждения.');
}

/** Карточку повторной сделки клиенту доставить не удалось (MAX не ответил): ссылка откроет её у него. */
export function REPEAT_CARD_FAILED(clientName: string, link: string): string {
  return `Не получилось отправить карточку клиенту (${esc(clientName)}). Перешлите ему ссылку, карточка откроется у него: ${link}`;
}

export const S3 = 'Я понимаю только кнопки и команды. Откройте /deals или /new';

/**
 * Исполнитель открыл собственную ссылку на сделку. Карточки у него уже есть и правятся на месте,
 * поэтому без этой строки нажатие ссылки выглядело бы как «ничего не произошло» (SPEC §14 п. 6).
 */
export function S4(id: string, demo: boolean): string {
  // В демо-сделке клиент сам исполнитель, поэтому кнопок шеринга в её карточке нет
  // и звать по этой ссылке некого: посторонний получит E4. Не отправляем человека искать
  // кнопки, которых он не найдёт.
  if (demo) {
    return `Это ваша демо-сделка #${id}, клиент в ней вы сами. Чтобы позвать настоящего клиента, создайте обычную сделку: «${BTN.newDeal}»`;
  }
  return `Это ваша сделка #${id}, вы её исполнитель. Чтобы пригласить клиента, отправьте ему ссылку кнопкой «${BTN.sendToMax}» или «${BTN.copyLink}» в карточке`;
}

export const H1 = `Как это работает
1. Исполнитель создаёт сделку: что, когда, сколько, предоплата, правило отмены.
2. Отправляет ссылку клиенту в любой чат MAX.
3. Клиент подтверждает условия кнопкой и вносит предоплату по ссылке или переводом.
4. После выполнения клиент принимает работу и оплачивает остаток.
5. Исполнитель прикладывает чек, обе стороны получают квитанцию PDF.
Деньги идут напрямую исполнителю. Мы не платёжный агент и не храним реквизиты карт.
🧪 Тестовый режим: оплата по ссылке проходит через тестовый магазин, реальные деньги не списываются.`;

export const INPUT_CANCELLED = 'Ввод отменён';

// BTN объявлен ниже, а константы вычисляются при загрузке модуля, поэтому подписи кнопок здесь литералами.
export const NEW_DEAL_PROMPT = `Новая сделка: заполните форму в мини-приложении, условия под себя.
Посмотреть продукт за две минуты:
«🧪 Демо: пройти одному»: обе стороны в этом чате.
«Пример: позвать клиента»: готовая сделка, ссылку можно сразу отправить второму человеку.`;

/** Экран «🧪 Попробовать» из меню (ЗАДАЧА_04 A3). */
export const TRY_PROMPT = `Два способа посмотреть продукт за две минуты.
«🧪 Демо: пройти одному»: обе карточки придут сюда, вы нажимаете и за исполнителя, и за клиента.
«Пример: позвать клиента»: настоящая сделка с готовыми условиями. Отправьте ссылку второму человеку, он подтвердит у себя.`;

/** То же без демо (DEMO_MODE=false): остаётся одна сделка-пример. */
export const TRY_PROMPT_NO_DEMO = `Посмотреть продукт за две минуты: «Пример: позвать клиента». Это настоящая сделка с готовыми условиями. Отправьте ссылку второму человеку, он подтвердит у себя.`;

/**
 * Текст приглашения для шеринга без ссылки: ссылка передаётся отдельно (`shareMaxContent({ text, link })`),
 * иначе в сообщении она оказывается дважды (ЗАДАЧА_04 A1). Текст не markdown, экранировать не нужно.
 */
export function shareInvite(title: string, scheduledAt: Date | null): string {
  const what = oneLine(title);
  return scheduledAt ? `Подтвердите условия: ${what}, ${formatDateTime(scheduledAt)}` : `Подтвердите условия: ${what}`;
}

// --- «/deals» в чате (ЗАДАЧА_04 A2) ---

export const DEALS_HEADER = 'Активные сделки, время МСК';
export const DEALS_SELLER = '**Вы исполнитель**';
export const DEALS_CLIENT = '**Вы клиент**';
export const DEALS_EMPTY = 'Активных сделок нет. Создайте первую, это займёт полминуты';

export function DEALS_MORE(n: number): string {
  return `…и ещё ${n}, смотрите «${BTN.myDeals}»`;
}

type DealsRow = { title: string; scheduledAt: Date | null; totalKopecks: number; status: DealStatus; role: 'seller' | 'client'; demo: boolean };

/** `пн 28 сен, 14:00, [Маникюр с покрытием](ссылка), 2 500 ₽, ждём предоплату`: факты через запятую, статус последним. */
export function dealsLine(row: DealsRow, link: string, now = new Date()): string {
  const parts = [
    row.scheduledAt ? listDateTime(row.scheduledAt, undefined, now) : 'без даты',
    `[${esc(oneLine(row.title))}](${link})`,
    formatMoney(row.totalKopecks),
    statusShort(row.status, row.role),
  ];
  if (row.demo) parts.push('демо');
  return parts.join(', ');
}

/** Подпись кнопки под списком: «Пн 28 сен, 14:00, Маникюр…». Длинное название обрезается: MAX режет подписи сам. */
export function dealsButton(row: Pick<DealsRow, 'title' | 'scheduledAt'>, now = new Date()): string {
  const when = row.scheduledAt ? listDateTime(row.scheduledAt, undefined, now) : 'без даты';
  return upperFirst(`${when}, ${clip(oneLine(row.title), 18)}`);
}

/** Ответ на «Пример: позвать клиента» (ЗАДАЧА_03 B). */
export function EXAMPLE_CREATED(id: string): string {
  return `Создана сделка #${id} с готовыми условиями. Это настоящая сделка: отправьте ссылку клиенту, он увидит карточку и сможет подтвердить. Свои условия: «${BTN.newDeal}».
Карточка ниже, ссылка и кнопки «${BTN.sendToMax}» и «${BTN.copyLink}» в ней.`;
}

export function DEMO_CREATED(id: string, link: string): string {
  return `🧪 Создана демо-сделка #${id}. Ниже две карточки: как видите её вы и как видит клиент.\nСсылка клиента: \`${link}\``;
}

export const TOO_MANY_TRIALS = 'Слишком много пробных сделок: не больше 5 в час. Подождите немного';

export const DEAL_FINISHED_LINE = 'Сделка завершена';

/** Старое сообщение карточки после того, как она показана заново внизу чата. */
export function CARD_MOVED(id: string): string {
  return `↓ Карточка #${id} ниже, это актуальная версия`;
}

// --- статусы ---

const STATUS_EMOJI: Record<DealStatus, string> = {
  awaiting_confirmation: '⏳',
  changes_requested: '✏️',
  declined: '⛔',
  expired: '⌛',
  awaiting_prepayment: '💳',
  scheduled: '📅',
  awaiting_acceptance: '🔍',
  remarks: '⚠️',
  awaiting_payment: '💳',
  paid: '🧾',
  closed: '✅',
  cancelled: '🚫',
};

export function statusEmoji(status: DealStatus): string {
  return STATUS_EMOJI[status];
}

type StatusArgs = { prepaymentKopecks: number; remainingKopecks: number; scheduledAt: Date | null };

// По одному тексту на пару (статус, роль): DESIGN_BRIEF §2.5. У стороны, от которой ждут действие, статус
// начинается с глагола; у другой стороны это констатация. Демо-клиент читает клиентские тексты.
const STATUS_TEXT: Record<DealStatus, (a: StatusArgs) => { seller: string; client: string }> = {
  awaiting_confirmation: () => ({
    seller: 'Ждём подтверждения клиента',
    client: 'Подтвердите условия',
  }),
  changes_requested: () => ({
    seller: 'Клиент предложил изменения. Измените условия или оставьте как есть',
    client: 'Ждём новые условия от исполнителя',
  }),
  declined: () => ({
    seller: 'Клиент отказался от сделки',
    client: 'Вы отказались от сделки',
  }),
  expired: () => ({
    seller: 'Срок подтверждения истёк (72 ч)',
    client: 'Срок подтверждения истёк (72 ч)',
  }),
  awaiting_prepayment: (a) => ({
    seller: `Ждём предоплату ${formatMoney(a.prepaymentKopecks)}`,
    client: `Внесите предоплату ${formatMoney(a.prepaymentKopecks)}`,
  }),
  scheduled: (a) => {
    const agreed = a.scheduledAt ? `Всё согласовано на ${formatDateTime(a.scheduledAt)}` : 'Всё согласовано';
    return { seller: `${agreed}. Отметьте «Выполнено», когда закончите`, client: `${agreed}. Ждём выполнения` };
  },
  awaiting_acceptance: () => ({
    seller: 'Ждём приёмку клиентом',
    client: 'Примите работу или оставьте замечания',
  }),
  remarks: () => ({
    seller: 'Клиент оставил замечания. Исправьте и нажмите «Исправлено»',
    client: 'Ждём исправлений от исполнителя',
  }),
  awaiting_payment: (a) => ({
    seller: `Ждём остаток ${formatMoney(a.remainingKopecks)}`,
    client: `Оплатите остаток ${formatMoney(a.remainingKopecks)}`,
  }),
  paid: () => ({
    seller: 'Оплачено. Приложите чек',
    client: 'Оплачено. Ждём чек от исполнителя',
  }),
  closed: () => ({
    seller: 'Сделка закрыта, квитанция отправлена',
    client: 'Сделка закрыта, квитанция отправлена',
  }),
  cancelled: () => ({
    seller: 'Сделка отменена',
    client: 'Сделка отменена',
  }),
};

export function statusText(status: DealStatus, role: CardRole, a: StatusArgs): string {
  const pair = STATUS_TEXT[status](a);
  return role === 'seller' ? pair.seller : pair.client;
}

// Короткая форма для строк списков, расписания и плашек (DESIGN_BRIEF §2.5, ЗАДАЧА_04 A2).
const STATUS_SHORT: Record<DealStatus, { seller: string; client: string }> = {
  awaiting_confirmation: { seller: 'ждём подтверждения', client: 'подтвердите условия' },
  changes_requested: { seller: 'предложены изменения', client: 'ждём новые условия' },
  declined: { seller: 'клиент отказался', client: 'вы отказались' },
  expired: { seller: 'срок истёк', client: 'срок истёк' },
  awaiting_prepayment: { seller: 'ждём предоплату', client: 'внесите предоплату' },
  scheduled: { seller: 'запланировано', client: 'запланировано' },
  awaiting_acceptance: { seller: 'ждём приёмку', client: 'примите работу' },
  remarks: { seller: 'есть замечания', client: 'ждём исправлений' },
  awaiting_payment: { seller: 'ждём остаток', client: 'оплатите остаток' },
  paid: { seller: 'нужен чек', client: 'ждём чек' },
  closed: { seller: 'закрыта', client: 'закрыта' },
  cancelled: { seller: 'отменена', client: 'отменена' },
};

export function statusShort(status: DealStatus, role: CardRole): string {
  const pair = STATUS_SHORT[status];
  return role === 'seller' ? pair.seller : pair.client;
}

const CANCEL_RULE_TEXT: Record<CancelRule, string> = {
  free_24h: 'Отмена без потери предоплаты за 24 ч и более до срока',
  free_48h: 'Отмена без потери предоплаты за 48 ч и более до срока',
  nonrefundable: 'Предоплата не возвращается при отмене клиентом',
  full_refund: 'Предоплата возвращается при любой отмене',
};

/** Правило отмены целой фразой: квитанция, мини-приложение. */
export function cancelRuleText(rule: CancelRule): string {
  return CANCEL_RULE_TEXT[rule];
}

// После подписи «Отмена:» в карточке слово «отмена» не повторяем: «Отмена: без потери предоплаты за 24 ч…».
const CANCEL_RULE_AFTER_LABEL: Record<CancelRule, string> = {
  free_24h: 'без потери предоплаты за 24 ч и более до срока',
  free_48h: 'без потери предоплаты за 48 ч и более до срока',
  nonrefundable: 'предоплата не возвращается при отмене клиентом',
  full_refund: 'предоплата возвращается при любой отмене',
};

/** Правило отмены после подписи «Отмена:» (DESIGN_BRIEF §3.1). */
export function cancelRuleLine(rule: CancelRule): string {
  return CANCEL_RULE_AFTER_LABEL[rule];
}

// --- карточка (DESIGN_BRIEF §3). Данные собирает cards.ts, здесь только текст ---

export type CardView = {
  publicId: string;
  status: DealStatus;
  role: CardRole;
  title: string;
  description: string | null;
  scheduledAt: Date | null;
  totalKopecks: number;
  prepaymentKopecks: number;
  remainingKopecks: number;
  cancelRule: CancelRule;
  hasPhoto: boolean;
  sellerName: string;
  clientName: string | null;
  demo: boolean;
  /** Блок платежа (paymentLines или transferLines клиенту): от одной до трёх строк, пусто, если сказать нечего. */
  paymentLines: string[];
  receiptLine: string | null;
  refundLine: string | null;
  /** Отмена после «Я перевёл(а)» без подтверждения исполнителя: сверить поступление (ЗАДАЧА_03 F7). */
  claimLine?: string | null;
  clientLink: string | null;
  /** Номер текущей версии условий и когда она создана: при версии > 1 строка «Версия N, условия изменены …» (T5). */
  version?: number;
  versionCreatedAt?: Date | null;
  /** «12 сделок, 98 % без споров» в карточке клиента, если исполнитель это включил (ЗАДАЧА_08 E, SPEC §7.11). */
  reliabilityLine?: string | null;
};

const CARD_MAX_LINES = 12;
const CARD_MAX_CHARS = 1200;
const DESCRIPTION_BUDGET = 320;

/** «**3 000 ₽**, предоплата **900 ₽** (30 %)» или «**3 000 ₽**, без предоплаты» (DESIGN_BRIEF §3.1). */
function moneyLine(totalKopecks: number, prepaymentKopecks: number): string {
  const total = `**${formatMoney(totalKopecks)}**`;
  if (prepaymentKopecks <= 0) return `${total}, без предоплаты`;
  const percent = formatPercent(prepaymentPercent(totalKopecks, prepaymentKopecks));
  return `${total}, предоплата **${formatMoney(prepaymentKopecks)}** (${percent})`;
}

const WHEN_LABEL = 'Когда:';

/**
 * Пояс в карточке пишется один раз, и лучше всего у срока: «Когда: вт 12 окт, 14:00 (МСК)» (макет §3.1). Если срока
 * нет, пояс остаётся у первого времени в карточке (строка версии, платежа, возврата).
 */
function cardZoneOnce(lines: string[]): string[] {
  const mark = ` (${zoneLabel()})`;
  const when = lines.findIndex((l) => l.startsWith(WHEN_LABEL) && l.includes(mark));
  if (when < 0) return zoneOnce(lines.join('\n')).split('\n');
  return lines.map((l, i) => (i === when ? l : l.split(mark).join('')));
}

/**
 * Карточка сделки (DESIGN_BRIEF §3.1): шапка, условия, стороны, платёж и документы. Эмодзи только в первой строке
 * (статус) и у тестовых строк 🧪; жирным только название и суммы. Не больше 12 строк и 1 200 символов.
 */
export function card(v: CardView): string {
  // Сборка параметризована бюджетом уточнений: если карточка не влезает в 1200 символов, сжимаем именно их.
  const build = (descBudget: number): string => {
    const head: string[] = [];
    if (v.role === 'client_demo') head.push(DEMO_CARD_PREFIX);
    const demoMark = v.demo && v.role === 'seller' ? ', демо' : '';
    head.push(`${statusEmoji(v.status)} **${esc(oneLine(v.title))}** #${v.publicId}${demoMark}`);
    head.push(`Статус: ${lowerFirst(statusText(v.status, v.role, v))}`);
    let version: string | null =
      v.version && v.version > 1 && v.versionCreatedAt ? `Версия ${v.version}, условия изменены ${formatMoment(v.versionCreatedAt)}` : null;

    let photo: string | null = v.hasPhoto ? 'Макет: приложён' : null;
    const terms = (): string[] =>
      [
        `${WHEN_LABEL} ${v.scheduledAt ? formatDateTime(v.scheduledAt) : 'без даты, срок обсудите отдельно'}`,
        `Сумма: ${moneyLine(v.totalKopecks, v.prepaymentKopecks)}`,
        `Отмена: ${cancelRuleLine(v.cancelRule)}`,
        v.description ? `Уточнения: ${esc(clip(oneLine(v.description), descBudget))}` : null,
        photo,
      ].filter((l): l is string => l !== null);

    let link: string | null = v.clientLink ? `Ссылка для клиента: \`${v.clientLink}\`` : null;
    let receipt = v.receiptLine;
    let reliability: string | null = v.reliabilityLine ? `Надёжность: ${v.reliabilityLine}` : null;
    const parties = (): string[] =>
      [
        `Исполнитель: ${esc(oneLine(v.sellerName))}`,
        reliability,
        `Клиент: ${v.clientName ? esc(oneLine(v.clientName)) : 'ещё не открыл ссылку'}`,
        ...v.paymentLines,
        receipt,
        v.refundLine,
        v.claimLine ?? null,
        link,
      ].filter((l): l is string => Boolean(l));

    // Переполнение по строкам: убираем необязательное по возрастанию важности (DESIGN_BRIEF §3):
    // макет, ссылка для клиента (она же в кнопке «Скопировать ссылку»), строка версии, строка чека.
    const count = () => head.length + (version ? 1 : 0) + terms().length + parties().length;
    // Строка надёжности исполнителя (ЗАДАЧА_08 E) — самая необязательная, уходит первой.
    const dropOrder: (() => void)[] = [
      () => (reliability = null),
      () => (photo = null),
      () => (link = null),
      () => (version = null),
      () => (receipt = null),
    ];
    for (const drop of dropOrder) {
      if (count() <= CARD_MAX_LINES) break;
      drop();
    }

    // Блоки разделяются пустой строкой, пока это укладывается в 12 строк.
    const blanks = Math.max(0, Math.min(2, CARD_MAX_LINES - count()));
    const lines = [...head, ...(version ? [version] : [])];
    if (blanks >= 1) lines.push('');
    lines.push(...terms());
    if (blanks >= 2) lines.push('');
    lines.push(...parties());
    return cardZoneOnce(lines.slice(0, CARD_MAX_LINES)).join('\n');
  };

  let budget = DESCRIPTION_BUDGET;
  let text = build(budget);
  while (text.length > CARD_MAX_CHARS && budget > 24) {
    budget = Math.max(24, budget - 48);
    text = build(budget);
  }
  return text.length > CARD_MAX_CHARS ? clip(text, CARD_MAX_CHARS) : text;
}

// --- строки внутри карточки (DESIGN_BRIEF §3.1, блок платежа и документов) ---

/** Строки платежа: одна, а у оплаты тестовым магазином ещё отдельная строка 🧪 (§2.1: тестовая пометка своей строкой). */
export function paymentLines(a: {
  kind: 'prepayment' | 'final';
  state: 'awaiting' | 'link_issued' | 'link_expired' | 'link_canceled' | 'transfer_chosen' | 'claimed' | 'received';
  sumKopecks: number;
  at: Date | null;
  rail: PaymentRail | null;
  provider: PaymentProvider | null;
  linkExpiresAt: Date | null;
  /** cancellation_details.reason провайдера показывается как есть (SPEC §9.2). */
  cancelReason?: string | null;
  /** Кто читает строку: «клиент сообщил о переводе» исполнителю и «вы сообщили» клиенту. */
  viewer?: 'seller' | 'client';
}): string[] {
  const label = a.kind === 'prepayment' ? 'Предоплата' : 'Остаток';
  const sum = formatMoney(a.sumKopecks);
  switch (a.state) {
    case 'awaiting':
      return [`${label} ${sum} ждёт оплаты`];
    case 'link_issued':
      return [a.linkExpiresAt ? `Ссылка на оплату ${sum} действует до ${formatMoment(a.linkExpiresAt)}` : `Ссылка на оплату ${sum} создана`];
    case 'link_expired':
      return [`Ссылка на оплату ${sum} истекла, нужна новая`];
    case 'link_canceled':
      return [a.cancelReason ? `Оплата ${sum} отменена: ${cancelReasonText(a.cancelReason)}` : `Оплата ${sum} отменена, можно создать новую ссылку`];
    case 'transfer_chosen':
      return [`${label} ${sum}: клиент выбрал перевод по реквизитам, ждём перевода`];
    case 'claimed': {
      const when = a.at ? ` ${formatMoment(a.at)}` : '';
      return [
        a.viewer === 'client'
          ? `Вы сообщили о переводе ${sum}${when}. Ждём подтверждения исполнителя`
          : `${label} ${sum}: клиент сообщил о переводе${when}. Проверьте поступление и подтвердите`,
      ];
    }
    case 'received': {
      const verb = a.kind === 'prepayment' ? 'получена' : 'получен';
      const when = a.at ? ` ${formatMoment(a.at)}` : '';
      const how = a.rail && a.provider ? ` ${railHow(a.rail, a.provider)}` : '';
      // Оплата тестовым магазином: отдельной строкой, что денег не было (ЗАДАЧА_04 A4, SPEC §18).
      const test = a.rail && a.provider ? railTestLine(a.rail, a.provider) : null;
      return [`${label} ${sum} ${verb}${when}${how}`, ...(test ? [test] : [])];
    }
  }
}

export function receiptLine(a: { attachedAt: Date | null; deadline: Date | null; taxModeNone: boolean }): string {
  if (a.attachedAt) return `Чек приложен ${formatDayMonthShort(a.attachedAt)} (содержимое не проверялось)`;
  if (a.taxModeNone) return 'Чек не требуется (исполнитель работает без чека)';
  return a.deadline ? `Чек: до ${formatDayMonthShort(a.deadline)}` : 'Чек: ждём от исполнителя';
}

/**
 * Сделку отменили, когда клиент уже сообщил о переводе, а исполнитель его не подтвердил (ЗАДАЧА_03 F7).
 * Продукт перевод не видит: строка в карточке, в N15 и отдельным сообщением обеим сторонам.
 */
export function claimedTransferOnCancel(a: { sumKopecks: number; at: Date | null; viewer: 'seller' | 'client' }): string {
  const when = a.at ? ` ${formatMoment(a.at)}` : '';
  // Возвращает исполнитель: ему действие, клиенту ожидание (DESIGN_BRIEF §2.5, §4).
  return a.viewer === 'seller'
    ? `Клиент сообщал о переводе ${formatMoney(a.sumKopecks)}${when}. Проверьте поступление и верните при необходимости`
    : `Вы сообщали о переводе ${formatMoney(a.sumKopecks)}${when}. Исполнитель сверит поступление и вернёт деньги, если они пришли`;
}

/**
 * Отдельное сообщение стороне, которая отменила сделку после «Я перевёл(а)» клиента (ЗАДАЧА_03 F7): вторая сторона
 * узнаёт о переводе из N15, а отменившей нужен свой повод сверить поступление.
 */
export function CLAIM_AFTER_CANCEL(a: { id: string; sumKopecks: number; at: Date | null; to: 'seller' | 'client' }): string {
  const when = a.at ? ` ${formatMoment(a.at)}` : '';
  const who = a.to === 'seller' ? 'клиент сообщал' : 'вы сообщали';
  return notice(
    `⚠️ Сделка #${a.id} отменена, а ${who} о переводе ${formatMoney(a.sumKopecks)}${when}.`,
    a.to === 'seller' ? 'Проверьте поступление и верните перевод, если он пришёл.' : 'Исполнитель сверит поступление и вернёт деньги, если они пришли.',
  );
}

export function refundLine(a: {
  prepaymentKopecks: number;
  expected: boolean | null;
  /** «Вернул(а) предоплату» исполнителя и «Возврат получил(а)» клиента (SPEC §5.3, ЗАДАЧА_03 H1) */
  sentAt?: Date | null;
  receivedAt?: Date | null;
}): string | null {
  if (a.prepaymentKopecks <= 0 || a.expected === null) return null;
  const sum = formatMoney(a.prepaymentKopecks);
  if (!a.expected) return `Предоплата ${sum} не возвращается по правилу отмены`;
  if (a.receivedAt) return `Возврат ${sum} получен клиентом ${formatMoment(a.receivedAt)}`;
  if (a.sentAt) return `Исполнитель вернул ${sum} ${formatMoment(a.sentAt)}. Ждём подтверждения клиента`;
  return `Предоплата ${sum}: ожидается возврат`;
}

/** Уведомления второй стороне об отметке возврата (H1). */
export function REFUND_SENT_NOTICE(a: { id: string; sumKopecks: number }): string {
  return `💸 Исполнитель вернул ${formatMoney(a.sumKopecks)} по отменённой сделке #${a.id}.\nПроверьте поступление и нажмите «${BTN.refundReceived}».`;
}

export function REFUND_RECEIVED_NOTICE(a: { client: string; id: string; sumKopecks: number }): string {
  return `✅ ${esc(a.client)} подтвердил(а) возврат ${formatMoney(a.sumKopecks)} по сделке #${a.id}.\nСделка завершена, делать ничего не нужно.`;
}

export const REFUND_SENT_ACK = 'Отметили возврат, клиент получил сообщение';
export const REFUND_RECEIVED_ACK = 'Возврат отмечен, исполнитель получил сообщение';

// --- уведомления второй стороне (§6.5, DESIGN_BRIEF §4). id = public_id сделки ---
// Шаблон §4: первая строка это факт в прошедшем времени с номером сделки и эмодзи типа события, вторая это
// действие получателя или «ждём …». Кнопка одна, её выбирает notify.ts. Пользовательский текст (N3, N11) цитатой
// между фактом и действием.

function notice(fact: string, action?: string | null): string {
  return action ? `${fact}\n${action}` : fact;
}

export function N1(a: { client: string; id: string }): string {
  return notice(`👀 ${esc(a.client)} открыл(а) карточку #${a.id}.`, 'Ждём подтверждения условий.');
}

export function N2(a: { client: string; id: string; prepaymentKopecks: number; scheduledAt: Date | null }): string {
  const action =
    a.prepaymentKopecks > 0
      ? `Ждём предоплату ${formatMoney(a.prepaymentKopecks)}`
      : `${a.scheduledAt ? `Всё согласовано на ${formatDateTime(a.scheduledAt)}` : 'Всё согласовано'}. Отметьте «${BTN.done}», когда закончите`;
  return notice(`✅ ${esc(a.client)} подтвердил(а) условия #${a.id}.`, `${action}.`);
}

export function N3(a: { client: string; id: string; text: string }): string {
  return `✏️ ${esc(a.client)} предлагает изменения по #${a.id}:\n${quote(esc(a.text))}\n\nИзмените условия или оставьте как есть.`;
}

/** Значения новой версии для перечня в N4. */
export type TermsValues = {
  title: string;
  scheduledAt: Date | null;
  totalKopecks: number;
  prepaymentKopecks: number;
  cancelRule: CancelRule;
};

/**
 * Что изменилось в новой версии, по порядку формы: «когда: вт 12 окт, 15:00 (МСК); сумма: 3 000 ₽, предоплата
 * 600 ₽». Сумма и предоплата одной группой через запятую, остальное через «;» (DESIGN_BRIEF §4, N4).
 */
export function termsChanges(changed: readonly TermsField[], v: TermsValues): string {
  const has = (f: TermsField) => changed.includes(f);
  const prepayment = v.prepaymentKopecks > 0 ? formatMoney(v.prepaymentKopecks) : 'без предоплаты';
  let money: string | null = null;
  if (has('total') && has('prepayment')) {
    money = `сумма: ${formatMoney(v.totalKopecks)}, ${v.prepaymentKopecks > 0 ? `предоплата ${prepayment}` : prepayment}`;
  } else if (has('total')) money = `сумма: ${formatMoney(v.totalKopecks)}`;
  else if (has('prepayment')) money = `предоплата: ${prepayment}`;
  const groups = [
    has('title') ? `что делаем: «${esc(oneLine(v.title))}»` : null,
    has('description') ? 'уточнения изменены' : null,
    has('scheduled_at') ? `когда: ${v.scheduledAt ? formatDateTime(v.scheduledAt) : 'без даты'}` : null,
    money,
    has('cancel_rule') ? `правило отмены: ${cancelRuleLine(v.cancelRule)}` : null,
  ].filter(Boolean);
  return groups.join('; ');
}

/** N4 (SPEC §6.5): клиенту новая версия условий и только то, что в ней изменилось. */
export function N4(a: { id: string; version: number; changed?: readonly TermsField[]; terms?: TermsValues }): string {
  const list = a.changed?.length && a.terms ? termsChanges(a.changed, a.terms) : '';
  return notice(`✏️ Исполнитель изменил условия #${a.id}, версия ${a.version}${list ? `: ${list}` : ''}.`, 'Проверьте и подтвердите.');
}

/** Ответ исполнителю после T5 (N4a): дошла ли новая версия до клиента. */
export function TERMS_UPDATED(a: { id: string; version: number; client: 'notified' | 'no_client' | 'not_delivered' }): string {
  if (a.client === 'notified') return notice(`✏️ Условия #${a.id} обновлены, клиент получил версию ${a.version}.`, 'Ждём подтверждения.');
  if (a.client === 'no_client') return notice(`✏️ Условия #${a.id} обновлены, версия ${a.version}.`, 'Клиент увидит её, когда откроет ссылку.');
  return notice(`✏️ Условия #${a.id} обновлены, версия ${a.version}.`, 'Клиент увидит её в карточке, когда вернётся в чат с ботом.');
}

export function N5(a: { id: string }): string {
  return notice(`✏️ Исполнитель оставил условия #${a.id} без изменений.`, 'Подтвердите или откажитесь.');
}

export function N6(a: { client: string; id: string }): string {
  return notice(`⛔ ${esc(a.client)} отказался(ась) от сделки #${a.id}.`, 'Можно создать новую.');
}

/** N7 уходит обеим сторонам; создать новую сделку может исполнитель, клиенту подсказываем попросить его. */
export function N7(a: { id: string; to?: 'seller' | 'client' }): string {
  const fact = `⌛ Срок подтверждения #${a.id} истёк (72 ч), сделка закрыта.`;
  return notice(fact, a.to === 'client' ? 'Если сделка ещё нужна, попросите исполнителя прислать новую ссылку.' : 'Можно создать новую.');
}

/** Предоплата пришла: обеим сторонам, действие по роли (исполнитель отмечает выполнение, клиент ждёт). */
export function N8(a: { id: string; sumKopecks: number; rail: PaymentRail; provider: PaymentProvider; to?: 'seller' | 'client' }): string {
  const test = railTestLine(a.rail, a.provider);
  const action = a.to === 'seller' ? `Всё согласовано. Отметьте «${BTN.done}», когда закончите.` : 'Всё согласовано, ждём выполнения.';
  return [`💸 Предоплата ${formatMoney(a.sumKopecks)} по #${a.id} получена ${railHow(a.rail, a.provider)}.`, test ? `${test}.` : null, action]
    .filter(Boolean)
    .join('\n');
}

export function N9(a: { id: string }): string {
  return notice(`✔️ Исполнитель отметил #${a.id} выполненной.`, 'Примите работу или оставьте замечания.');
}

export function N10(a: { client: string; id: string; remainingKopecks: number }): string {
  const action = a.remainingKopecks > 0 ? `Ждём остаток ${formatMoney(a.remainingKopecks)}.` : 'Сделка оплачена полностью.';
  return notice(`👍 ${esc(a.client)} принял(а) работу по #${a.id}.`, action);
}

export function N11(a: { client: string; id: string; text: string }): string {
  return `⚠️ ${esc(a.client)} оставил(а) замечания по #${a.id}:\n${quote(esc(a.text))}\n\nИсправьте и нажмите «${BTN.fixed}».`;
}

export function N12(a: { id: string }): string {
  return notice(`🔧 Исполнитель исправил замечания по #${a.id}.`, 'Проверьте ещё раз и примите работу.');
}

export function N13(a: { id: string; deadline: Date }): string {
  return notice(`🧾 Сделка #${a.id} оплачена полностью.`, `Сформируйте чек в «Мой налог» и приложите его сюда, срок до ${formatDayMonthShort(a.deadline)}.`);
}

export function N14(a: { id: string; withReceipt: boolean }): string {
  return notice(`✅ Сделка #${a.id} закрыта.`, `Квитанция во вложении${a.withReceipt ? ', чек выше' : ''}.`);
}

const RECEIPT_STATUS_WORD: Partial<Record<DealStatus, string>> = {
  closed: 'сделка закрыта',
  cancelled: 'сделка отменена',
  declined: 'клиент отказался',
  expired: 'срок подтверждения истёк',
};

/** Квитанция по кнопке «Квитанция PDF»: подпись по фактическому статусу, а не «закрыта» всегда. */
export function RECEIPT_ON_DEMAND(a: { id: string; status: DealStatus }): string {
  const word = RECEIPT_STATUS_WORD[a.status];
  return `📄 Квитанция по сделке #${a.id}${word ? `: ${word}` : ''}.`;
}

export function N15(a: {
  id: string;
  by: 'seller' | 'client' | 'system';
  reason: string | null;
  refundLine: string | null;
  /** claimedTransferOnCancel, если клиент успел сообщить о переводе (ЗАДАЧА_03 F7). */
  claimLine?: string | null;
}): string {
  const by: Record<Role, string> = { seller: 'исполнителем', client: 'клиентом', system: 'автоматически' };
  const reason = a.reason ? `: ${esc(oneLine(a.reason))}` : '';
  const next = [a.refundLine, a.claimLine].filter((l): l is string => Boolean(l)).map((l) => `${l}.`);
  return zoneOnce([`🚫 Сделка #${a.id} отменена ${by[a.by]}${reason}.`, ...next].join('\n'));
}

export function N16(a: { id: string; context: string }): string {
  // context наш собственный текст (статус для клиента), пользовательского ввода в нём нет.
  return zoneOnce(notice(`🔔 Исполнитель напоминает о сделке #${a.id}.`, `${upperFirst(a.context)}.`));
}

// --- рейл «перевод» (§9.1) ---

/**
 * Реквизиты прямо в карточке клиента (SPEC §6.4). Раньше они уходили отдельным ответом на нажатие,
 * и MAX тут же затирал его перерисовкой той же карточки: POST /answers правит нажатое сообщение.
 */
export function transferLines(a: { sumKopecks: number; payoutDetails: string }): string[] {
  return [
    `Переведите **${formatMoney(a.sumKopecks)}** по реквизитам и нажмите «${BTN.transferDone}»`,
    `\`${esc(oneLine(a.payoutDetails))}\``,
    testRailNotice('manual'),
  ];
}

export function P2(a: { client: string; sumKopecks: number; id: string }): string {
  return notice(`💸 ${esc(a.client)} сообщил(а) о переводе ${formatMoney(a.sumKopecks)} по #${a.id}.`, 'Проверьте поступление и подтвердите.');
}

/**
 * Второе «Не вижу перевода» подряд: дальше пинг-понг бесполезен. Предлагаем оплату по ссылке (там
 * подтверждение приходит от провайдера) и честно говорим, что продукт споры не решает (аудит 22.09 §4.3).
 */
export function P3_DISPUTE(a: { id: string; sumKopecks: number; linkAvailable: boolean }): string {
  const next = a.linkAvailable
    ? 'Если перевод не находится, оплатите по ссылке: там подтверждение приходит от платёжного сервиса.'
    : 'Если перевод не находится, договоритесь с исполнителем в чате.';
  return `⚠️ Исполнитель снова не видит перевод ${formatMoney(a.sumKopecks)} по #${a.id}.
${next}
Продукт споры не решает: их решают стороны, отметки «перевёл» и «не вижу» попадут в квитанцию.`;
}

export function P3(a: { id: string; sumKopecks: number }): string {
  return notice(
    `⚠️ Исполнитель пока не видит перевод ${formatMoney(a.sumKopecks)} по #${a.id}.`,
    `Проверьте операцию и нажмите «${BTN.transferDone}» ещё раз, не раньше чем через 10 минут, или выберите другой способ оплаты.`,
  );
}

/**
 * Провайдер подтвердил оплату, которую сделка принять уже не может (ЗАДАЧА_03 F1): сделка отменена или этот
 * этап уже оплачен другим платежом. Деньги ушли исполнителю, вернуть их может только он, продукт их не касается.
 * Уходит обеим сторонам.
 */
export function LATE_PAYMENT_REFUND(a: { id: string; sumKopecks: number; dealCancelled: boolean; to?: 'seller' | 'client' }): string {
  const what = a.dealCancelled ? 'отменённой сделке' : 'уже оплаченному этапу сделки';
  const action = a.to === 'client' ? 'Исполнитель вернёт её тем же способом.' : 'Верните её клиенту тем же способом.';
  return notice(`⚠️ Поступила оплата ${formatMoney(a.sumKopecks)} по ${what} #${a.id}.`, action);
}

/**
 * Причина отказа от провайдера человеческим языком (CONTRACTS §2.7).
 * Полного перечня в документации нет, поэтому незнакомый код показываем как есть,
 * а не прячем: клиенту важно понять, звонить в банк или менять карту.
 */
const CANCEL_REASONS: Record<string, string> = {
  '3d_secure_failed': 'не пройдено подтверждение 3-D Secure',
  call_issuer: 'банк отклонил операцию, позвоните в банк',
  card_expired: 'истёк срок действия карты',
  fraud_suspected: 'операция отклонена как подозрительная',
  general_decline: 'банк отклонил операцию',
  insufficient_funds: 'недостаточно средств',
  invalid_card_number: 'неверный номер карты',
  invalid_csc: 'неверный код CVC',
  issuer_unavailable: 'банк, выпустивший карту, недоступен',
  payment_method_limit_exceeded: 'превышен лимит по карте',
  payment_method_restricted: 'карта не поддерживает такие операции',
  country_forbidden: 'оплата картой этой страны недоступна',
  expired_on_confirmation: 'истёк срок оплаты по ссылке',
  expired_on_capture: 'истёк срок подтверждения платежа',
  canceled_by_merchant: 'платёж отменён магазином',
};

export function cancelReasonText(reason: string): string {
  return CANCEL_REASONS[reason] ?? reason;
}

/** Ответ на «Проверить оплату», когда провайдер ещё не подтвердил платёж (SPEC §9.1 п. 3). */
export function paymentStillPending(status: PaymentStatus): string {
  if (status === 'expired') return `Срок ссылки истёк. Нажмите «${BTN.newLink}», создадим новую`;
  if (status === 'canceled') return `Платёж отменён. Нажмите «${BTN.newLink}», чтобы попробовать ещё раз`;
  return `Оплата пока не подтверждена. Если вы только что заплатили, подождите минуту и нажмите «${BTN.checkPayment}» ещё раз`;
}

/** Подпись кнопки-ссылки на оплату с суммой: «Оплатить 900 ₽» (DESIGN_BRIEF §2.3, §2.8). */
export function payButtonLabel(sumKopecks: number): string {
  return `${BTN.goToPayment} ${formatMoney(sumKopecks)}`;
}

/** Сообщение клиенту при выдаче ссылки (SPEC §9.1 п. 2, §9.2 п. 4). */
export function linkIssued(a: { sumKopecks: number; expiresAt: Date | null; provider: PaymentProvider }): string {
  // Срок и сумма уже в строке оплаты карточки под заметкой: здесь только что делать и пометка теста.
  // Форма тестового магазина принимает любые дату и CVC, но человек этого не знает (замечание тестировщика 26.09).
  const hint = a.provider === 'yookassa' ? YOOKASSA_TEST_CARD_HINT : testRailNotice(a.provider);
  return `Ссылка на оплату готова. Нажмите «${payButtonLabel(a.sumKopecks)}», после оплаты карточка обновится сама.\n${hint}`;
}

/** Тестовая карта ЮKassa из документации провайдера (CONTRACTS §2, SPEC §9.2), не данные пользователя. */
export const YOOKASSA_TEST_CARD_HINT =
  '🧪 Тестовый магазин: подойдёт карта 5555 5555 5555 4444, любая будущая дата и любой CVC. Деньги не списываются';

/** Строка про тестовую среду провайдера для карточки и сообщения об оплате по ссылке (§9.2 п.4, §18). */
export function testRailNotice(provider: PaymentProvider): string {
  if (provider === 'yookassa') return '🧪 Тестовый магазин ЮKassa, реальные деньги не списываются';
  if (provider === 'tbank') return '🧪 DEMO-терминал Т-Банка, реальные деньги не списываются';
  return '🧪 Перевод продукт не видит, его подтверждают обе стороны кнопками';
}

// --- запросы ввода (§6.6) ---

export const ASK_CHANGE_REQUEST = 'Напишите одним сообщением, что изменить. Например: «давайте 15:00 и без предоплаты»';
export const ASK_REMARKS = 'Опишите замечания одним сообщением';
export const ASK_RECEIPT = 'Пришлите чек из «Мой налог» одним сообщением: фото или PDF';
export const ASK_CANCEL_REASON = 'Напишите причину отмены одним сообщением или нажмите «Без причины»';

/** Ответы на присланный текст или файл (SPEC §6.6). */
export const INPUT_NEED_TEXT = 'Нужен текст одним сообщением';
export const CHANGE_REQUEST_SENT = 'Передали предложение исполнителю. Ждём новые условия';
export const REMARKS_SENT = 'Передали замечания исполнителю. Ждём исправлений';
export const RECEIPT_ACCEPTED = 'Чек принят. Готовлю квитанцию, пришлю отдельным сообщением';

export function CANCELLED_ACK(id: string): string {
  return `Сделка #${id} отменена`;
}

/** Ответ на нажатие без карточки под рукой (кнопка из уведомления). */
export const DONE_ACK = 'Готово';
export const DONE_CARD_UPDATED = 'Готово, карточка обновлена';
export const SETTINGS_IN_APP = 'Настройки профиля в мини-приложении';

// --- подтверждения перед необратимым действием ---

export function CONFIRM_DECLINE(id: string): string {
  return `Отказаться от сделки #${id}? Исполнитель узнает об этом, вернуться к этой карточке будет нельзя`;
}

export function CONFIRM_CANCEL(id: string): string {
  return `Отменить сделку #${id}? Это необратимо, вторая сторона получит сообщение`;
}

/** Последствие отмены для предоплаты: в том же вопросе, до подтверждения (SPEC §5.3). */
export function CANCEL_CONSEQUENCE(a: { by: 'seller' | 'client'; prepaymentKopecks: number; expected: boolean | null }): string | null {
  if (a.expected === null || a.prepaymentKopecks <= 0) return null;
  const sum = formatMoney(a.prepaymentKopecks);
  if (a.by === 'seller') return `Предоплату ${sum} нужно будет вернуть клиенту тем же способом, каким она пришла`;
  return a.expected
    ? `По правилу отмены предоплата ${sum} вернётся: исполнитель вернёт её тем же способом`
    : `По правилу отмены предоплата ${sum} не вернётся`;
}

export function CONFIRM_CLOSE_WITHOUT_RECEIPT(id: string): string {
  return `Закрыть сделку #${id} без чека? Квитанция уйдёт обеим сторонам, но чека из «Мой налог» в ней не будет`;
}

// --- ошибки (§6.3, §6.6, §6.7): «что случилось. что делать» (DESIGN_BRIEF §4) ---

export const E1 = 'Это действие уже недоступно, карточка обновлена';
export const E2 = 'Не нашёл такую сделку. Проверьте ссылку или попросите исполнителя прислать её ещё раз';
export const E3 = 'По этой ссылке уже подтверждает другой человек. Попросите исполнителя создать новую сделку';
export const E4 = 'Это демо-сделка исполнителя, к ней нельзя присоединиться';
export const E5 = 'Слишком длинно: нужно до 500 символов. Сократите и пришлите ещё раз';
export const E6 = 'Нужен файл или фото. Пришлите чек вложением';
export const E7 = 'После выполнения работы отменить сделку можно только по согласованию с исполнителем. Напишите ему в чат';
export const E8 = 'Время ожидания истекло. Нажмите кнопку ещё раз';
export const E9 =
  'Не удалось создать ссылку на оплату: провайдер недоступен. Попробуйте через минуту или выберите перевод по реквизитам';
export const E10 = 'Что-то пошло не так, мы уже разбираемся. Попробуйте ещё раз через минуту';
export const E11 = 'Оплата по ссылке не подключена. Доступен перевод по реквизитам';
export const E12 = 'Исполнитель не указал реквизиты для перевода. Попросите его заполнить их в настройках';
export const E13 = 'Повторно сообщить о переводе можно через 10 минут после прошлого раза. За это время исполнитель проверит поступление';

/** «Подтверждаю» на карточке прежней версии: исполнитель успел изменить условия (T5, SPEC §5.2 T3). */
export const VERSION_CHANGED = 'Условия изменились. Посмотрите новую версию';

/** Двойной тап «Оплатить по ссылке», пока провайдер ещё создаёт первую ссылку (ЗАДАЧА_03 F3). */
export const LINK_IN_PROGRESS = 'Ссылка на оплату готовится. Нажмите ещё раз через секунду';

/** Кнопка чужой сделки (пересланная карточка, подобранный payload): ЗАДАЧА_03 G1. */
export const NOT_YOUR_DEAL = 'Это не ваша сделка';

/** Идемпотентный повтор: карточка уже в целевом состоянии (SPEC §5.2, конкурентность). */
export const ALREADY_DONE = 'Это уже сделано, карточка актуальна';

// --- заметки над карточкой в ответ на нажатие (§6.4): факт одной строкой, без эмодзи и кнопок ---

export const REMIND_SENT = 'Напоминание отправлено клиенту';
export const REMIND_COOLDOWN = 'Напоминание уже отправлено. Следующее можно через 4 часа';
export const REMIND_NO_CHAT = 'Клиент ещё не открывал бота, напоминание отправить некуда';
export const RECEIPT_NOT_YET = 'Квитанция появится после закрытия или отмены сделки';
export const TRANSFER_CLAIMED = 'Сообщили исполнителю о переводе. Ждём его подтверждения';
export const TRANSFER_NOT_SEEN_ACK = 'Отметили, что перевода не видно. Клиент получил подсказку';
export const RAIL_CANCELLED = 'Способ оплаты отменён. Выберите другой';
export const RECEIPT_FORWARDED = 'Чек от исполнителя (содержимое не проверялось):';
export const RECEIPT_PREPARING = 'Готовлю квитанцию, пришлю отдельным сообщением';

// --- напоминания (§10.2) ---

/** Пометка к напоминанию, которое у демо-сделки пришло через 2 минуты вместо суток (domain/reminder/plan.ts). */
export const DEMO_ACCELERATED_NOTE = '🧪 В демо ускорено: в настоящей сделке это напоминание придёт через сутки';

/** Виды со своими текстами и данными: «через 30 минут» (eventSoon) и утренняя сводка (dailyDigest). */
export type PlainReminderKind = Exclude<ReminderKind, 'event_soon' | 'daily_digest'>;

/** Кому адресовано, решает план (§10.2); текст написан под эту сторону. `accelerated`: демо-сделка, срок ускорен. */
export function reminderText(
  kind: PlainReminderKind,
  a: { id: string; title: string; sumKopecks: number; scheduledAt: Date | null; deadline: Date | null; accelerated?: boolean },
): string {
  const text = reminderBody(kind, a);
  return a.accelerated ? `${text}\n${DEMO_ACCELERATED_NOTE}` : text;
}

function reminderBody(
  kind: PlainReminderKind,
  a: { id: string; title: string; sumKopecks: number; scheduledAt: Date | null; deadline: Date | null },
): string {
  const sum = formatMoney(a.sumKopecks);
  const deadline = a.deadline ? `, срок до ${formatDayMonthShort(a.deadline)}` : '';
  const receipt = 'Сформируйте его в «Мой налог» и приложите.';
  switch (kind) {
    case 'client_not_opened':
      return notice(`🔔 Клиент ещё не открыл карточку #${a.id}.`, 'Отправьте ему ссылку ещё раз.');
    case 'confirmation_expired':
      // Это напоминание выполняет T8; текст получателям тот же N7.
      return N7({ id: a.id });
    case 'prepayment_due':
      return notice(`🔔 Предоплата ${sum} по #${a.id} ещё не внесена.`, 'Внесите её, чтобы сделка состоялась.');
    case 'prepayment_overdue':
      return notice(`🔔 Предоплата по #${a.id} не получена 2 дня.`, 'Напомните клиенту или отмените сделку.');
    case 'event_tomorrow':
      // Факт и есть главное: что и когда. Действия нет, кнопка открывает сделку (DESIGN_BRIEF §4).
      return a.scheduledAt
        ? `📅 Завтра, ${formatDateTime(a.scheduledAt)}: ${esc(oneLine(a.title))}, #${a.id}.`
        : `📅 Завтра по плану: ${esc(oneLine(a.title))}, #${a.id}.`;
    case 'event_passed':
      return notice(`🔔 Срок сделки #${a.id} прошёл.`, `Отметьте «${BTN.done}», когда закончите.`);
    case 'acceptance_due':
      return notice(`🔔 Исполнитель ждёт приёмку по #${a.id}.`, 'Примите работу или оставьте замечания.');
    case 'payment_due':
      return notice(`🔔 Остаток ${sum} по #${a.id} ждёт оплаты.`, 'Оплатите его в карточке сделки.');
    case 'payment_overdue':
      return notice(`🔔 Остаток по #${a.id} не оплачен 3 дня.`, 'Напомните клиенту.');
    case 'receipt_due':
      return notice(`🔔 Чек по #${a.id} ещё не приложен${deadline}.`, receipt);
    case 'receipt_deadline':
      return notice(`🔔 Чек по #${a.id} всё ещё не приложен${deadline}, осталось 2 дня (ст. 14 422-ФЗ).`, receipt);
    case 'refund_due':
      return notice(
        `🔔 Сделка #${a.id} отменена двое суток назад, возврат ${sum} клиенту не отмечен.`,
        `Верните тем же способом, каким получили, и нажмите «${BTN.refundSent}» в карточке.`,
      );
  }
}

/**
 * «⏰ Через 30 минут» (ЗАДАЧА_04 B1, DESIGN_BRIEF §4). Исполнителю: кто придёт и что с предоплатой, клиенту: что и у
 * кого. Адреса отдельным полем нет (он в «Уточнениях»), поэтому в текст не добавляем. Кнопки нет.
 */
export function eventSoon(a: {
  to: 'seller' | 'client';
  title: string;
  clientName: string;
  sellerName: string;
  prepayment: 'received' | 'awaiting' | 'none';
  prepaymentKopecks: number;
}): string {
  const title = esc(oneLine(a.title));
  if (a.to === 'client') return `⏰ Через 30 минут: ${title}, исполнитель ${esc(oneLine(a.sellerName))}.`;
  const prepayment =
    a.prepayment === 'none'
      ? 'Без предоплаты.'
      : a.prepayment === 'received'
        ? 'Предоплата получена.'
        : `Предоплата ${formatMoney(a.prepaymentKopecks)} ещё не внесена.`;
  return notice(`⏰ Через 30 минут: ${esc(oneLine(a.clientName))}, ${title}.`, prepayment);
}

/** «1 сделка», «3 сделки», «5 сделок», «21 сделка». */
export function dealsWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} сделка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} сделки`;
  return `${n} сделок`;
}

export type DigestLine = {
  scheduledAt: Date;
  title: string;
  /** null: клиент ещё не открыл ссылку */
  clientName: string | null;
  status: DealStatus;
  prepaymentKopecks: number;
  demo: boolean;
};

/** Что со сделкой, словом (ЗАДАЧА_04 B2): для согласованной есть ли предоплата, для остальных чего ждём. */
function digestState(l: DigestLine): string {
  if (l.status === 'scheduled') return l.prepaymentKopecks > 0 ? 'предоплата получена' : 'без предоплаты';
  return statusShort(l.status, 'seller');
}

/** Сколько сделок показываем в сводке; остальное в «Расписании» (лимит сообщения MAX 4000 символов). */
const DIGEST_MAX_LINES = 20;

/**
 * Утренняя сводка исполнителю (ЗАДАЧА_04 B2, DESIGN_BRIEF §4): «📅 Сегодня, вт 29 сен: 3 сделки (МСК)» и по строке
 * на сделку «10:00, Саша, Маникюр с покрытием, предоплата получена». Строки уже отсортированы по времени.
 */
export function dailyDigest(a: { day: Date; lines: DigestLine[]; now?: Date }): string {
  const now = a.now ?? new Date();
  const head = `📅 Сегодня, ${formatWeekdayDay(a.day, undefined, now)}: ${dealsWord(a.lines.length)} (МСК)`;
  const rows = a.lines.slice(0, DIGEST_MAX_LINES).map((l) => {
    const who = l.demo ? 'демо-клиент' : l.clientName ? esc(clip(oneLine(l.clientName), 40)) : 'клиент не открыл ссылку';
    const parts = [formatTime(l.scheduledAt), who, esc(clip(oneLine(l.title), 60)), digestState(l)];
    if (l.demo) parts.push('демо');
    return parts.join(', ');
  });
  const more = a.lines.length > DIGEST_MAX_LINES ? [`…и ещё ${a.lines.length - DIGEST_MAX_LINES}, смотрите «${BTN.schedule}»`] : [];
  return [head, ...rows, ...more].join('\n');
}

// --- ответы API мини-приложения на правку условий (SPEC §7.8). Экран показывает свой текст по коду, это запасной ---

export const API_DEAL_NOT_FOUND = 'Сделка не найдена';
export const API_FORBIDDEN_DEAL = 'Это не ваша сделка';
export const API_NOT_EDITABLE = 'Условия можно изменить, только пока клиент их не подтвердил';
export const API_NO_CHANGES = 'Условия не изменились, отправлять клиенту нечего';
export const API_INVALID_TRANSITION = 'Это действие уже недоступно: сделка изменилась. Откройте её заново';

// --- экран сделки в мини-приложении (ЗАДАЧА_08 B, SPEC §7.9). Простой текст без markdown: его рисует React ---

export const API_VERSION_MISMATCH = 'Условия изменились. Посмотрите новую версию';
export const API_UPLOAD_FAILED = 'Не удалось загрузить файл в MAX. Попробуйте ещё раз через минуту';
export const API_RECEIPT_NOT_READY = 'Квитанция будет, когда сделка закроется или отменится';
export const API_RECEIPT_SENT = 'Квитанция отправлена в чат с ботом';
export const API_CHEQUE_TYPE = 'Нужен файл PDF, JPG или PNG';
export const API_CHEQUE_TOO_LARGE = 'Файл больше 20 МБ. Сожмите фото или пришлите PDF';
export const API_CHEQUE_ACCEPTED = 'Чек приложен, квитанция ушла обеим сторонам';
export const API_TEXT_LENGTH = 'Текст от 1 до 500 символов';
export const API_REASON_LENGTH = 'Причина до 300 символов';
export const API_ACTION_DONE = 'Готово';
export const API_SLOT_BUSY = 'Это время уже заняли. Выберите другое';
export const API_TIME_STALE = 'Предложение устарело: условия уже изменились или время прошло';

export const API_SERVICES_LIMIT = 'Услуг уже 50. Скройте ненужные или измените существующую';
export const API_SERVICE_NOT_FOUND = 'Услуга не найдена';
export const API_ALREADY_DONE = 'Это уже сделано';

const TERMS_FIELD_LABEL: Record<TermsField, string> = {
  title: 'что делаем',
  description: 'уточнения',
  scheduled_at: 'срок',
  total: 'сумма',
  prepayment: 'предоплата',
  cancel_rule: 'правило отмены',
};

function kindLabel(kind: 'prepayment' | 'final'): string {
  return kind === 'prepayment' ? 'Предоплата' : 'Остаток';
}

const PAYMENT_STATUS_WORD: Record<PaymentStatus, string> = {
  pending: 'ждём оплату',
  claimed: 'клиент сообщил о переводе',
  succeeded: 'оплачено',
  canceled: 'отменено',
  expired: 'ссылка истекла',
};

/** Способ оплаты коротко для экрана сделки, с пометкой теста: «ссылка ЮKassa, тест». */
function railLabel(rail: PaymentRail, provider: PaymentProvider): string {
  if (rail === 'transfer') return 'перевод по реквизитам';
  if (provider === 'yookassa') return 'ссылка ЮKassa, тест';
  if (provider === 'tbank') return 'ссылка Т-Банка, тест';
  return 'ссылка на оплату';
}

/** Строка платежа на экране сделки: «Предоплата 500 ₽, ссылка ЮKassa, тест: оплачено 21.09 14:03 (МСК)». */
export function paymentLabel(a: {
  kind: 'prepayment' | 'final';
  rail: PaymentRail;
  provider: PaymentProvider;
  status: PaymentStatus;
  amountKopecks: number;
  at: Date | null;
}): string {
  const how = a.rail === 'transfer' ? 'перевод по реквизитам, подтверждают стороны' : railLabel(a.rail, a.provider);
  const when = a.at && (a.status === 'succeeded' || a.status === 'claimed') ? ` ${formatMoment(a.at)}` : '';
  return `${kindLabel(a.kind)} ${formatMoney(a.amountKopecks)}, ${how}: ${PAYMENT_STATUS_WORD[a.status]}${when}`;
}

/** Строка чека на экране сделки: та же логика, что в карточке (receiptLine), но только когда чек уместен. */
export function chequeText(a: { status: DealStatus; attachedAt: Date | null; deadline: Date | null; taxModeNone: boolean }): string | null {
  if (a.status !== 'paid' && a.status !== 'closed') return null;
  if (a.status === 'closed' && !a.attachedAt && !a.taxModeNone) return 'Сделка закрыта без чека';
  return receiptLine(a);
}

export type TimelinePayment = { kind: 'prepayment' | 'final'; rail: PaymentRail; provider: PaymentProvider; amountKopecks: number };

/**
 * Строка хронологии по событию сделки (SPEC §5.4). null — событие служебное и в хронологию не попадает
 * (напоминания, смена ссылки при повторном нажатии). `payment` — платёж из payload.payment_id, если он есть.
 */
export function timelineText(
  type: string,
  payload: Record<string, unknown>,
  a: { actor: 'seller' | 'client' | 'system'; payment: TimelinePayment | null },
): string | null {
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const sum = a.payment ? formatMoney(a.payment.amountKopecks) : '';
  const what = a.payment ? `${kindLabel(a.payment.kind).toLowerCase()} ${sum}` : 'оплата';
  switch (type) {
    case 'deal.created':
      return payload.source === 'repeat' ? 'Исполнитель повторил прежнюю сделку' : 'Исполнитель создал сделку';
    case 'client.joined':
      return payload.source === 'repeat' ? 'Карточка отправлена клиенту' : 'Клиент открыл карточку';
    case 'demo.opened':
      return 'Демо: исполнитель открыл сделку как клиент';
    case 'version.created': {
      if (payload.kept_as_is) return 'Исполнитель оставил условия без изменений';
      const changed = Array.isArray(payload.changed) ? (payload.changed as TermsField[]).map((f) => TERMS_FIELD_LABEL[f]).filter(Boolean) : [];
      const v = typeof payload.version === 'number' ? ` (версия ${payload.version})` : '';
      return changed.length ? `Исполнитель изменил условия${v}: ${changed.join(', ')}` : `Исполнитель изменил условия${v}`;
    }
    case 'version.confirmed':
      return typeof payload.version === 'number' && payload.version > 1
        ? `Клиент подтвердил условия версии ${payload.version}`
        : 'Клиент подтвердил условия';
    case 'version.change_requested':
      // Предложение времени показывается своей строкой (time.proposed), без дубля «предложил изменения».
      if (payload.proposal_id !== undefined) return null;
      return `Клиент предложил изменения: «${text(payload.text)}»`;
    case 'time.proposed':
      return typeof payload.scheduled_at === 'string'
        ? `Клиент предложил другое время: ${formatDateTime(new Date(payload.scheduled_at))}`
        : 'Клиент предложил другое время';
    case 'deal.declined':
      return 'Клиент отказался от сделки';
    case 'deal.expired':
      return 'Срок подтверждения истёк';
    case 'payment.created':
      return a.payment?.rail === 'transfer' ? `Клиент выбрал перевод по реквизитам: ${what}` : `Клиент получил ссылку на оплату: ${what}`;
    case 'payment.claimed':
      return `Клиент сообщил о переводе: ${what}`;
    case 'payment.not_received':
      return `Исполнитель не видит перевод: ${what}`;
    case 'payment.succeeded': {
      if (payload.no_remainder) return 'Остатка к оплате нет';
      if (!a.payment) return 'Оплата получена';
      const how = a.payment.rail === 'transfer' ? 'перевод подтвердил исполнитель' : railLabel(a.payment.rail, a.payment.provider);
      const verb = a.payment.kind === 'prepayment' ? 'получена' : 'получен';
      return `${kindLabel(a.payment.kind)} ${sum} ${verb} (${how})`;
    }
    case 'payment.canceled':
      if (payload.reason === 'rail_switch' || payload.reason === 'client_cancelled_rail') return 'Клиент сменил способ оплаты';
      if (payload.reason === 'link_expired') return `Ссылка на оплату истекла: ${what}`;
      if (payload.reason === 'link_renewed' || payload.reason === 'link_creation_stale' || payload.reason === 'superseded_by_late_success') return null;
      return `Оплата отменена: ${what}`;
    case 'payment.succeeded_late':
      return payload.refund_required ? 'Оплата пришла, когда сделка её уже не ждала: её нужно вернуть клиенту' : 'Оплата пришла позже срока ссылки и учтена';
    case 'deal.done':
      return 'Исполнитель отметил работу выполненной';
    case 'deal.accepted':
      return 'Клиент принял работу';
    case 'deal.remarks':
      return `Клиент оставил замечания: «${text(payload.text)}»`;
    case 'deal.fixed':
      return 'Исполнитель исправил замечания';
    case 'receipt.attached':
      return 'Исполнитель приложил чек';
    case 'deal.closed_without_receipt':
      return 'Исполнитель закрыл сделку без чека';
    case 'deal.closed':
      return 'Сделка закрыта, квитанция отправлена обеим сторонам';
    case 'deal.cancelled': {
      const who = payload.by === 'client' ? 'Клиент' : payload.by === 'system' ? 'Система' : 'Исполнитель';
      const reason = text(payload.reason);
      return reason ? `${who} отменил(а) сделку: «${reason}»` : `${who} отменил(а) сделку`;
    }
    case 'refund.confirmed':
      return payload.by === 'client' ? 'Клиент подтвердил, что получил возврат' : 'Исполнитель отметил, что вернул предоплату';
    default:
      return null;
  }
}

// --- «Другое время» (ЗАДАЧА_08 D, SPEC §7.10) ---

/** Выбор на месте карточки после «Предложить изменения»: время из календаря или текстом. */
export const ASK_CHANGE_KIND = 'Что изменить? Выберите другое время в календаре исполнителя или напишите текстом';

/** Текст запроса изменений при предложении времени: попадёт в следующую версию как «клиент просил». */
export function TIME_PROPOSAL_TEXT(at: Date): string {
  return `Предлагаю другое время: ${formatDateTime(at)}`;
}

/** N3T — исполнителю: клиент выбрал время в календаре. */
export function N3T(a: { client: string; id: string; at: Date }): string {
  return notice(`🗓 ${esc(a.client)} предлагает другое время по #${a.id}: ${formatDateTime(a.at)}.`, 'Примите одним нажатием или предложите другое время.');
}

/** Подпись кнопки «Принять»: короткая дата, чтобы не обрезалась (своим рядом). */
export function acceptTimeLabel(at: Date): string {
  return `Принять ${formatWeekdayDay(at)}, ${formatTime(at)}`;
}

export const TIME_ACCEPTED_ACK = 'Время принято. Клиент получил новую версию условий и подтвердит её';
export const TIME_TAKEN_SELLER = 'Это время уже занято другой сделкой. Предложение снято, предложите клиенту другое время';
export function TIME_TAKEN_CLIENT(a: { id: string; at: Date }): string {
  return notice(`🗓 Исполнитель не может ${formatDateTime(a.at)} по #${a.id}: это время уже занято.`, 'Выберите другое время.');
}
export const TIME_STALE = 'Это предложение уже неактуально: условия изменились или время прошло. Карточка обновлена';

// --- надёжность исполнителя и оценка клиента (ЗАДАЧА_08 E, SPEC §7.11) ---

/** Строка надёжности: «120 сделок, 98 % без споров» (без спорных — только число сделок). */
export function reliabilityLine(r: { closed: number; noDisputePercent: number | null }): string {
  const base = dealsWord(r.closed);
  return r.noDisputePercent === null ? base : `${base}, ${r.noDisputePercent} % без споров`;
}

/** R1 — клиенту после закрытия: одна просьба оценить, оценку видит только исполнитель. */
export function R1(a: { id: string; title: string }): string {
  return notice(`⭐ Оцените работу по #${a.id}: ${esc(a.title)}.`, 'От 1 до 5, где 5 значит отлично. Оценку увидит только исполнитель.');
}

export function RATING_THANKS(score: number): string {
  return `Спасибо, ваша оценка ${score} из 5. Можно добавить комментарий одним сообщением или нажать «${BTN.noComment}»`;
}
/** Та же благодарность без приглашения к комментарию: после того как комментарий пришёл. */
export function RATING_THANKS_DONE(score: number): string {
  return `Спасибо, ваша оценка ${score} из 5`;
}
export const RATING_ALREADY = 'Оценка по этой сделке уже сохранена';
export const RATING_DONE = 'Спасибо, оценка сохранена';
export const RATING_COMMENT_SAVED = 'Спасибо, комментарий передан исполнителю';
export const RATING_COMMENT_TOO_LONG = 'Слишком длинно: до 500 символов';

/** R2 — исполнителю: клиент оценил работу. */
export function R2(a: { client: string; id: string; score: number }): string {
  return notice(`⭐ ${esc(a.client)} оценил(а) работу по #${a.id}: ${a.score} из 5.`);
}

/** R3 — исполнителю: комментарий клиента к оценке. */
export function R3(a: { client: string; id: string; comment: string }): string {
  return `💬 Комментарий ${esc(a.client)} к оценке по #${a.id}:\n${quote(esc(a.comment))}`;
}


// --- подписи кнопок: DESIGN_BRIEF §2.8, колонка «После». Коды callback не меняются (callbacks.ts) ---
// Глагол или результат от первого лица, первая буква прописная, без эмодзи (кроме 🧪 у демо и теста),
// деструктивное действие называет объект.

export const BTN = {
  newDeal: 'Новая сделка',
  myDeals: 'Сделки',
  settings: 'Настройки',
  help: 'Как это работает',
  tryIt: '🧪 Попробовать',
  tryDemo: '🧪 Демо: пройти одному',
  exampleDeal: 'Пример: позвать клиента',
  menu: 'Меню',
  sendToMax: 'Отправить клиенту',
  copyLink: 'Скопировать ссылку',
  editTerms: 'Изменить условия',
  openAsClient: '🧪 Открыть как клиент',
  cancelDeal: 'Отменить сделку',
  remindClient: 'Напомнить клиенту',
  keepAsIs: 'Оставить как есть',
  confirm: 'Подтверждаю',
  requestChanges: 'Предложить изменения',
  decline: 'Отказаться',
  declineYes: 'Отказаться от сделки',
  payByLink: 'Оплатить по ссылке',
  payByTransfer: 'Перевести по реквизитам',
  transferDone: 'Я перевёл(а)',
  transferReceived: 'Получил(а)',
  transferNotReceived: 'Не вижу перевода',
  transferCancel: 'Другой способ оплаты',
  /** Подпись собирается с суммой: payButtonLabel → «Оплатить 900 ₽». */
  goToPayment: 'Оплатить',
  checkPayment: 'Проверить оплату',
  emulatePayment: '🧪 Эмулировать оплату',
  newLink: 'Новая ссылка',
  done: 'Выполнено',
  accept: 'Принимаю',
  remarks: 'Есть замечания',
  fixed: 'Исправлено',
  attachReceipt: 'Приложить чек',
  closeWithoutReceipt: 'Закрыть без чека',
  closeWithoutReceiptYes: 'Закрыть без чека',
  cancelYes: 'Отменить сделку',
  noReason: 'Без причины',
  receiptPdf: 'Квитанция PDF',
  repeat: 'Повторить сделку',
  refundSent: 'Вернул(а) предоплату',
  refundReceived: 'Возврат получил(а)',
  open: 'Открыть сделку',
  schedule: 'Расписание',
  back: 'Назад',
  keepDeal: 'Оставить сделку',
  otherTime: 'Другое время',
  writeText: 'Написать текстом',
  proposeOther: 'Предложить другое время',
  noComment: 'Без комментария',
};
