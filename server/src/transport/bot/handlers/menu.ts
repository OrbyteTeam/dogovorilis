// Команды меню (SPEC §6.1) и демо-сделка из меню (§12).
// Мини-приложение до привязки организаторами недоступно, поэтому /new всегда предлагает и путь через демо-сделку
// (требование ЗАДАЧА_01, шаг «Что значит на заглушках»).
import { Keyboard, type Bot, type Context } from '@maxhub/max-bot-api';
import { cfg, dealLink } from '../../../config.js';
import { inTx } from '../../../db/pool.js';
import * as dealsRepo from '../../../db/repos/deals.js';
import * as inputsRepo from '../../../db/repos/inputs.js';
import * as usersRepo from '../../../db/repos/users.js';
import type { Button } from '@maxhub/max-bot-api/types';
import type { AttachmentRequest } from '../../../integrations/max/gateway.js';
import * as texts from '../../../texts.js';
import { formatMoney } from '../../../domain/money.js';
import { demoDealDraft, exampleDealDraft } from '../../../domain/templates.js';
import * as dealService from '../../../domain/deal/service.js';
import { sendCard } from '../cards.js';
import { cb } from '../callbacks.js';
import { keyboard } from '../keyboards.js';
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
  const rows: AttachmentRequest[] = [];
  const bot = cfg().MAX_BOT_USERNAME || 'bot';
  const buttons: Button[][] = [
    [Keyboard.button.openApp(texts.BTN.newDeal, bot, undefined, 'new')],
    [Keyboard.button.callback(texts.BTN.exampleDeal, 'ex:new')],
  ];
  if (cfg().DEMO_MODE) buttons.push([Keyboard.button.callback(texts.BTN.tryDemo, 'dm:new')]);
  rows.push(keyboard(buttons));
  await deps.max.send({ chatId }, texts.NEW_DEAL_PROMPT, rows);
}

async function cmdDeals(ctx: Context, deps: Deps): Promise<void> {
  const chatId = chatIdOf(ctx);
  const userId = ctx.user?.user_id;
  if (!chatId || !userId) return;
  const active = await inTx((c) => dealsRepo.listForUser(c, userId, { role: 'all', filter: 'active', limit: 5 }));
  if (!active.length) {
    await deps.max.send({ chatId }, 'Активных сделок нет. Создайте первую — это займёт полминуты.', [openAppRow(texts.BTN.newDeal, 'new')]);
    return;
  }
  const lines: string[] = ['Активные сделки:'];
  const rows: Button[][] = [];
  for (const deal of active) {
    const bundle = await dealService.getBundleById(deal.id);
    lines.push(
      `${texts.statusEmoji(deal.status)} #${deal.publicId} · ${texts.esc(bundle.version.title)} · ${formatMoney(bundle.version.totalKopecks)}${deal.demo ? ' · демо' : ''}`,
    );
    rows.push([Keyboard.button.callback(`${texts.BTN.open} #${deal.publicId}`, cb('op', deal.publicId))]);
  }
  const bot = cfg().MAX_BOT_USERNAME || 'bot';
  rows.push([Keyboard.button.openApp(texts.BTN.myDeals, bot, undefined, 'deals')]);
  await deps.max.send({ chatId }, lines.join('\n'), [keyboard(rows)]);
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
