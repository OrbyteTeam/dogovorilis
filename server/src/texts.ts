// Единственное место, где живут тексты бота и уведомлений.
// Первоисточник — docs/SPEC.md §6 (эталон), плюс §5.1 (эмодзи статусов), §5.3 (возврат предоплаты),
// §5.5 (кнопки по ролям), §9.1 (рейл «перевод»), §10.2 (напоминания), §12 (демо-режим)
// и docs/DESIGN.md §6 (порядок строк карточки, лимиты 12 строк / 1200 символов).
//
// Модуль намеренно «чистый»: из зависимостей — только доменные типы и форматтеры, никакого config,
// БД и SDK. Так тексты проверяются юнит-тестами без окружения, а часовой пояс берётся по умолчанию
// из domain/time.ts (APP_TIMEZONE подставляется на уровне транспорта, если когда-то понадобится).

import type { CancelRule, CardRole, DealStatus, PaymentProvider, PaymentRail, PaymentStatus, ReminderKind, Role } from './types.js';
import { formatMoney, prepaymentPercent } from './domain/money.js';
import { formatDateShort, formatDateTime, formatDateTimeShort, formatDayMonth } from './domain/time.js';

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

export const S3 = 'Я понимаю только кнопки и команды. Откройте /deals или /new.';

export const H1 = `Как это работает
1. Исполнитель создаёт карточку: что, когда, сколько, предоплата, правило отмены.
2. Отправляет ссылку клиенту в любой чат MAX.
3. Клиент подтверждает условия кнопкой и вносит предоплату — по ссылке или переводом.
4. После выполнения клиент принимает работу, оплачивает остаток.
5. Исполнитель прикладывает чек; обе стороны получают квитанцию PDF.
Деньги идут напрямую исполнителю. Мы не платёжный агент и не храним реквизиты карт.
Тестовый режим: оплата по ссылке проходит через тестовый магазин — реальные деньги не списываются.`;

export const INPUT_CANCELLED = 'Ввод отменён';

export const DEAL_FINISHED_LINE = 'Сделка завершена';

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
    seller: 'Клиент предложил изменения — обновите условия',
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
  receiptLine: string | null;
  refundLine: string | null;
  clientLink: string | null;
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

    const parties: (string | null)[] = [
      `👤 Исполнитель: ${esc(oneLine(v.sellerName))}`,
      `👤 Клиент: ${v.clientName ? esc(oneLine(v.clientName)) : 'ещё не открыл ссылку'}`,
      v.paymentLine,
      v.receiptLine,
      v.refundLine,
      v.clientLink ? `🔗 Ссылка для клиента: \`${v.clientLink}\`` : null,
    ];

    // Гарантия DESIGN §6: не больше 12 строк. В реальных статусах строк ≤ 12 и так; на всякий
    // случай убираем необязательные в порядке возрастания важности: макет → ссылка → строка чека.
    const countLines = () => head.length + terms.filter(Boolean).length + parties.filter(Boolean).length;
    const dropOrder: (() => void)[] = [
      () => {
        terms[4] = null; // 🖼 макет приложён
      },
      () => {
        parties[5] = null; // 🔗 ссылка для клиента (она же в кнопке «Скопировать ссылку»)
      },
      () => {
        parties[3] = null; // строка чека
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
  state: 'awaiting' | 'link_issued' | 'link_expired' | 'link_canceled' | 'claimed' | 'received';
  sumKopecks: number;
  at: Date | null;
  rail: PaymentRail | null;
  provider: PaymentProvider | null;
  linkExpiresAt: Date | null;
  /** cancellation_details.reason провайдера — показывается как есть (SPEC §9.2). */
  cancelReason?: string | null;
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
    case 'claimed':
      return a.at
        ? `${label} ${sum}: клиент сообщил о переводе ${formatDateTimeShort(a.at)} — ждём подтверждения исполнителя`
        : `${label} ${sum}: клиент сообщил о переводе — ждём подтверждения исполнителя`;
    case 'received': {
      const verb = a.kind === 'prepayment' ? 'получена' : 'получен';
      return a.at ? `${label} ${verb} ${formatDateTimeShort(a.at)}${rail}` : `${label} ${verb}${rail}`;
    }
  }
}

export function receiptLine(a: { attachedAt: Date | null; deadline: Date | null; taxModeNone: boolean }): string {
  if (a.attachedAt) return `Чек приложен ${formatDateShort(a.attachedAt)}`;
  if (a.taxModeNone) return 'Чек не требуется (исполнитель работает без чека)';
  return a.deadline ? `Чек: до ${formatDayMonth(a.deadline)}` : 'Чек: ждём от исполнителя';
}

export function refundLine(a: { prepaymentKopecks: number; expected: boolean | null }): string | null {
  if (a.prepaymentKopecks <= 0 || a.expected === null) return null;
  const sum = formatMoney(a.prepaymentKopecks);
  return a.expected ? `Предоплата ${sum}: ожидается возврат` : `Предоплата ${sum} не возвращается по правилу отмены`;
}

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
  return `✏️ ${esc(a.client)} предлагает изменения по #${a.id}:\n${quote(esc(a.text))}`;
}

export function N4(a: { id: string; version: number }): string {
  return `🔄 Исполнитель обновил условия #${a.id} (версия ${a.version}). Проверьте карточку.`;
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
  return `🧾 #${a.id} оплачена полностью. Сформируйте чек в «Мой налог» и приложите его сюда — до ${formatDayMonth(a.deadline)}.`;
}

export function N14(a: { id: string; withReceipt: boolean }): string {
  return `✅ Сделка #${a.id} закрыта. Квитанция во вложении${a.withReceipt ? ', чек — выше' : ''}.`;
}

export function N15(a: { id: string; by: 'seller' | 'client' | 'system'; reason: string | null; refundLine: string | null }): string {
  const by: Record<Role, string> = { seller: 'исполнителем', client: 'клиентом', system: 'автоматически' };
  const reason = a.reason ? `: ${esc(oneLine(a.reason))}` : '';
  const refund = a.refundLine ? ` ${a.refundLine}` : '';
  return `🚫 #${a.id} отменена ${by[a.by]}${reason}.${refund}`;
}

export function N16(a: { id: string; context: string }): string {
  // context — наш собственный текст (контекст статуса), пользовательского ввода в нём нет.
  return `🔔 Напоминание от исполнителя по #${a.id}: ${a.context}.`;
}

// --- рейл «перевод» (§9.1) ---

export function P1(a: { sumKopecks: number; payoutDetails: string }): string {
  return `Переведите ${formatMoney(a.sumKopecks)} исполнителю:
\`${esc(a.payoutDetails)}\`
После перевода нажмите «Я перевёл(а)». Подсказка: перевод можно сделать прямо в чате MAX через «+» → «Перевести деньги» (СБП).`;
}

export function P2(a: { client: string; sumKopecks: number; id: string }): string {
  return `${esc(a.client)} сообщает о переводе ${formatMoney(a.sumKopecks)} по #${a.id}. Проверьте поступление.`;
}

export function P3(a: { sumKopecks: number }): string {
  return `Исполнитель пока не видит перевод ${formatMoney(a.sumKopecks)}. Проверьте операцию и нажмите «Я перевёл(а)» ещё раз или выберите оплату по ссылке.`;
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
  const sum = formatMoney(a.sumKopecks);
  const until = a.expiresAt ? ` действует до ${formatDateTimeShort(a.expiresAt)}` : '';
  return `Ссылка на оплату ${sum}${until}.\n${testRailNotice(a.provider)}`;
}

/** Строка про тестовую среду провайдера для карточки и сообщения об оплате по ссылке (§9.2 п.4, §18). */
export function testRailNotice(provider: PaymentProvider): string {
  if (provider === 'yookassa') return '🧪 Тестовый магазин ЮKassa: реальные деньги не списываются.';
  if (provider === 'tbank') return '🧪 DEMO-терминал Т-Банка: реальные деньги не списываются.';
  return '🧪 Перевод по реквизитам подтверждается вручную обеими сторонами.';
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
export const E13 = 'Подождите — исполнитель ещё проверяет предыдущее сообщение о переводе.';

/** Идемпотентный повтор: карточка уже в целевом состоянии (SPEC §5.2, конкурентность). */
export const ALREADY_DONE = 'Это уже сделано — карточка актуальна.';

// --- напоминания (§10.2) ---

export function reminderText(
  kind: ReminderKind,
  a: { id: string; title: string; sumKopecks: number; scheduledAt: Date | null; deadline: Date | null },
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
  }
}

// --- подписи кнопок. Ровно те, что в SPEC §5.5, §6.4, §6.5 и DESIGN §6 ---

export const BTN = {
  newDeal: '➕ Новая сделка',
  myDeals: '📂 Мои сделки',
  settings: '⚙️ Настройки',
  help: '❓ Как это работает',
  tryDemo: '🧪 Попробовать на демо-сделке',
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
  transferCancel: 'Отмена',
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
  open: 'Открыть',
};
