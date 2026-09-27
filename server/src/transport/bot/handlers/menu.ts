// Команды меню (SPEC §6.1), экран «🧪 Попробовать» и пробные сделки из него (§12, ЗАДАЧА_04 A3).
import { Keyboard, type Bot, type Context } from '@maxhub/max-bot-api';
import { botUsername, cfg, dealLink } from '../../../config.js';
import { inTx } from '../../../db/pool.js';
import * as dealsRepo from '../../../db/repos/deals.js';
import * as inputsRepo from '../../../db/repos/inputs.js';
import * as usersRepo from '../../../db/repos/users.js';
import type { Button } from '@maxhub/max-bot-api/types';
import type { AttachmentRequest } from '../../../integrations/max/gateway.js';
import type { DealListItem } from '../../../types.js';
import * as texts from '../../../texts.js';
import { demoDealDraft, exampleDealDraft } from '../../../domain/templates.js';
import * as dealService from '../../../domain/deal/service.js';
import { sendCard } from '../cards.js';
import { cb } from '../callbacks.js';
import { keyboard, tryKeyboard } from '../keyboards.js';
import { answerError, chatIdOf, menu, touchUser, type Deps } from './shared.js';

export function registerMenu(bot: Bot, deps: Deps): void {
  bot.command(/^new$/, (ctx) => guard(ctx, deps, () => cmdNew(ctx, deps)));
  bot.command(/^deals$/, (ctx) => guard(ctx, deps, () => cmdDeals(ctx, deps)));
  bot.command(/^settings$/, (ctx) => guard(ctx, deps, () => cmdSettings(ctx, deps)));
  bot.command(/^help$/, (ctx) => guard(ctx, deps, () => cmdHelp(ctx, deps)));
  bot.command(/^cancel$/, (ctx) => guard(ctx, deps, () => cmdCancelInput(ctx, deps)));
}

async function guard(ctx: Context, deps: Deps, fn: () => Promise<void>): Promise<void> {
  try {
    await touchUser(ctx, chatIdOf(ctx));
    await fn();
  } catch (e) {
    await answerError(ctx, deps, e);
  }
}

function openAppRow(text: string, payload: string): AttachmentRequest {
  const bot = cfg().MAX_BOT_USERNAME || 'bot';
  return keyboard([[Keyboard.button.openApp(text, bot, undefined, payload)]]);
}

async function cmdNew(ctx: Context, deps: Deps): Promise<void> {
  const chatId = chatIdOf(ctx);
  if (!chatId) return;
  // Те же три пути, что в меню и на экране «🧪 Попробовать» (ЗАДАЧА_04 A3): форма, демо одному, сделка-пример.
  const bot = cfg().MAX_BOT_USERNAME || 'bot';
  const buttons: Button[][] = [[Keyboard.button.openApp(texts.BTN.newDeal, bot, undefined, 'new')]];
  if (cfg().DEMO_MODE) buttons.push([Keyboard.button.callback(texts.BTN.tryDemo, 'dm:new')]);
  buttons.push([Keyboard.button.callback(texts.BTN.exampleDeal, 'ex:new')]);
  await deps.max.send({ chatId }, texts.NEW_DEAL_PROMPT, [keyboard(buttons)]);
}

/** Сколько строк в разделе «/deals»; остальное — в мини-приложении (ЗАДАЧА_04 A2). */
const DEALS_PER_SECTION = 10;

async function cmdDeals(ctx: Context, deps: Deps): Promise<void> {
  const chatId = chatIdOf(ctx);
  const userId = ctx.user?.user_id;
  if (!chatId || !userId) return;
  const items = await inTx((c) => dealsRepo.listItemsForUser(c, userId, { role: 'all', filter: 'active', limit: 200 }));
  if (!items.length) {
    await deps.max.send({ chatId }, texts.DEALS_EMPTY, [openAppRow(texts.BTN.newDeal, 'new')]);
    return;
  }
  const { text, rows } = dealsListMessage(items);
  await deps.max.send({ chatId }, text, [keyboard(rows)]);
}

/**
 * Два раздела — «Я исполнитель» / «Я клиент», пустой не показываем; строки по дате, без кода сделки;
 * название — ссылка на карточку (диплинк `d_<id>`), под списком — кнопки «Пн 28 сен 14:00 · Маникюр».
 * Демо-сделка (клиент — сам исполнитель) попадает только в раздел исполнителя.
 */
export function dealsListMessage(items: DealListItem[], now = new Date()): { text: string; rows: Button[][] } {
  const byDate = (a: DealListItem, b: DealListItem) =>
    (a.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
    b.updatedAt.getTime() - a.updatedAt.getTime();
  const lines: string[] = [texts.DEALS_HEADER];
  const rows: Button[][] = [];
  for (const [role, title] of [['seller', texts.DEALS_SELLER], ['client', texts.DEALS_CLIENT]] as const) {
    const section = items.filter((i) => i.role === role).sort(byDate);
    if (!section.length) continue;
    lines.push('', title);
    for (const item of section.slice(0, DEALS_PER_SECTION)) {
      lines.push(texts.dealsLine(item, dealLink(item.publicId), now));
      rows.push([Keyboard.button.callback(texts.dealsButton(item, now), cb('op', item.publicId))]);
    }
    if (section.length > DEALS_PER_SECTION) lines.push(texts.DEALS_MORE(section.length - DEALS_PER_SECTION));
  }
  rows.push([Keyboard.button.openApp(texts.BTN.myDeals, botUsername(), undefined, 'deals')]);
  return { text: lines.join('\n'), rows };
}

async function cmdSettings(ctx: Context, deps: Deps): Promise<void> {
  const chatId = chatIdOf(ctx);
  if (!chatId) return;
  await deps.max.send({ chatId }, 'Настройки профиля — в мини-приложении.', [openAppRow(texts.BTN.settings, 'settings')]);
}

async function cmdHelp(ctx: Context, deps: Deps): Promise<void> {
  const chatId = chatIdOf(ctx);
  if (!chatId) return;
  await deps.max.send({ chatId }, texts.H1, [menu()]);
}

async function cmdCancelInput(ctx: Context, deps: Deps): Promise<void> {
  const chatId = chatIdOf(ctx);
  const userId = ctx.user?.user_id;
  if (!chatId || !userId) return;
  await inTx((c) => inputsRepo.clear(c, userId));
  await deps.max.send({ chatId }, texts.INPUT_CANCELLED, [menu()]);
}

/** Кнопка «Как это работает» из меню. */
export async function onHelpCallback(ctx: Context, deps: Deps): Promise<void> {
  await deps.max.answer(ctx.callback!.callback_id, texts.H1, [menu()]);
}

/** «🧪 Попробовать»: два пробных пути и возврат в меню — на месте сообщения с меню. */
export async function onTryCallback(ctx: Context, deps: Deps): Promise<void> {
  const demoMode = cfg().DEMO_MODE;
  await deps.max.answer(ctx.callback!.callback_id, demoMode ? texts.TRY_PROMPT : texts.TRY_PROMPT_NO_DEMO, [tryKeyboard({ demoMode })]);
}

/** «↩️ Меню» с экрана «Попробовать». */
export async function onMenuCallback(ctx: Context, deps: Deps): Promise<void> {
  await deps.max.answer(ctx.callback!.callback_id, texts.S1, [menu()]);
}

/**
 * Кнопка «🧪 Попробовать на демо-сделке»: создаём сделку по шаблону beauty с данными-примером
 * и сразу открываем её как клиент — в тот же чат приходят обе карточки (SPEC §12).
 */
export async function onDemoNew(ctx: Context, deps: Deps): Promise<void> {
  if (!cfg().DEMO_MODE) {
    await deps.max.answer(ctx.callback!.callback_id, texts.E1);
    return;
  }
  const userId = ctx.user?.user_id;
  const chatId = chatIdOf(ctx);
  if (!userId || !chatId) return;

  const user = await touchUser(ctx, chatId);
  await ensureDemoProfile(userId, user.firstName);

  const draft = demoDealDraft(new Date());
  const created = await dealService.createDeal({ sellerUserId: userId, ...draft, photoMaxToken: null, demo: true, trial: 'demo' });
  const bundle = created.bundle;

  await deps.max.answer(ctx.callback!.callback_id, texts.DEMO_CREATED(bundle.deal.publicId, dealLink(bundle.deal.publicId)), [menu()]);
  await sendCard(deps.max, bundle, 'seller', { userId, chatId });
  await sendCard(deps.max, bundle, 'client_demo', { userId, chatId });
}

/**
 * «📝 Сделка-пример для клиента»: НАСТОЯЩАЯ сделка с условиями шаблона beauty, клиент не привязан.
 * Путь к двустороннему сценарию и кнопкам шеринга прямо из чата — без мини-приложения (аудит 22.09 §3.2).
 * Меню остаётся под ответом: сообщение, в котором нажали, MAX правит ответом (§6.4).
 */
export async function onExampleNew(ctx: Context, deps: Deps): Promise<void> {
  const userId = ctx.user?.user_id;
  const chatId = chatIdOf(ctx);
  if (!userId || !chatId) return;

  const user = await touchUser(ctx, chatId);
  await ensureDemoProfile(userId, user.firstName);
  const created = await dealService.createDeal({ sellerUserId: userId, ...exampleDealDraft(new Date()), photoMaxToken: null, trial: 'example' });

  await deps.max.answer(ctx.callback!.callback_id, texts.EXAMPLE_CREATED(created.bundle.deal.publicId), [menu()]);
  await sendCard(deps.max, created.bundle, 'seller', { userId, chatId });
}

/** У демо-сделки должен быть профиль исполнителя: без реквизитов рейл «перевод» недоступен (SPEC §9.1). */
async function ensureDemoProfile(userId: number, firstName: string): Promise<void> {
  await inTx(async (c) => {
    const existing = await usersRepo.getProfile(c, userId);
    if (existing) return;
    await usersRepo.upsertProfile(c, {
      userId,
      displayName: firstName || 'Исполнитель',
      taxMode: 'npd',
      payoutDetails: 'СБП +7 900 000-00-00, Т-Банк, получатель Демо Д. (данные-пример)',
      transferEnabled: true,
      linkEnabled: true,
      defaultCancelRule: 'free_24h',
    });
  });
}
