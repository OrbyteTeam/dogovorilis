// Единственное место, где живут тексты бота и уведомлений.
// Первоисточник — docs/SPEC.md §6 (эталон), плюс §5.1 (эмодзи статусов), §5.3 (возврат предоплаты),
// §5.5 (кнопки по ролям), §9.1 (рейл «перевод»), §10.2 (напоминания), §12 (демо-режим)
// и docs/DESIGN.md §6 (порядок строк карточки, лимиты 12 строк / 1200 символов).
//
// Модуль намеренно «чистый»: из зависимостей — только доменные типы и форматтеры, никакого config,
// БД и SDK. Так тексты проверяются юнит-тестами без окружения, а часовой пояс берётся по умолчанию
// из domain/time.ts (APP_TIMEZONE подставляется на уровне транспорта, если когда-то понадобится).

import type { CancelRule, CardRole, DealStatus, PaymentProvider, PaymentRail, PaymentStatus, ReminderKind, Role, TermsField } from './types.js';
import { formatMoney, prepaymentPercent } from './domain/money.js';
import { dayAndTime, formatDateShort, formatDateTime, formatDateTimeShort, formatDayMonth } from './domain/time.js';

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

/** Человеческая подпись рейла: «перевод по реквизитам» | «ссылка ЮKassa, тест» | «СБП Т-Банк, DEMO». */
export function railLabel(rail: PaymentRail, provider: PaymentProvider): string {
  if (rail === 'transfer') return 'перевод по реквизитам';
  if (provider === 'yookassa') return 'ссылка ЮKassa, тест';
  if (provider === 'tbank') return 'СБП Т-Банк, DEMO';
  return 'ссылка на оплату';
}

/** Демо-карточка клиента (SPEC §12): префиксная строка, чтобы её нельзя было спутать с настоящей. */
export const DEMO_CARD_PREFIX = '🧪 **ДЕМО — так видит клиент**';

/** В демо обе стороны сидят в одном чате, поэтому уведомление помечается получателем (SPEC §12). */
export function demoNotifyPrefix(to: 'seller' | 'client'): string {
  return to === 'client' ? '🧪 (клиенту) ' : '🧪 (исполнителю) ';
}

// --- команды для setMyCommands (SPEC §6.1) ---

/** `name` — без слэша: так его ждёт `PATCH /me/commands` (CONTRACTS §1). */
export const COMMANDS: readonly { name: string; description: string }[] = [
  { name: 'start', description: 'Главное меню' },
  { name: 'new', description: 'Новая сделка' },
  { name: 'deals', description: 'Мои сделки' },
  { name: 'settings', description: 'Настройки' },
  { name: 'help', description: 'Как это работает' },
  { name: 'cancel', description: 'Отменить ввод' },
];

// --- меню, помощь, общее ---

export const S1 = `👋 Это «Договорились» — карточка договорённости прямо в чате MAX.

Вы описываете, что, когда и за сколько; клиент подтверждает одной кнопкой; предоплата, статус, напоминания, чек и квитанция — здесь же, у обеих сторон.

Что дальше?`;

export function S2(sellerName: string): string {
  return `Исполнитель **${esc(sellerName)}** предлагает договорённость. Проверьте условия и подтвердите — или предложите изменения.`;
}

/** «🔁 Повторить» с тем же клиентом (ЗАДАЧА_04 F): карточка приходит клиенту сама, без ссылки — над ней это приветствие. */
export function S2_REPEAT(sellerName: string): string {
  return `Исполнитель **${esc(sellerName)}** предлагает новую договорённость — проверьте условия и подтвердите.`;
}

/** Исполнителю: карточка повторной сделки ушла клиенту в его чат с ботом. */
export function REPEAT_CARD_SENT(clientName: string): string {
  return `📨 Карточка отправлена клиенту (${esc(clientName)}) — ждём подтверждения.`;
}

/** Карточку повторной сделки клиенту доставить не удалось (MAX не ответил) — ссылка откроет её у него. */
export function REPEAT_CARD_FAILED(clientName: string, link: string): string {
  return `Не получилось отправить карточку клиенту (${esc(clientName)}). Перешлите ему ссылку — карточка откроется у него: ${link}`;
}

export const S3 = 'Я понимаю только кнопки и команды. Откройте /deals или /new.';

/**
 * Исполнитель открыл собственную ссылку на сделку. Карточки у него уже есть и правятся на месте,
 * поэтому без этой строки нажатие ссылки выглядело бы как «ничего не произошло» (SPEC §14 п. 6).
 */
export function S4(id: string, demo: boolean): string {
  // В демо-сделке клиент — сам исполнитель, поэтому кнопок шеринга в её карточке нет
  // и звать по этой ссылке некого: посторонний получит E4. Не отправляем человека искать
  // кнопки, которых он не найдёт.
  if (demo) {
    return `Это ваша демо-сделка #${id} — клиент в ней вы сами. Чтобы позвать настоящего клиента, создайте обычную сделку: «${BTN.newDeal}».`;
  }
  return `Это ваша сделка #${id}, вы её исполнитель. Чтобы пригласить клиента, отправьте ему ссылку кнопкой «${BTN.sendToMax}» или «${BTN.copyLink}» в карточке.`;
}

export const H1 = `Как это работает
1. Исполнитель создаёт карточку: что, когда, сколько, предоплата, правило отмены.
2. Отправляет ссылку клиенту в любой чат MAX.
3. Клиент подтверждает условия кнопкой и вносит предоплату — по ссылке или переводом.
4. После выполнения клиент принимает работу, оплачивает остаток.
5. Исполнитель прикладывает чек; обе стороны получают квитанцию PDF.
Деньги идут напрямую исполнителю. Мы не платёжный агент и не храним реквизиты карт.
Тестовый режим: оплата по ссылке проходит через тестовый магазин — реальные деньги не списываются.`;

export const INPUT_CANCELLED = 'Ввод отменён';

// BTN объявлен ниже, а константы вычисляются при загрузке модуля, поэтому подписи кнопок — литералами.
export const NEW_DEAL_PROMPT = `Новая сделка: заполните форму в мини-приложении — условия под себя.
Посмотреть продукт за две минуты: «Демо: пройти одному» — обе стороны в этом чате; «Сделка-пример: позвать клиента» — готовая сделка, ссылку можно сразу отправить второму человеку.`;

/** Экран «🧪 Попробовать» из меню (ЗАДАЧА_04 A3). */
export const TRY_PROMPT = `Два способа посмотреть продукт за две минуты:
• «Демо: пройти одному» — обе карточки придут сюда, вы нажимаете и за исполнителя, и за клиента.
• «Сделка-пример: позвать клиента» — настоящая сделка с готовыми условиями: отправьте ссылку второму человеку, он подтвердит у себя.`;

/** То же без демо (DEMO_MODE=false): остаётся одна сделка-пример. */
export const TRY_PROMPT_NO_DEMO = `Посмотреть продукт за две минуты: «Сделка-пример: позвать клиента» — настоящая сделка с готовыми условиями. Отправьте ссылку второму человеку, он подтвердит у себя.`;

/**
 * Текст приглашения для шеринга — без ссылки: ссылка передаётся отдельно (`shareMaxContent({ text, link })`),
 * иначе в сообщении она оказывается дважды (ЗАДАЧА_04 A1). Текст — не markdown, экранировать не нужно.
 */
export function shareInvite(title: string, scheduledAt: Date | null): string {
  const what = oneLine(title);
  return scheduledAt
    ? `Подтвердите нашу договорённость: ${what}, ${formatDateTime(scheduledAt)}`
    : `Подтвердите нашу договорённость: ${what}`;
}

// --- «/deals» в чате (ЗАДАЧА_04 A2) ---

export const DEALS_HEADER = 'Активные сделки (время — МСК):';
export const DEALS_SELLER = '**Я исполнитель**';
export const DEALS_CLIENT = '**Я клиент**';
export const DEALS_EMPTY = 'Активных сделок нет. Создайте первую — это займёт полминуты.';

export function DEALS_MORE(n: number): string {
  return `…и ещё ${n} — в «${BTN.myDeals}»`;
}

type DealsRow = { title: string; scheduledAt: Date | null; totalKopecks: number; status: DealStatus; role: 'seller' | 'client'; demo: boolean };

function listDate(at: Date | null, now: Date): { day: string; time: string } | null {
  return at ? dayAndTime(at, undefined, now) : null;
}

/** `Пн 28 сен, 14:00 · [Маникюр с покрытием](ссылка) · 2 500 ₽ · ждём предоплату` — без кода и эмодзи-статусов. */
export function dealsLine(row: DealsRow, link: string, now = new Date()): string {
  const d = listDate(row.scheduledAt, now);
  const parts = [
    d ? `${d.day}, ${d.time}` : 'без даты',
    `[${esc(oneLine(row.title))}](${link})`,
    formatMoney(row.totalKopecks),
    statusShort(row.status, row.role),
  ];
  return `${parts.join(' · ')}${row.demo ? ' · демо' : ''}`;
}

/** Подпись кнопки под списком: `Пн 28 сен 14:00 · Маникюр`. Длинное название обрезается — MAX режет подписи сам. */
export function dealsButton(row: Pick<DealsRow, 'title' | 'scheduledAt'>, now = new Date()): string {
  const d = listDate(row.scheduledAt, now);
  return `${d ? `${d.day} ${d.time}` : 'Без даты'} · ${clip(oneLine(row.title), 18)}`;
}

/** Ответ на «📝 Сделка-пример для клиента» (ЗАДАЧА_03 B). */
export function EXAMPLE_CREATED(id: string): string {
  return `📝 Создана сделка #${id}. Это настоящая сделка с условиями-примером: отправьте ссылку клиенту — он увидит карточку и сможет подтвердить. Условия под себя — в «${BTN.newDeal}».
Карточка — ниже, ссылка и кнопки «${BTN.sendToMax}» / «${BTN.copyLink}» — в ней.`;
}

export function DEMO_CREATED(id: string, link: string): string {
  return `🧪 Создана демо-сделка #${id}. Ниже — две карточки: как видите её вы и как видит клиент.\nСсылка клиента: \`${link}\``;
}

export const TOO_MANY_TRIALS = 'Слишком много пробных сделок, подождите — не больше 5 в час.';

export const DEAL_FINISHED_LINE = 'Сделка завершена';

/** Старое сообщение карточки после того, как она показана заново внизу чата. */
export function CARD_MOVED(id: string): string {
  return `↓ Карточка #${id} — ниже, актуальная версия.`;
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

// По одному тексту на пару (статус, роль) — SPEC §6.4. Демо-клиент читает клиентские тексты.
const STATUS_TEXT: Record<DealStatus, (a: StatusArgs) => { seller: string; client: string }> = {
  awaiting_confirmation: () => ({
    seller: 'Ждём подтверждения клиента',
    client: 'Подтвердите условия',
  }),
  changes_requested: () => ({
    seller: 'Клиент предложил изменения — измените условия или оставьте как есть',
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
  scheduled: (a) => ({
    seller: a.scheduledAt
      ? `Всё согласовано на ${formatDateTime(a.scheduledAt)}. Отметьте «Выполнено», когда закончите`
      : 'Всё согласовано. Отметьте «Выполнено», когда закончите',
    client: a.scheduledAt ? `Всё согласовано на ${formatDateTime(a.scheduledAt)}. Ждём выполнения` : 'Всё согласовано. Ждём выполнения',
  }),
  awaiting_acceptance: () => ({
    seller: 'Ждём приёмку клиентом',
    client: 'Примите работу или оставьте замечания',
  }),
  remarks: () => ({
    seller: 'Клиент оставил замечания — исправьте и сообщите',
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

// Статус одним-двумя словами — для строк списков и расписания, где эмодзи-статусы не используются (ЗАДАЧА_04 A2).
const STATUS_SHORT: Record<DealStatus, { seller: string; client: string }> = {
  awaiting_confirmation: { seller: 'ждём подтверждения', client: 'подтвердите условия' },
  changes_requested: { seller: 'клиент предложил изменения', client: 'ждём новые условия' },
  declined: { seller: 'клиент отказался', client: 'вы отказались' },
  expired: { seller: 'срок истёк', client: 'срок истёк' },
  awaiting_prepayment: { seller: 'ждём предоплату', client: 'внесите предоплату' },
  scheduled: { seller: 'запланировано', client: 'запланировано' },
  awaiting_acceptance: { seller: 'ждём приёмку', client: 'примите работу' },
  remarks: { seller: 'есть замечания', client: 'ждём исправлений' },
  awaiting_payment: { seller: 'ждём остаток', client: 'оплатите остаток' },
  paid: { seller: 'оплачено, нужен чек', client: 'ждём чек' },
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

export function cancelRuleText(rule: CancelRule): string {
  return CANCEL_RULE_TEXT[rule];
}

// --- карточка (§6.4). Данные собирает cards.ts, здесь только текст ---

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
  paymentLine: string | null;
  /** Реквизиты и подсказка рейла «перевод» в карточке клиента (§6.4) — заменяют строку оплаты. */
  transferLines?: string[] | null;
  receiptLine: string | null;
  refundLine: string | null;
  /** Отмена после «Я перевёл(а)» без подтверждения исполнителя — сверить поступление (ЗАДАЧА_03 F7). */
  claimLine?: string | null;
  clientLink: string | null;
  /** Номер текущей версии условий и когда она создана: при версии > 1 — строка «Версия N · условия изменены …» (T5). */
  version?: number;
  versionCreatedAt?: Date | null;
};

const CARD_MAX_LINES = 12;
const CARD_MAX_CHARS = 1200;
const DESCRIPTION_BUDGET = 320;

/** Пользовательский текст в одну строку: переносы ломают лимит строк карточки. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function card(v: CardView): string {
  // Сборка параметризована бюджетом описания: если карточка не влезает в 1200 символов, сжимаем именно его.
  const build = (descBudget: number): string => {
    const head: string[] = [];
    if (v.role === 'client_demo') head.push(DEMO_CARD_PREFIX);
    head.push(`${statusEmoji(v.status)} **${esc(oneLine(v.title))}** · #${v.publicId}`);
    head.push(`Статус: ${statusText(v.status, v.role, v)}`);
    const versionAt = head.length;
    if (v.version && v.version > 1 && v.versionCreatedAt) {
      head.push(`Версия ${v.version} · условия изменены ${formatDateTimeShort(v.versionCreatedAt)}`);
    }

    const description = v.description ? esc(clip(oneLine(v.description), descBudget)) : '—';
    const money =
      v.prepaymentKopecks > 0
        ? `**${formatMoney(v.totalKopecks)}** · предоплата **${formatMoney(v.prepaymentKopecks)}** (${prepaymentPercent(v.totalKopecks, v.prepaymentKopecks)}%)`
        : `**${formatMoney(v.totalKopecks)}** · без предоплаты`;

    const terms: (string | null)[] = [
      `📌 ${description}`,
      `🗓 ${v.scheduledAt ? formatDateTime(v.scheduledAt) : 'без даты'}`,
      `💰 ${money}`,
      `↩️ ${cancelRuleText(v.cancelRule)}`,
      v.hasPhoto ? '🖼 макет приложён' : null,
    ];

    const transfer = v.transferLines?.length ? v.transferLines : null;
    const base: (string | null)[] = [
      `👤 Исполнитель: ${esc(oneLine(v.sellerName))}`,
      `👤 Клиент: ${v.clientName ? esc(oneLine(v.clientName)) : 'ещё не открыл ссылку'}`,
      ...(transfer ?? [v.paymentLine]),
    ];
    const receiptAt = base.length;
    const linkAt = base.length + 3;
    const parties: (string | null)[] = [
      ...base,
      v.receiptLine,
      v.refundLine,
      v.claimLine ?? null,
      v.clientLink ? `🔗 Ссылка для клиента: \`${v.clientLink}\`` : null,
    ];

    // Гарантия DESIGN §6: не больше 12 строк. В реальных статусах строк ≤ 12 и так; на всякий
    // случай убираем необязательные в порядке возрастания важности: макет → ссылка → версия → строка чека.
    const countLines = () => head.filter(Boolean).length + terms.filter(Boolean).length + parties.filter(Boolean).length;
    const dropOrder: (() => void)[] = [
      () => {
        terms[4] = null; // 🖼 макет приложён
      },
      () => {
        parties[linkAt] = null; // 🔗 ссылка для клиента (она же в кнопке «Скопировать ссылку»)
      },
      () => {
        if (head.length > versionAt) head.splice(versionAt, 1); // «Версия N · условия изменены …»
      },
      () => {
        parties[receiptAt] = null; // строка чека
      },
    ];
    for (const dropIt of dropOrder) {
      if (countLines() <= CARD_MAX_LINES) break;
      dropIt();
    }

    const separators = Math.max(0, Math.min(2, CARD_MAX_LINES - countLines()));
    const lines: string[] = [...head];
    if (separators >= 1) lines.push('');
    lines.push(...terms.filter((l): l is string => Boolean(l)));
    if (separators >= 2) lines.push('');
    lines.push(...parties.filter((l): l is string => Boolean(l)));
    return lines.join('\n');
  };

  let budget = DESCRIPTION_BUDGET;
  let text = build(budget);
  while (text.length > CARD_MAX_CHARS && budget > 24) {
    budget = Math.max(24, budget - 48);
    text = build(budget);
  }
  return text.length > CARD_MAX_CHARS ? clip(text, CARD_MAX_CHARS) : text;
}

// --- строки внутри карточки ---

export function paymentLine(a: {
  kind: 'prepayment' | 'final';
  state: 'awaiting' | 'link_issued' | 'link_expired' | 'link_canceled' | 'transfer_chosen' | 'claimed' | 'received';
  sumKopecks: number;
  at: Date | null;
  rail: PaymentRail | null;
  provider: PaymentProvider | null;
  linkExpiresAt: Date | null;
  /** cancellation_details.reason провайдера — показывается как есть (SPEC §9.2). */
  cancelReason?: string | null;
  /** Кто читает строку: «клиент сообщил о переводе» исполнителю и «вы сообщили» — клиенту. */
  viewer?: 'seller' | 'client';
}): string {
  const label = a.kind === 'prepayment' ? 'Предоплата' : 'Остаток';
  const sum = formatMoney(a.sumKopecks);
  const rail = a.rail && a.provider ? ` (${railLabel(a.rail, a.provider)})` : '';
  switch (a.state) {
    case 'awaiting':
      return `${label} ${sum} ждёт оплаты`;
    case 'link_issued':
      return a.linkExpiresAt
        ? `Ссылка на оплату ${sum} действует до ${formatDateTimeShort(a.linkExpiresAt)}`
        : `Ссылка на оплату ${sum} создана`;
    case 'link_expired':
      return `Ссылка на оплату ${sum} истекла — нужна новая`;
    case 'link_canceled':
      return a.cancelReason
        ? `Оплата ${sum} отменена: ${cancelReasonText(a.cancelReason)}`
        : `Оплата ${sum} отменена — можно создать новую ссылку`;
    case 'transfer_chosen':
      return `${label} ${sum}: клиент выбрал перевод по реквизитам — ждём перевода`;
    case 'claimed': {
      const when = a.at ? ` ${formatDateTimeShort(a.at)}` : '';
      return a.viewer === 'client'
        ? `Вы сообщили о переводе ${sum}${when}. Ждём подтверждения исполнителя`
        : `${label} ${sum}: клиент сообщил о переводе${when} — проверьте поступление и подтвердите кнопкой`;
    }
    case 'received': {
      const verb = a.kind === 'prepayment' ? 'получена' : 'получен';
      // Оплата тестовым магазином — прямо в строке, что денег не было (ЗАДАЧА_04 A4, SPEC §18).
      const how = a.rail === 'link' && a.provider === 'yookassa' ? ' — ссылка ЮKassa, тестовый магазин, деньги не списывались' : rail;
      return a.at ? `${label} ${verb} ${formatDateTimeShort(a.at)}${how}` : `${label} ${verb}${how}`;
    }
  }
}

export function receiptLine(a: { attachedAt: Date | null; deadline: Date | null; taxModeNone: boolean }): string {
  if (a.attachedAt) return `Файл чека приложен ${formatDateShort(a.attachedAt)} (содержимое не проверялось)`;
  if (a.taxModeNone) return 'Чек не требуется (исполнитель работает без чека)';
  return a.deadline ? `Чек: до ${formatDayMonth(a.deadline)}` : 'Чек: ждём от исполнителя';
}

/**
 * Сделку отменили, когда клиент уже сообщил о переводе, а исполнитель его не подтвердил (ЗАДАЧА_03 F7).
 * Продукт перевод не видит — строка в карточке, в N15 и отдельным сообщением обеим сторонам.
 */
export function claimedTransferOnCancel(a: { sumKopecks: number; at: Date | null }): string {
  const when = a.at ? ` ${formatDateTimeShort(a.at)}` : '';
  return `Клиент сообщал о переводе ${formatMoney(a.sumKopecks)}${when} — проверьте поступление и верните при необходимости`;
}

export function refundLine(a: {
  prepaymentKopecks: number;
  expected: boolean | null;
  /** «Вернул(а)» исполнителя и «Возврат получил(а)» клиента (SPEC §5.3, ЗАДАЧА_03 H1) */
  sentAt?: Date | null;
  receivedAt?: Date | null;
}): string | null {
  if (a.prepaymentKopecks <= 0 || a.expected === null) return null;
  const sum = formatMoney(a.prepaymentKopecks);
  if (!a.expected) return `Предоплата ${sum} не возвращается по правилу отмены`;
  if (a.receivedAt) return `Возврат ${sum} получен клиентом ${formatDateTimeShort(a.receivedAt)}`;
  if (a.sentAt) return `Исполнитель вернул ${sum} ${formatDateTimeShort(a.sentAt)} — ждём подтверждения клиента`;
  return `Предоплата ${sum}: ожидается возврат`;
}

/** Уведомления второй стороне об отметке возврата (H1). */
export function REFUND_SENT_NOTICE(a: { id: string; sumKopecks: number }): string {
  return `💸 Исполнитель сообщает, что вернул ${formatMoney(a.sumKopecks)} по отменённой #${a.id}. Проверьте поступление и нажмите «${BTN.refundReceived}».`;
}

export function REFUND_RECEIVED_NOTICE(a: { client: string; id: string; sumKopecks: number }): string {
  return `✅ ${esc(a.client)} подтвердил(а) возврат ${formatMoney(a.sumKopecks)} по #${a.id}.`;
}

export const REFUND_SENT_ACK = 'Отметили возврат — клиенту ушло уведомление.';
export const REFUND_RECEIVED_ACK = 'Спасибо — возврат отмечен, исполнитель получил уведомление.';

// --- уведомления второй стороне (§6.5). id = public_id сделки ---

export function N1(a: { client: string; id: string }): string {
  return `👀 ${esc(a.client)} открыл(а) карточку #${a.id}.`;
}

export function N2(a: { client: string; id: string; prepaymentKopecks: number; scheduledAt: Date | null }): string {
  const tail =
    a.prepaymentKopecks > 0
      ? `Ждём предоплату ${formatMoney(a.prepaymentKopecks)}`
      : a.scheduledAt
        ? `Всё согласовано на ${formatDateTime(a.scheduledAt)}`
        : 'Всё согласовано';
  return `✅ ${esc(a.client)} подтвердил(а) условия #${a.id}. ${tail}.`;
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
 * Что изменилось в новой версии — словами, по порядку карточки: «срок → сб, 27 сен, 14:00 (МСК); сумма → 3 000 ₽,
 * предоплата → 600 ₽». Сумма и предоплата — одной группой через запятую, остальное — через «;».
 */
export function termsChanges(changed: readonly TermsField[], v: TermsValues): string {
  const has = (f: TermsField) => changed.includes(f);
  const money = [
    has('total') ? `сумма → ${formatMoney(v.totalKopecks)}` : null,
    has('prepayment') ? `предоплата → ${v.prepaymentKopecks > 0 ? formatMoney(v.prepaymentKopecks) : 'без предоплаты'}` : null,
  ].filter(Boolean);
  const groups = [
    has('title') ? `что делаем → «${esc(oneLine(v.title))}»` : null,
    has('description') ? 'уточнения → изменены' : null,
    has('scheduled_at') ? `срок → ${v.scheduledAt ? formatDateTime(v.scheduledAt) : 'без даты'}` : null,
    money.length ? money.join(', ') : null,
    has('cancel_rule') ? `правило отмены → ${cancelRuleText(v.cancelRule).toLowerCase()}` : null,
  ].filter(Boolean);
  return groups.join('; ');
}

/** N4 (SPEC §6.5): клиенту — новая версия условий и только то, что в ней изменилось. */
export function N4(a: { id: string; version: number; changed?: readonly TermsField[]; terms?: TermsValues }): string {
  const list = a.changed?.length && a.terms ? termsChanges(a.changed, a.terms) : '';
  return `✏️ Исполнитель изменил условия #${a.id} (версия ${a.version})${list ? `: ${list}` : ''}. Проверьте и подтвердите.`;
}

/** Ответ исполнителю после T5 (N4a): дошла ли новая версия до клиента. */
export function TERMS_UPDATED(a: { id: string; version: number; client: 'notified' | 'no_client' | 'not_delivered' }): string {
  if (a.client === 'notified') return `✏️ Условия #${a.id} обновлены, клиент получил версию ${a.version}.`;
  if (a.client === 'no_client') return `✏️ Условия #${a.id} обновлены — клиент увидит версию ${a.version}, когда откроет ссылку.`;
  return `✏️ Условия #${a.id} обновлены — клиент увидит версию ${a.version} в карточке, когда вернётся в чат с ботом.`;
}

export function N5(a: { id: string }): string {
  return `ℹ️ Исполнитель оставил условия #${a.id} без изменений. Подтвердите или откажитесь.`;
}

export function N6(a: { client: string; id: string }): string {
  return `⛔ ${esc(a.client)} отказался(ась) от #${a.id}.`;
}

export function N7(a: { id: string }): string {
  return `⌛ Срок подтверждения #${a.id} истёк (72 ч). Сделка закрыта. Можно создать новую.`;
}

export function N8(a: { id: string; sumKopecks: number; rail: PaymentRail; provider: PaymentProvider }): string {
  return `💸 Предоплата ${formatMoney(a.sumKopecks)} по #${a.id} получена (${railLabel(a.rail, a.provider)}).`;
}

export function N9(a: { id: string }): string {
  return `✔️ Исполнитель отметил #${a.id} выполненной. Примите работу или оставьте замечания.`;
}

export function N10(a: { client: string; id: string; remainingKopecks: number }): string {
  const tail = a.remainingKopecks > 0 ? `Ждём остаток ${formatMoney(a.remainingKopecks)}` : 'Оплачено полностью';
  return `👍 ${esc(a.client)} принял(а) работу по #${a.id}. ${tail}.`;
}

export function N11(a: { client: string; id: string; text: string }): string {
  return `⚠️ ${esc(a.client)} оставил(а) замечания по #${a.id}:\n${quote(esc(a.text))}`;
}

export function N12(a: { id: string }): string {
  return `🔧 Исполнитель сообщает: замечания по #${a.id} исправлены. Проверьте ещё раз.`;
}

export function N13(a: { id: string; deadline: Date }): string {
  return `🧾 #${a.id} оплачена полностью. Сформируйте чек в «Мой налог» сейчас и приложите его сюда. Для безналичных расчётов закон допускает до ${formatDayMonth(a.deadline)}.`;
}

export function N14(a: { id: string; withReceipt: boolean }): string {
  return `✅ Сделка #${a.id} закрыта. Квитанция во вложении${a.withReceipt ? ', чек — выше' : ''}.`;
}

const RECEIPT_STATUS_WORD: Partial<Record<DealStatus, string>> = {
  closed: 'сделка закрыта',
  cancelled: 'сделка отменена',
  declined: 'клиент отказался',
  expired: 'срок подтверждения истёк',
};

/** Квитанция по кнопке «📄 Квитанция PDF» — подпись по фактическому статусу, а не «закрыта» всегда. */
export function RECEIPT_ON_DEMAND(a: { id: string; status: DealStatus }): string {
  const word = RECEIPT_STATUS_WORD[a.status];
  return `📄 Квитанция по #${a.id}${word ? ` — ${word}` : ''}.`;
}

export function N15(a: {
  id: string;
  by: 'seller' | 'client' | 'system';
  reason: string | null;
  refundLine: string | null;
  /** claimedTransferOnCancel — если клиент успел сообщить о переводе (ЗАДАЧА_03 F7). */
  claimLine?: string | null;
}): string {
  const by: Record<Role, string> = { seller: 'исполнителем', client: 'клиентом', system: 'автоматически' };
  const reason = a.reason ? `: ${esc(oneLine(a.reason))}` : '';
  const refund = a.refundLine ? ` ${a.refundLine}` : '';
  const claim = a.claimLine ? `\n${a.claimLine}.` : '';
  return `🚫 #${a.id} отменена ${by[a.by]}${reason}.${refund}${claim}`;
}

export function N16(a: { id: string; context: string }): string {
  // context — наш собственный текст (контекст статуса), пользовательского ввода в нём нет.
  return `🔔 Напоминание от исполнителя по #${a.id}: ${a.context}.`;
}

// --- рейл «перевод» (§9.1) ---

/**
 * Реквизиты прямо в карточке клиента (SPEC §6.4). Раньше они уходили отдельным ответом на нажатие,
 * и MAX тут же затирал его перерисовкой той же карточки: POST /answers правит нажатое сообщение.
 */
export function transferLines(a: { sumKopecks: number; payoutDetails: string }): string[] {
  return [
    `💸 Переведите **${formatMoney(a.sumKopecks)}** по реквизитам и нажмите «${BTN.transferDone}»:`,
    `\`${esc(oneLine(a.payoutDetails))}\``,
    testRailNotice('manual'),
  ];
}

export function P1(a: { sumKopecks: number; payoutDetails: string }): string {
  return `Переведите ${formatMoney(a.sumKopecks)} исполнителю:
\`${esc(a.payoutDetails)}\`
После перевода нажмите «Я перевёл(а)». Подсказка: перевод можно сделать прямо в чате MAX через «+» → «Перевести деньги» (СБП).`;
}

export function P2(a: { client: string; sumKopecks: number; id: string }): string {
  return `${esc(a.client)} сообщает о переводе ${formatMoney(a.sumKopecks)} по #${a.id}. Проверьте поступление.`;
}

/**
 * Второе «Не вижу перевода» подряд: дальше пинг-понг бесполезен. Предлагаем оплату по ссылке — там
 * подтверждение приходит от провайдера — и честно говорим, что продукт не арбитр (аудит 22.09 §4.3).
 */
export function P3_DISPUTE(a: { sumKopecks: number; linkAvailable: boolean }): string {
  const next = a.linkAvailable
    ? 'Если перевод не находится — оплатите по ссылке: там подтверждение приходит от платёжного сервиса.'
    : 'Если перевод не находится — договоритесь с исполнителем в чате.';
  return `Исполнитель снова не видит перевод ${formatMoney(a.sumKopecks)}. ${next}
Продукт не арбитр: спор решают стороны, хронология «перевёл / не вижу» — в квитанции.`;
}

export function P3(a: { sumKopecks: number }): string {
  return `Исполнитель пока не видит перевод ${formatMoney(a.sumKopecks)}. Проверьте операцию и нажмите «Я перевёл(а)» ещё раз (не раньше чем через 10 минут после прошлого) — или «↩️ Отмена перевода» и оплата по ссылке.`;
}

/**
 * Провайдер подтвердил оплату, которую сделка принять уже не может (ЗАДАЧА_03 F1): сделка отменена или этот
 * этап уже оплачен другим платежом. Деньги ушли исполнителю — вернуть их может только он, продукт их не касается.
 * Уходит обеим сторонам.
 */
export function LATE_PAYMENT_REFUND(a: { id: string; sumKopecks: number; dealCancelled: boolean }): string {
  const what = a.dealCancelled ? 'отменённой сделке' : 'уже оплаченному этапу';
  return `⚠️ Поступила оплата ${formatMoney(a.sumKopecks)} по ${what} #${a.id} — верните её клиенту.`;
}

/**
 * Причина отказа от провайдера — человеческим языком (CONTRACTS §2.7).
 * Полного перечня в документации нет, поэтому незнакомый код показываем как есть,
 * а не прячем: клиенту важно понять, звонить в банк или менять карту.
 */
const CANCEL_REASONS: Record<string, string> = {
  '3d_secure_failed': 'не пройдено подтверждение 3-D Secure',
  call_issuer: 'банк отклонил операцию — позвоните в банк',
  card_expired: 'истёк срок действия карты',
  fraud_suspected: 'операция отклонена как подозрительная',
  general_decline: 'банк отклонил операцию',
  insufficient_funds: 'недостаточно средств',
  invalid_card_number: 'неверный номер карты',
  invalid_csc: 'неверный код CVC',
  issuer_unavailable: 'банк-эмитент недоступен',
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

/** Ответ на «🔄 Проверить оплату», когда провайдер ещё не подтвердил платёж (SPEC §9.1 п. 3). */
export function paymentStillPending(status: PaymentStatus): string {
  if (status === 'expired') return 'Срок ссылки истёк. Нажмите «🆕 Новая ссылка» — создадим новую.';
  if (status === 'canceled') return 'Платёж отменён. Нажмите «🆕 Новая ссылка», чтобы попробовать ещё раз.';
  return 'Оплата пока не подтверждена. Если вы только что заплатили — подождите немного и нажмите ещё раз.';
}

/** Сообщение клиенту при выдаче ссылки (SPEC §9.1 п. 2, §9.2 п. 4). */
export function linkIssued(a: { sumKopecks: number; expiresAt: Date | null; provider: PaymentProvider }): string {
  // Срок и сумма уже в строке оплаты карточки под заметкой — здесь только что делать и пометка теста.
  // Форма тестового магазина принимает любые дату и CVC, но человек этого не знает (замечание тестировщика 26.09).
  const hint = a.provider === 'yookassa' ? YOOKASSA_TEST_CARD_HINT : testRailNotice(a.provider);
  return `💳 Ссылка готова — нажмите «${BTN.goToPayment}». После оплаты карточка обновится сама.\n${hint}`;
}

/** Тестовая карта ЮKassa — из документации провайдера (CONTRACTS §2, SPEC §9.2), не данные пользователя. */
export const YOOKASSA_TEST_CARD_HINT =
  '🧪 Тестовый магазин: подойдёт карта 5555 5555 5555 4444, любая будущая дата, любой CVC; деньги не списываются.';

/** Строка про тестовую среду провайдера для карточки и сообщения об оплате по ссылке (§9.2 п.4, §18). */
export function testRailNotice(provider: PaymentProvider): string {
  if (provider === 'yookassa') return '🧪 Тестовый магазин ЮKassa: реальные деньги не списываются.';
  if (provider === 'tbank') return '🧪 DEMO-терминал Т-Банка: реальные деньги не списываются.';
  return '🧪 Перевод продукт не видит — его подтверждают обе стороны кнопками.';
}

// --- запросы ввода (§6.6) ---

export const ASK_CHANGE_REQUEST = 'Напишите одним сообщением, что изменить (например: «давайте 15:00 и без предоплаты»).';
export const ASK_REMARKS = 'Опишите замечания одним сообщением.';
export const ASK_RECEIPT = 'Пришлите чек из «Мой налог» — фото или PDF одним сообщением.';
export const ASK_CANCEL_REASON = 'Причина отмены одним сообщением — или нажмите «Без причины».';

// --- подтверждения перед необратимым действием ---

export function CONFIRM_DECLINE(id: string): string {
  return `Отказаться от сделки #${id}? Исполнитель получит уведомление, вернуться к этой карточке будет нельзя.`;
}

export function CONFIRM_CANCEL(id: string): string {
  return `Отменить сделку #${id}? Действие необратимо, вторая сторона получит уведомление.`;
}

/** Последствие отмены для предоплаты — в том же вопросе, до подтверждения (SPEC §5.3). */
export function CANCEL_CONSEQUENCE(a: { by: 'seller' | 'client'; prepaymentKopecks: number; expected: boolean | null }): string | null {
  if (a.expected === null || a.prepaymentKopecks <= 0) return null;
  const sum = formatMoney(a.prepaymentKopecks);
  if (a.by === 'seller') return `Предоплату ${sum} нужно будет вернуть клиенту — тем же способом, каким она пришла.`;
  return a.expected
    ? `По правилу отмены предоплата ${sum} должна вернуться — исполнитель вернёт её тем же способом.`
    : `⚠️ По правилу отмены предоплата ${sum} не вернётся.`;
}

export function CONFIRM_CLOSE_WITHOUT_RECEIPT(id: string): string {
  return `Закрыть #${id} без чека? Квитанция уйдёт обеим сторонам, но чека из «Мой налог» в ней не будет.`;
}

// --- ошибки (§6.3, §6.6, §6.7). Дословно ---

export const E1 = 'Это действие уже недоступно — карточка обновлена.';
export const E2 = 'Не нашёл такую сделку. Проверьте ссылку или попросите исполнителя отправить её ещё раз.';
export const E3 = 'По этой ссылке уже подтверждает другой пользователь. Попросите исполнителя создать новую сделку.';
export const E4 = 'Это демонстрационная сделка исполнителя, к ней нельзя присоединиться.';
export const E5 = 'Слишком длинно — до 500 символов.';
export const E6 = 'Нужен файл или фото. Пришлите чек вложением.';
export const E7 = 'После выполнения работы отмена — только по согласованию с исполнителем. Напишите ему в чат.';
export const E8 = 'Время ожидания истекло. Нажмите кнопку ещё раз.';
export const E9 =
  'Не удалось создать ссылку на оплату (провайдер недоступен). Попробуйте через минуту или выберите перевод по реквизитам.';
export const E10 = 'Что-то пошло не так, мы уже разбираемся. Попробуйте ещё раз через минуту.';
export const E11 = 'Оплата по ссылке не подключена. Доступен перевод по реквизитам.';
export const E12 = 'Исполнитель не указал реквизиты для перевода. Попросите его заполнить их в Настройках.';
export const E13 = 'Подождите: повторно сообщить о переводе можно через 10 минут после прошлого раза — за это время исполнитель проверит поступление.';

/** «Подтверждаю» на карточке прежней версии: исполнитель успел изменить условия (T5, SPEC §5.2 T3). */
export const VERSION_CHANGED = 'Условия изменились — посмотрите новую версию.';

/** Двойной тап «Оплатить по ссылке», пока провайдер ещё создаёт первую ссылку (ЗАДАЧА_03 F3). */
export const LINK_IN_PROGRESS = 'Ссылка формируется, секунду — нажмите ещё раз.';

/** Кнопка чужой сделки (пересланная карточка, подобранный payload) — ЗАДАЧА_03 G1. */
export const NOT_YOUR_DEAL = 'Это не ваша сделка.';

/** Идемпотентный повтор: карточка уже в целевом состоянии (SPEC §5.2, конкурентность). */
export const ALREADY_DONE = 'Это уже сделано — карточка актуальна.';

// --- заметки над карточкой в ответ на нажатие (§6.4) ---

export const REMIND_SENT = '🔔 Напоминание отправлено клиенту.';
export const REMIND_COOLDOWN = 'Напоминание уже отправлено — следующее можно через 4 часа.';
export const REMIND_NO_CHAT = 'Клиент ещё не открывал бота — напоминание отправить некуда.';
export const RECEIPT_NOT_YET = 'Квитанция формируется после закрытия или отмены сделки.';
export const TRANSFER_CLAIMED = '📨 Сообщили исполнителю о переводе. Ждём его подтверждения.';
export const TRANSFER_NOT_SEEN_ACK = 'Отметили, что перевода не видно. Клиент получил подсказку.';
export const RAIL_CANCELLED = 'Способ оплаты отменён. Выберите другой.';
export const RECEIPT_FORWARDED = 'Файл чека от исполнителя (содержимое не проверялось):';
export const RECEIPT_PREPARING = '📄 Готовлю квитанцию — пришлю отдельным сообщением.';

// --- напоминания (§10.2) ---

/** Пометка к напоминанию, которое у демо-сделки пришло через 2 минуты вместо суток (domain/reminder/plan.ts). */
export const DEMO_ACCELERATED_NOTE = '🧪 в демо — ускорено: в настоящей сделке это напоминание придёт через сутки.';

/** Виды со своими текстами и данными: «через 30 минут» (eventSoon) и утренняя сводка (dailyDigest). */
export type PlainReminderKind = Exclude<ReminderKind, 'event_soon' | 'daily_digest'>;

/** Кому адресовано — решает план (§10.2); текст написан под эту сторону. `accelerated` — демо-сделка, срок ускорен. */
export function reminderText(
  kind: PlainReminderKind,
  a: { id: string; title: string; sumKopecks: number; scheduledAt: Date | null; deadline: Date | null; accelerated?: boolean },
): string {
  const text = reminderBody(kind, a);
  return a.accelerated ? `${text}\n${DEMO_ACCELERATED_NOTE}` : text;
}

function reminderBody(
  kind: PlainReminderKind,
  a: { id: string; title: string; sumKopecks: number; scheduledAt: Date | null },
): string {
  const sum = formatMoney(a.sumKopecks);
  switch (kind) {
    case 'client_not_opened':
      return `Клиент ещё не открыл карточку #${a.id}. Отправьте ссылку ещё раз или напомните ему.`;
    case 'confirmation_expired':
      // Это напоминание выполняет T8; текст получателям — тот же N7.
      return N7({ id: a.id });
    case 'prepayment_due':
      return `Напоминаем: предоплата ${sum} по #${a.id} ещё не внесена.`;
    case 'prepayment_overdue':
      return `Предоплата по #${a.id} не получена 2 дня. Напомнить клиенту или отменить?`;
    case 'event_tomorrow':
      return `Завтра ${a.scheduledAt ? formatDateTime(a.scheduledAt) : 'по плану'}: ${esc(oneLine(a.title))} (#${a.id}).`;
    case 'event_passed':
      return `Срок #${a.id} прошёл. Отметьте «Выполнено», когда закончите.`;
    case 'acceptance_due':
      return `Исполнитель ждёт приёмку по #${a.id}: примите работу или оставьте замечания.`;
    case 'payment_due':
      return `Остаток ${sum} по #${a.id} ждёт оплаты.`;
    case 'payment_overdue':
      return `Остаток по #${a.id} не оплачен 3 дня.`;
    case 'receipt_due':
      return `Не забудьте чек по #${a.id}: сформируйте в «Мой налог» и приложите.`;
    case 'receipt_deadline':
      return `До 9-го числа осталось 2 дня: чек по #${a.id} ещё не приложен (ст. 14 422-ФЗ).`;
    case 'refund_due':
      return `Сделка #${a.id} отменена двое суток назад, возврат ${sum} клиенту не отмечен. Верните тем же способом, каким получили, и нажмите «${BTN.refundSent}» в карточке.`;
  }
}

/**
 * «⏰ Через 30 минут» (ЗАДАЧА_04 B1). Исполнителю — кто придёт и что с предоплатой, клиенту — к кому и что.
 * Адреса отдельным полем нет (он в «Уточнениях») — в текст не добавляем; карточка — по кнопке «Открыть».
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
  if (a.to === 'client') return `⏰ Через 30 минут — ${title} у ${esc(oneLine(a.sellerName))}.`;
  const prepayment =
    a.prepayment === 'none'
      ? 'Без предоплаты.'
      : a.prepayment === 'received'
        ? 'Предоплата: получена.'
        : `Предоплата: ждём ${formatMoney(a.prepaymentKopecks)}.`;
  return `⏰ Через 30 минут: ${esc(oneLine(a.clientName))} — ${title}. ${prepayment}`;
}

/** «1 запись», «3 записи», «5 записей», «21 запись». */
export function recordsWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} запись`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} записи`;
  return `${n} записей`;
}

export type DigestLine = {
  scheduledAt: Date;
  title: string;
  /** null — клиент ещё не открыл ссылку */
  clientName: string | null;
  status: DealStatus;
  prepaymentKopecks: number;
  demo: boolean;
};

/** Что с записью — словом (ЗАДАЧА_04 B2): для согласованной — есть ли предоплата, для остальных — чего ждём. */
function digestState(l: DigestLine): string {
  if (l.status === 'scheduled') return l.prepaymentKopecks > 0 ? 'предоплата получена' : 'без предоплаты';
  return statusShort(l.status, 'seller');
}

/** Сколько записей показываем в сводке; остальное — в «📅 Расписание» (лимит сообщения MAX — 4000 символов). */
const DIGEST_MAX_LINES = 20;

/**
 * Утренняя сводка исполнителю (ЗАДАЧА_04 B2): «📅 Сегодня, вт 29 сен — 3 записи (МСК):» и по строке на запись
 * «10:00 — Саша · Маникюр с покрытием · предоплата получена». Строки уже отсортированы по времени.
 */
export function dailyDigest(a: { day: Date; lines: DigestLine[]; now?: Date }): string {
  const now = a.now ?? new Date();
  const { day } = dayAndTime(a.day, undefined, now);
  const head = `📅 Сегодня, ${day[0].toLowerCase()}${day.slice(1)} — ${recordsWord(a.lines.length)} (МСК):`;
  const rows = a.lines.slice(0, DIGEST_MAX_LINES).map((l) => {
    const who = l.demo ? 'демо-клиент' : l.clientName ? esc(clip(oneLine(l.clientName), 40)) : 'клиент не открыл ссылку';
    const parts = [`${dayAndTime(l.scheduledAt, undefined, now).time} — ${who}`, esc(clip(oneLine(l.title), 60)), digestState(l)];
    return `${parts.join(' · ')}${l.demo ? ' · демо' : ''}`;
  });
  const more = a.lines.length > DIGEST_MAX_LINES ? [`…и ещё ${a.lines.length - DIGEST_MAX_LINES} — в «${BTN.schedule}»`] : [];
  return [head, ...rows, ...more].join('\n');
}

// --- ответы API мини-приложения на правку условий (SPEC §7.8). Экран показывает свой текст по коду, это — запасной ---

export const API_DEAL_NOT_FOUND = 'Сделка не найдена';
export const API_FORBIDDEN_DEAL = 'Это не ваша сделка';
export const API_NOT_EDITABLE = 'Условия можно изменить, только пока клиент их не подтвердил';
export const API_NO_CHANGES = 'Условия не изменились — отправлять клиенту нечего';

// --- подписи кнопок. Ровно те, что в SPEC §5.5, §6.4, §6.5 и DESIGN §6 ---

export const BTN = {
  newDeal: '➕ Новая сделка',
  myDeals: '📁 Мои сделки',
  settings: '⚙️ Настройки',
  help: '❓ Как это работает',
  tryIt: '🧪 Попробовать',
  tryDemo: 'Демо: пройти одному',
  exampleDeal: 'Сделка-пример: позвать клиента',
  menu: '↩️ Меню',
  sendToMax: '📤 Отправить в MAX',
  copyLink: '📋 Скопировать ссылку',
  editTerms: '✏️ Изменить условия',
  openAsClient: '🧪 Открыть как клиент',
  cancelDeal: '🚫 Отменить',
  remindClient: 'Напомнить клиенту',
  keepAsIs: 'Оставить как есть',
  confirm: '✅ Подтверждаю',
  requestChanges: '✏️ Предложить изменения',
  decline: '⛔ Отказаться',
  declineYes: 'Да, отказаться',
  payByLink: '💳 Оплатить по ссылке',
  payByTransfer: '🔁 Перевести по реквизитам',
  transferDone: '✅ Я перевёл(а)',
  transferReceived: '✅ Получил(а)',
  transferNotReceived: '❌ Не вижу перевода',
  transferCancel: '↩️ Отмена перевода',
  goToPayment: 'Перейти к оплате',
  checkPayment: '🔄 Проверить оплату',
  emulatePayment: '🧪 Эмулировать оплату',
  newLink: '🆕 Новая ссылка',
  done: '✔️ Выполнено',
  accept: '👍 Принимаю',
  remarks: '⚠️ Есть замечания',
  fixed: 'Исправлено, проверьте',
  attachReceipt: '📎 Приложить чек',
  closeWithoutReceipt: 'Закрыть без чека',
  closeWithoutReceiptYes: 'Да, закрыть без чека',
  cancelYes: 'Да, отменить',
  noReason: 'Без причины',
  receiptPdf: '📄 Квитанция PDF',
  repeat: '🔁 Повторить',
  refundSent: '✅ Вернул(а)',
  refundReceived: '✅ Возврат получил(а)',
  open: 'Открыть',
  schedule: '📅 Расписание',
  back: '↩️ Назад',
  keepDeal: '↩️ Не отменять',
};
