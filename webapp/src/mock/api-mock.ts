// DEV-ONLY заглушка API для визуальной проверки экранов без сервера: включается VITE_MOCK_API=1.
// В прод-бандл не попадает: импорт в api.ts стоит под `import.meta.env.DEV` (мёртвая ветка вырезается сборкой).
// Данные повторяют контракт SPEC §7.8 и примеры §7.6, тексты статусов как у сервера (server/src/texts.ts).
//
// Сценарии для скриншотов состояний (ЗАДАЧА_07), без перезапуска Vite, параметрами адреса до «#»:
//   ?mock_hang=me,deals,deal    запрос не отвечает: видно загрузку (скелет);
//   ?mock_fail=me,deals,deal    запрос падает «нет связи»: видно ошибку с «Повторить»;
//   ?mock_fail=write            отправка формы падает: Snackbar с «Повторить»;
//   ?mock_deals=none|seller|client|all, ?mock_profile=1   данные, как у одноимённых VITE_MOCK_*.
// Переменные VITE_MOCK_* по-прежнему работают и действуют, если параметра в адресе нет.
// Экран сделки (§7.9), «Мои услуги» (§7.6a), «Другое время» (§7.10), надёжность (§7.11) и переходы §5.2 — упрощённо.
import { ApiError } from '../api';
import { CANCEL_RULE_TEXT, formatDateTime, formatKopecks, moscowInputToIso } from '../format';
import { addDays, dayKey } from '../schedule';
import type {
  ActionCode,
  CancelRule,
  CreateDealRequest,
  CreateDealResponse,
  DealActionRequest,
  DealActionResponse,
  DealDetails,
  DealFull,
  DealFullVersion,
  DealListItem,
  DealPayment,
  DealRole,
  DealStatus,
  DealTimelineItem,
  DealView,
  MeResponse,
  ReceiptUploadResponse,
  SellerProfile,
  Service,
  ServiceBody,
  TemplateKey,
  TemplatesResponse,
  UpdateDealRequest,
  UpdateDealResponse,
} from '../types';

/** Параметр сценария из адреса (`?mock_x=…`) или переменной VITE_MOCK_X. */
function scenario(name: string, env: unknown): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(`mock_${name}`);
    if (fromUrl !== null) return fromUrl;
  } catch {
    /* адреса нет (тесты): берём переменную */
  }
  return String(env ?? '');
}

const listed = (name: string, env: unknown) =>
  scenario(name, env)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const BOT = String(import.meta.env.VITE_BOT_USERNAME ?? 'dogovorilis_bot').trim();
const CARD_SENT = import.meta.env.VITE_MOCK_CARD_SENT !== '0';
/** VITE_MOCK_PROFILE=1 или ?mock_profile=1: профиль исполнителя уже сохранён (блок «О вас» скрыт). */
const HAS_PROFILE = scenario('profile', import.meta.env.VITE_MOCK_PROFILE) === '1';

const DEMO_PROFILE: SellerProfile = {
  display_name: 'Анна Аксёнова',
  tax_mode: 'npd',
  payout_details: 'СБП +7 900 000-00-00, Т-Банк, получатель Анна А.',
  transfer_enabled: true,
  link_enabled: false,
  default_cancel_rule: 'free_24h',
  digest_time: 480,
};

/** Профиль живёт в памяти вкладки: «Сохранить» в настройках и первая сделка меняют его, как на сервере. */
let profile: SellerProfile | null = HAS_PROFILE ? DEMO_PROFILE : null;

function me(): MeResponse {
  return {
    user: { id: 1001, first_name: 'Анна', last_name: 'Аксёнова', username: 'anna', phone_verified: false },
    profile,
    config: { provider: 'none', demo: true, bot_username: BOT },
    // Надёжность (§7.11) — исполнителю с профилем; на стенде — правдоподобный набор с одной спорной сделкой.
    reliability: profile
      ? { closed: 12, no_dispute_percent: 92, cheque_on_time_percent: 83, seller_cancel_percent: 0, rating: { average: 4.8, count: 5 } }
      : null,
  };
}

/** Как на сервере: поле, которого нет в теле, — значение по умолчанию (08:00). */
function saveProfile(body: SellerProfile): SellerProfile {
  profile = {
    ...body,
    digest_time: body.digest_time === undefined ? 480 : body.digest_time,
    show_reliability: body.show_reliability ?? profile?.show_reliability ?? false,
  };
  return profile;
}

const TEMPLATES: TemplatesResponse = {
  items: [
    {
      key: 'beauty',
      label: 'Красота',
      title: 'Маникюр с покрытием',
      prepayment_percent: 30,
      cancel_rule: 'free_24h',
      date_required: true,
      hint: 'Дата обязательна: клиент увидит, когда приходить',
    },
    {
      key: 'lesson',
      label: 'Занятие',
      title: 'Занятие 60 минут',
      prepayment_percent: 100,
      cancel_rule: 'free_24h',
      date_required: true,
      hint: 'Предоплата 100 %: занятие оплачивается заранее',
    },
    {
      key: 'repair',
      label: 'Ремонт и выезд',
      title: 'Ремонт с выездом',
      prepayment_percent: 0,
      cancel_rule: 'free_24h',
      date_required: false,
      hint: 'В уточнениях укажите адрес и сколько стоит диагностика',
    },
    {
      key: 'custom_order',
      label: 'На заказ',
      title: 'Изделие на заказ',
      prepayment_percent: 50,
      cancel_rule: 'nonrefundable',
      date_required: true,
      hint: 'Дата: день, когда отдаёте изделие',
    },
    {
      key: 'freelance',
      label: 'Работа под ключ',
      title: 'Работа под ключ',
      prepayment_percent: 50,
      cancel_rule: 'full_refund',
      date_required: true,
      hint: 'Дата: срок сдачи работы',
    },
    {
      key: 'free',
      label: 'Своя',
      title: '',
      prepayment_percent: 0,
      cancel_rule: 'free_24h',
      date_required: false,
      hint: null,
    },
  ],
};

// ───────────── «Сделки»: набор на разные дни, роли и статусы (?mock_deals / VITE_MOCK_DEALS=none|seller|client) ─────────────

const MOCK_DEALS = scenario('deals', import.meta.env.VITE_MOCK_DEALS) || 'all';

const SHORT: Record<DealStatus, { seller: string; client: string }> = {
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

interface MockDeal {
  id: string;
  role: 'seller' | 'client';
  status: DealStatus;
  title: string;
  /** Сдвиг в днях от сегодня и время МСК; null — без даты. */
  at: [number, string] | null;
  /** Точный момент после правки — перекрывает `at`. */
  iso?: string | null;
  total: number;
  prepay: number;
  demo?: boolean;
  description?: string | null;
  client?: string;
  template?: TemplateKey;
  cancel?: CancelRule;
  version?: number;
  /** Экран сделки: имя исполнителя у клиентских строк. */
  seller?: string;
  /** Прежние версии условий (1…N−1) и что попросил клиент после каждой — «История версий». */
  history?: { title?: string; at: [number, string] | null; total: number; prepay: number; requestAfter: string }[];
  /** Запрос изменений, из-за которого сделка сейчас в `changes_requested`. */
  request?: string;
  /** Клиент сообщил о переводе, исполнитель ещё не подтвердил (кнопки tr:g / tr:n в чате). */
  claimed?: boolean;
  /** Услуга, из которой собрана сделка (§7.6a), и длительность на момент создания. */
  serviceId?: number | null;
  durationMin?: number | null;
}

const MOCK_DEAL_ROWS: MockDeal[] = [
  { id: 'Sc0Today10', role: 'seller', status: 'scheduled', title: 'Маникюр с покрытием', at: [0, '10:00'], total: 2500, prepay: 750, client: 'Саша' },
  { id: 'Pp0Today14', role: 'seller', status: 'awaiting_prepayment', title: 'Покрытие гель-лак', at: [0, '14:00'], total: 1800, prepay: 540, client: 'Марина', claimed: true },
  { id: 'Cf1Tmrw183', role: 'seller', status: 'awaiting_confirmation', title: 'Коррекция и окрашивание бровей', at: [1, '18:30'], total: 1500, prepay: 0 },
  { id: 'Dm2Demo150', role: 'seller', status: 'scheduled', title: 'Маникюр с покрытием', at: [2, '15:00'], total: 2500, prepay: 750, demo: true, client: 'Анна' },
  {
    id: 'Cr3Chng120',
    role: 'seller',
    status: 'changes_requested',
    title: 'Маникюр с дизайном на все пальцы, долгое название',
    at: [3, '12:00'],
    total: 3200,
    prepay: 1600,
    client: 'Ольга',
    version: 2,
    history: [{ at: [3, '11:00'], total: 2800, prepay: 1400, requestAfter: 'Давайте на 12:00 и дизайн на все пальцы' }],
    request: 'А можно без предоплаты? Оплачу всё после',
  },
  { id: 'Cl2Past110', role: 'seller', status: 'closed', title: 'Маникюр с покрытием', at: [-2, '11:00'], total: 2500, prepay: 750, client: 'Саша', description: 'Френч, форма миндаль', serviceId: 1, durationMin: 90 },
  // «Повторить» со скрытой услугой: услуга «Педикюр» потом скрыта, но повтор берёт её (§7.6a).
  { id: 'Cn1Cancel9', role: 'seller', status: 'cancelled', title: 'Педикюр', at: [-1, '09:00'], total: 3000, prepay: 900, client: 'Вера', serviceId: 4, durationMin: 120 },
  { id: 'NoDateRep1', role: 'seller', status: 'awaiting_confirmation', title: 'Ремонт с выездом', at: null, total: 4000, prepay: 0, template: 'repair', description: 'Адрес: ул. Ленина, 5. Диагностика стиральной машины' },
  { id: 'ExpNoDate1', role: 'seller', status: 'expired', title: 'Изделие на заказ', at: null, total: 6000, prepay: 3000, template: 'free', cancel: 'nonrefundable' },
  { id: 'Later30day', role: 'seller', status: 'scheduled', title: 'Занятие 60 минут', at: [30, '19:00'], total: 2000, prepay: 2000, client: 'Игорь', template: 'lesson' },
  { id: 'PaidRcpt01', role: 'seller', status: 'paid', title: 'Маникюр и покрытие', at: [-1, '16:00'], total: 2200, prepay: 660, client: 'Ксения' },
  { id: 'Cli5Lesson', role: 'client', status: 'awaiting_prepayment', title: 'Занятие 60 минут', at: [5, '16:00'], total: 2000, prepay: 2000, seller: 'Игорь Петров', template: 'lesson' },
  {
    id: 'Cli2Confrm',
    role: 'client',
    status: 'awaiting_confirmation',
    title: 'Стрижка и укладка',
    at: [2, '19:00'],
    total: 2000,
    prepay: 600,
    seller: 'Ирина Смирнова',
    version: 2,
    history: [{ at: [2, '10:00'], total: 2000, prepay: 600, requestAfter: 'Можно перенести на вечер? Утром работаю' }],
  },
  { id: 'Cli1Accept', role: 'client', status: 'awaiting_acceptance', title: 'Ремонт стиральной машины', at: [-1, '12:00'], total: 4500, prepay: 0, seller: 'Сервис «Руки на час»', template: 'repair' },
  { id: 'Cli3Closed', role: 'client', status: 'closed', title: 'Стрижка', at: [-3, '13:00'], total: 1200, prepay: 0, seller: 'Дмитрий' },
];

function mockIso(row: MockDeal): string | null {
  if (row.iso !== undefined) return row.iso;
  if (!row.at) return null;
  return moscowInputToIso(`${addDays(dayKey(new Date()), row.at[0])}T${row.at[1]}`);
}

function listItem(row: MockDeal): DealListItem {
  return {
    public_id: row.id,
    status: row.status,
    status_text: SHORT[row.status][row.role],
    status_short: SHORT[row.status][row.role],
    demo: row.demo ?? false,
    role: row.role,
    title: row.title,
    client_name: row.role === 'seller' ? (row.client ?? null) : null,
    scheduled_at: mockIso(row),
    total_kopecks: row.total * 100,
    prepayment_kopecks: row.prepay * 100,
    paid_kopecks: 0,
    updated_at: new Date().toISOString(),
  };
}

function listDeals(): { items: DealListItem[] } {
  if (MOCK_DEALS === 'none') return { items: [] };
  const rows = MOCK_DEAL_ROWS.filter((row) => MOCK_DEALS === 'all' || row.role === MOCK_DEALS);
  return { items: rows.map(listItem) };
}

const EDITABLE: readonly DealStatus[] = ['awaiting_confirmation', 'changes_requested'];
const TERMINAL: readonly DealStatus[] = ['declined', 'expired', 'closed', 'cancelled'];

function notFound(): never {
  throw new ApiError(404, 'not_found', 'Сделка не найдена');
}

function findRow(publicId: string): MockDeal {
  return MOCK_DEAL_ROWS.find((row) => row.id === publicId) ?? notFound();
}

function details(row: MockDeal): DealDetails {
  const seller = row.role === 'seller';
  return {
    public_id: row.id,
    status: row.status,
    version: row.version ?? 1,
    role: row.role,
    demo: row.demo ?? false,
    template: row.template ?? 'beauty',
    title: row.title,
    description: row.description ?? null,
    scheduled_at: mockIso(row),
    total_rub: row.total,
    prepayment_rub: row.prepay,
    cancel_rule: row.cancel ?? 'free_24h',
    client: row.client ? { name: row.client } : null,
    can_edit: seller && EDITABLE.includes(row.status),
    can_repeat: seller && TERMINAL.includes(row.status) && !row.demo,
    same_client_available: seller && Boolean(row.client) && !row.demo,
    // Услуга — инструмент исполнителя: клиенту не отдаётся (как views.ts на сервере).
    service_id: seller ? (row.serviceId ?? null) : null,
    duration_min: seller ? (row.durationMin ?? null) : null,
  };
}

function dealView(row: MockDeal): DealView {
  const link = `https://max.ru/${BOT}?start=d_${row.id}`;
  return {
    public_id: row.id,
    status: row.status,
    status_text: row.status === 'awaiting_confirmation' ? 'Ждём подтверждения клиента' : SHORT[row.status].seller,
    template: row.template ?? 'free',
    demo: row.demo ?? false,
    seller: { name: profile?.display_name ?? DEMO_PROFILE.display_name },
    client: row.client ? { name: row.client } : null,
    version: {
      version: row.version ?? 1,
      title: row.title,
      description: row.description ?? null,
      scheduled_at: mockIso(row),
      total_kopecks: row.total * 100,
      prepayment_kopecks: row.prepay * 100,
      cancel_rule: row.cancel ?? 'free_24h',
      photo_max_token: null,
    },
    remaining_kopecks: (row.total - row.prepay) * 100,
    paid_kopecks: 0,
    link,
    timestamps: {
      created_at: new Date().toISOString(),
      confirmed_at: null,
      done_at: null,
      accepted_at: null,
      paid_at: null,
      closed_at: null,
      cancelled_at: null,
    },
  };
}

/** VITE_MOCK_WRITE_FAIL=network|500 или ?mock_fail=write: отправка формы падает; conflict — действие экрана сделки отвечает 409. */
const WRITE_FAIL = listed('fail', '').includes('write') ? 'network' : String(import.meta.env.VITE_MOCK_WRITE_FAIL ?? '');

function maybeFailWrite(): void {
  if (WRITE_FAIL === 'network') throw new ApiError(0, 'network', 'Нет связи. Проверьте интернет и повторите');
  if (WRITE_FAIL === '500') throw new ApiError(500, 'internal', 'Внутренняя ошибка, попробуйте позже');
}

/** PUT /api/deals/:id — как T5 на сервере: только исполнитель, два статуса, без изменений — 409 no_changes. */
function updateDeal(publicId: string, body: UpdateDealRequest): UpdateDealResponse {
  const row = findRow(publicId);
  if (row.role !== 'seller') throw new ApiError(403, 'forbidden', 'Менять условия может только исполнитель');
  if (!EDITABLE.includes(row.status)) {
    throw new ApiError(409, 'deal_not_editable', 'Клиент уже подтвердил условия');
  }
  maybeFailWrite();
  // Прежняя версия остаётся в «Истории версий» экрана сделки со своими условиями — снимаем её до правки.
  fullOf(row);
  const next = {
    title: body.title,
    description: body.description ?? null,
    iso: body.scheduled_at ?? null,
    total: body.total_rub,
    prepay: body.prepayment_rub,
    cancel: body.cancel_rule,
  };
  const same =
    next.title === row.title &&
    next.description === (row.description ?? null) &&
    next.iso === mockIso(row) &&
    next.total === row.total &&
    next.prepay === row.prepay &&
    next.cancel === (row.cancel ?? 'free_24h');
  // Как на сервере: смена одной услуги без условий — тоже «ничего не изменилось» (клиента зря не беспокоим).
  if (same) throw new ApiError(409, 'no_changes', 'Условия не изменились');
  if (body.service_id !== undefined) {
    const service = body.service_id === null ? null : serviceById(body.service_id);
    Object.assign(row, { serviceId: service?.id ?? null, durationMin: service?.duration_min ?? null });
  }
  Object.assign(row, next, { template: body.template, status: 'awaiting_confirmation', version: (row.version ?? 1) + 1 });
  return { deal: dealView(row), version: row.version ?? 2, client_notified: Boolean(row.client) };
}

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** VITE_MOCK_CLIENT_DIALOG=0 — у прежнего клиента нет диалога с ботом: повтор «тому же клиенту» идёт обычной ссылкой. */
const CLIENT_DIALOG = import.meta.env.VITE_MOCK_CLIENT_DIALOG !== '0';

let createdCount = 0;

/** POST /api/deals: новая сделка попадает в «Мои сделки»; повтор с тем же клиентом — как ЗАДАЧА_04 F на сервере. */
function createDeal(body: CreateDealRequest): CreateDealResponse {
  createdCount += 1;
  const publicId = `MK7Q2XD4L${createdCount % 10}`;
  const source = body.repeat_of ? findRow(body.repeat_of) : null;
  if (body.same_client && (!source || source.role !== 'seller' || !source.client)) {
    throw new ApiError(403, 'forbidden', 'Этого клиента нельзя подставить в новую сделку');
  }
  const withClient = Boolean(body.same_client && source?.client && CLIENT_DIALOG);
  const service = typeof body.service_id === 'number' ? serviceById(body.service_id) : null;
  const row: MockDeal = {
    id: publicId,
    role: 'seller',
    status: 'awaiting_confirmation',
    title: body.title,
    at: null,
    iso: body.scheduled_at ?? null,
    total: body.total_rub,
    prepay: body.prepayment_rub,
    description: body.description ?? null,
    template: body.template,
    cancel: body.cancel_rule,
    client: withClient ? source?.client : undefined,
    serviceId: service?.id ?? null,
    durationMin: service?.duration_min ?? null,
  };
  MOCK_DEAL_ROWS.unshift(row);
  const deal = dealView(row);
  return {
    deal,
    link: deal.link,
    share_text: `Подтвердите условия: ${body.title}`,
    card_sent: CARD_SENT,
    client_card_sent: withClient,
    client: body.same_client && source?.client ? { name: source.client } : null,
    client_no_dialog: Boolean(body.same_client && source?.client && !CLIENT_DIALOG),
  };
}

// ───────────── «Мои услуги» (§7.6a): GET/POST /services, PUT /services/:id, PUT /services/order ─────────────
// `?mock_services=none` в адресе страницы (до `#`) или VITE_MOCK_SERVICES=none — у исполнителя ещё нет услуг
// (пустой экран с примерами). По умолчанию — три показываемые и одна скрытая.

function mockServicesMode(): string {
  try {
    return new URLSearchParams(window.location.search).get('mock_services') ?? String(import.meta.env.VITE_MOCK_SERVICES ?? 'some');
  } catch {
    return 'some';
  }
}

const SEED_SERVICES: Service[] = [
  { id: 1, title: 'Маникюр с покрытием', description: 'Гель-лак, снятие старого покрытия', price_rub: 2500, duration_min: 90, prepayment: { kind: 'percent', value: 30 }, cancel_rule: 'free_24h', template: 'beauty', active: true, sort_order: 1 },
  { id: 2, title: 'Коррекция бровей', description: null, price_rub: 1500, duration_min: 45, prepayment: { kind: 'none', value: 0 }, cancel_rule: 'free_24h', template: 'beauty', active: true, sort_order: 2 },
  { id: 3, title: 'Покрытие гель-лак', description: null, price_rub: 1800, duration_min: 60, prepayment: { kind: 'amount', value: 500 }, cancel_rule: 'free_48h', template: 'beauty', active: true, sort_order: 3 },
  { id: 4, title: 'Педикюр', description: 'Аппаратный, с покрытием', price_rub: 3000, duration_min: 120, prepayment: { kind: 'amount', value: 900 }, cancel_rule: 'free_24h', template: 'beauty', active: false, sort_order: 4 },
];

let services: Service[] = mockServicesMode() === 'none' ? [] : SEED_SERVICES.map((s) => ({ ...s, prepayment: { ...s.prepayment } }));
let nextServiceId = 100;

function orderedServices(all: boolean): Service[] {
  return [...services].sort((a, b) => a.sort_order - b.sort_order).filter((s) => all || s.active).map((s) => ({ ...s }));
}

function serviceById(id: number): Service {
  const found = services.find((s) => s.id === id);
  if (!found) throw new ApiError(404, 'not_found', 'Услуга не найдена');
  return found;
}

/** Те же проверки, что server/src/domain/services.ts — и те же тексты (форма разносит их по полям). */
function checkService(body: ServiceBody): Omit<Service, 'id' | 'active' | 'sort_order'> {
  const title = body.title.trim();
  if (title.length < 2 || title.length > 80) throw new ApiError(400, 'validation', 'Название от 2 до 80 символов');
  const description = body.description?.trim() ? body.description.trim() : null;
  if (description && description.length > 1000) throw new ApiError(400, 'validation', 'Уточнения до 1000 символов');
  if (!Number.isInteger(body.price_rub) || body.price_rub < 1 || body.price_rub > 1_000_000) {
    throw new ApiError(400, 'validation', 'Сумма от 1 до 1 000 000 ₽');
  }
  const duration = body.duration_min ?? 60;
  if (!Number.isInteger(duration) || duration < 15 || duration > 720 || duration % 15 !== 0) {
    throw new ApiError(400, 'validation', 'Длительность от 15 минут до 12 часов, шаг 15 минут');
  }
  const { kind, value } = body.prepayment;
  const prepaymentOk =
    (kind === 'none' && value === 0) ||
    (kind === 'percent' && Number.isInteger(value) && value >= 1 && value <= 100) ||
    (kind === 'amount' && Number.isInteger(value) && value >= 1 && value <= body.price_rub);
  if (!prepaymentOk) throw new ApiError(400, 'validation', 'Предоплата: процент от 1 до 100 или не больше суммы');
  return {
    title,
    description,
    price_rub: body.price_rub,
    duration_min: duration,
    prepayment: { kind, value },
    cancel_rule: body.cancel_rule,
    template: body.template ?? 'free',
  };
}

function createService(body: ServiceBody): { service: Service } {
  const fields = checkService(body);
  if (services.length >= 50) throw new ApiError(409, 'services_limit', 'Услуг уже 50. Скройте ненужные или измените существующую');
  maybeFailWrite();
  const sortOrder = services.reduce((max, s) => Math.max(max, s.sort_order), 0) + 1;
  const service: Service = { id: (nextServiceId += 1), ...fields, active: true, sort_order: sortOrder };
  services.push(service);
  return { service: { ...service } };
}

function updateService(id: number, body: ServiceBody): { service: Service } {
  const current = serviceById(id);
  const fields = checkService(body);
  maybeFailWrite();
  Object.assign(current, fields, { active: body.active ?? current.active });
  return { service: { ...current } };
}

function reorderServices(ids: number[]): { items: Service[] } {
  const own = new Set(services.map((s) => s.id));
  if (new Set(ids).size !== ids.length || ids.length !== own.size || ids.some((id) => !own.has(id))) {
    throw new ApiError(400, 'validation', 'Порядок: нужен полный список ваших услуг без повторов');
  }
  maybeFailWrite();
  services = services.map((s) => ({ ...s, sort_order: ids.indexOf(s.id) + 1 }));
  return { items: orderedServices(true) };
}

/** VITE_MOCK_AUTH_FAIL=1 — сервер не принял initData (401): экран «Не удалось подтвердить вход через MAX». */
const AUTH_FAIL = import.meta.env.VITE_MOCK_AUTH_FAIL === '1';

// ───────────── Экран сделки (§7.9): GET …/full, POST …/actions, POST …/receipt ─────────────
// Состояние экрана (версии, платежи, хронология, чек, возврат) живёт в памяти вкладки рядом со строкой списка:
// действие меняет `row.status`, поэтому «Мои сделки» после возврата со экрана сделки показывают новый статус.

const HOUR = 60 * 60 * 1000;
const isoAgo = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

/** Клиент в клиентских сделках — сам пользователь мока. */
const ME_NAME = 'Анна Аксёнова';
/** Сделка, которую сервер не покажет: 403 «Это не ваша сделка» (`#/deals/NotYours01`). */
const FORBIDDEN_ID = 'NotYours01';

const E1 = 'Это действие уже недоступно, карточка обновлена';
const E7 = 'После выполнения работы отменить сделку можно только по согласованию с исполнителем. Напишите ему в чат';

interface MockFull {
  /** Все версии по возрастанию; последняя — текущая, её условия берутся из строки (их правит PUT). */
  versions: DealFullVersion[];
  payments: DealPayment[];
  timeline: DealTimelineItem[];
  receiptAt: string | null;
  closedWithoutReceipt: boolean;
  refundExpected: boolean;
  refundSentAt: string | null;
  refundReceivedAt: string | null;
  remindedAt: number | null;
  /** Последний запрос изменений — станет change_request_text следующей версии. */
  pendingRequest: string | null;
  /** Двойное нажатие: то же действие той же роли при том же статусе — `already_done`, как на сервере. */
  last: { key: string; status: DealStatus } | null;
  /** Ожидающее предложение времени от клиента (§7.10). */
  proposal?: { id: number; scheduled_at: string } | null;
}

const FULL = new Map<string, MockFull>();

function sellerNameOf(row: MockDeal): string {
  return row.role === 'seller' ? (profile?.display_name ?? DEMO_PROFILE.display_name) : (row.seller ?? 'Ирина Смирнова');
}

function clientNameOf(row: MockDeal): string | null {
  return row.role === 'client' ? ME_NAME : (row.client ?? null);
}

/** Докуда дошла сделка по основному пути: 0 — ждём подтверждения … 6 — закрыта. */
const STAGE: Record<DealStatus, number> = {
  awaiting_confirmation: 0,
  changes_requested: 0,
  declined: 0,
  expired: 0,
  cancelled: 0,
  awaiting_prepayment: 1,
  scheduled: 2,
  awaiting_acceptance: 3,
  remarks: 3,
  awaiting_payment: 4,
  paid: 5,
  closed: 6,
};

const PAYMENT_STATUS: Record<DealPayment['status'], string> = {
  pending: 'ждёт оплаты',
  claimed: 'клиент сообщил о переводе',
  succeeded: 'оплачено',
  canceled: 'отменено',
  expired: 'ссылка истекла',
};

function mockPayment(
  kind: DealPayment['kind'],
  rail: DealPayment['rail'],
  status: DealPayment['status'],
  amountKopecks: number,
  at: string | null,
): DealPayment {
  const what = kind === 'prepayment' ? 'Предоплата' : 'Остаток';
  const how = rail === 'link' ? 'ссылка ЮKassa (тест)' : 'перевод, подтверждают стороны';
  return {
    kind,
    rail,
    status,
    amount_kopecks: amountKopecks,
    at,
    label: `${what} ${formatKopecks(amountKopecks)}, ${how}: ${PAYMENT_STATUS[status]}`,
  };
}

function snapshot(row: MockDeal) {
  return {
    title: row.title,
    scheduled_at: mockIso(row),
    total_kopecks: row.total * 100,
    prepayment_kopecks: row.prepay * 100,
    cancel_rule: row.cancel ?? ('free_24h' as CancelRule),
  };
}

/** Правдоподобное прошлое сделки по её статусу: события, версии, платежи (для каждой строки мок-списка). */
function seedFull(row: MockDeal): MockFull {
  const rail: DealPayment['rail'] = row.demo ? 'link' : 'transfer';
  const stage = row.status === 'cancelled' ? (row.prepay > 0 ? 2 : 1) : STAGE[row.status];
  const history = row.history ?? [];
  const current = history.length + 1;
  const prepay = formatKopecks(row.prepay * 100);
  const remaining = row.total - row.prepay;
  const events: { actor: DealTimelineItem['actor']; text: string; mark?: string }[] = [];
  const add = (actor: DealTimelineItem['actor'], text: string, mark?: string) => events.push({ actor, text, mark });

  add('seller', 'Исполнитель создал карточку, версия 1', 'v1');
  if (clientNameOf(row)) add('client', row.demo ? 'Исполнитель открыл карточку как клиент (демо)' : 'Клиент открыл ссылку');
  history.forEach((h, i) => {
    add('client', `Клиент предложил изменения: «${h.requestAfter}»`);
    add('seller', `Исполнитель изменил условия, версия ${i + 2}`, `v${i + 2}`);
  });
  if (row.status === 'changes_requested' && row.request) add('client', `Клиент предложил изменения: «${row.request}»`);
  if (row.status === 'declined') add('client', 'Клиент отказался от сделки');
  if (row.status === 'expired') add('system', 'Срок подтверждения истёк (72 ч)');
  if (stage >= 1) add('client', `Клиент подтвердил условия версии ${current}`, 'confirmed');
  if (row.prepay > 0 && stage >= 2) {
    if (rail === 'link') add('system', `Предоплата ${prepay} оплачена по ссылке ЮKassa (тест)`, 'prepaid');
    else {
      add('client', `Клиент сообщил о переводе ${prepay}`);
      add('seller', `Исполнитель подтвердил получение ${prepay}`, 'prepaid');
    }
  }
  if (row.claimed && row.status === 'awaiting_prepayment') add('client', `Клиент сообщил о переводе ${prepay}`, 'claimed');
  if (row.status === 'cancelled') {
    add('client', 'Клиент отменил сделку');
    if (row.prepay > 0) add('system', `Предоплата ${prepay}: ожидается возврат`);
  }
  if (stage >= 3) add('seller', 'Исполнитель отметил «Выполнено»');
  if (stage >= 4) add('client', 'Клиент принял работу');
  if (remaining > 0 && stage >= 5) {
    add('client', `Клиент сообщил о переводе ${formatKopecks(remaining * 100)}`);
    add('seller', `Исполнитель подтвердил получение ${formatKopecks(remaining * 100)}`, 'final');
  }
  if (stage >= 6) {
    add('seller', 'Чек приложен', 'receipt');
    add('system', 'Сделка закрыта, квитанция PDF отправлена обеим сторонам');
  }

  // Время событий: через 5 ч, последнее — час назад.
  const timeline = events.map((e, i) => ({ at: isoAgo(1 + (events.length - 1 - i) * 5), actor: e.actor, text: e.text }));
  const at = (mark: string) => timeline[events.findIndex((e) => e.mark === mark)]?.at ?? null;

  const versions: DealFullVersion[] = history.map((h, i) => ({
    version: i + 1,
    created_at: at(`v${i + 1}`) ?? isoAgo(48),
    confirmed_at: null,
    title: h.title ?? row.title,
    scheduled_at: h.at ? moscowInputToIso(`${addDays(dayKey(new Date()), h.at[0])}T${h.at[1]}`) : null,
    total_kopecks: h.total * 100,
    prepayment_kopecks: h.prepay * 100,
    cancel_rule: row.cancel ?? 'free_24h',
    change_request_text: i === 0 ? null : history[i - 1].requestAfter,
  }));
  versions.push({
    version: current,
    created_at: at(`v${current}`) ?? isoAgo(24),
    confirmed_at: at('confirmed'),
    ...snapshot(row),
    change_request_text: history.length > 0 ? history[history.length - 1].requestAfter : null,
  });

  const payments: DealPayment[] = [];
  if (row.prepay > 0 && stage >= 2) payments.push(mockPayment('prepayment', rail, 'succeeded', row.prepay * 100, at('prepaid')));
  if (row.claimed && row.status === 'awaiting_prepayment') {
    payments.push(mockPayment('prepayment', 'transfer', 'claimed', row.prepay * 100, at('claimed')));
  }
  if (remaining > 0 && stage >= 5) payments.push(mockPayment('final', rail, 'succeeded', remaining * 100, at('final')));

  return {
    versions,
    payments,
    timeline,
    receiptAt: at('receipt'),
    closedWithoutReceipt: false,
    refundExpected: row.status === 'cancelled' && row.prepay > 0,
    refundSentAt: null,
    refundReceivedAt: null,
    remindedAt: null,
    pendingRequest: row.status === 'changes_requested' ? (row.request ?? null) : null,
    last: null,
    // Сделка «изменения запрошены» на стенде ждёт ответа и на предложенное время: видна кнопка «Принять …» (§7.10).
    proposal:
      row.id === 'Cr3Chng120'
        ? { id: 499, scheduled_at: moscowInputToIso(`${addDays(dayKey(new Date()), 4)}T17:00`) ?? '' }
        : null,
  };
}

/** Состояние экрана сделки; новая версия после PUT (T5) дописывается сюда же. */
function fullOf(row: MockDeal): MockFull {
  let st = FULL.get(row.id);
  if (!st) {
    st = seedFull(row);
    FULL.set(row.id, st);
  }
  const version = row.version ?? 1;
  const last = st.versions[st.versions.length - 1];
  if (version > last.version) {
    const now = new Date().toISOString();
    st.versions.push({ version, created_at: now, confirmed_at: null, ...snapshot(row), change_request_text: st.pendingRequest });
    st.pendingRequest = null;
    st.timeline.push({ at: now, actor: 'seller', text: `Исполнитель изменил условия, версия ${version}` });
  } else {
    Object.assign(last, snapshot(row));
  }
  return st;
}

function statusTextOf(row: MockDeal, role: DealRole): string {
  const prepay = formatKopecks(row.prepay * 100);
  const remaining = formatKopecks((row.total - row.prepay) * 100);
  const iso = mockIso(row);
  const when = iso ? formatDateTime(iso) : null;
  const text: Record<DealStatus, [string, string]> = {
    awaiting_confirmation: ['Ждём подтверждения клиента', 'Подтвердите условия'],
    changes_requested: ['Клиент предложил изменения. Измените условия или оставьте как есть', 'Ждём новые условия от исполнителя'],
    declined: ['Клиент отказался от сделки', 'Вы отказались от сделки'],
    expired: ['Срок подтверждения истёк (72 ч)', 'Срок подтверждения истёк (72 ч)'],
    awaiting_prepayment: [`Ждём предоплату ${prepay}`, `Внесите предоплату ${prepay}`],
    scheduled: [
      when ? `Всё согласовано на ${when}. Отметьте «Выполнено», когда закончите` : 'Всё согласовано. Отметьте «Выполнено», когда закончите',
      when ? `Всё согласовано на ${when}. Ждём выполнения` : 'Всё согласовано. Ждём выполнения',
    ],
    awaiting_acceptance: ['Ждём приёмку клиентом', 'Примите работу или оставьте замечания'],
    remarks: ['Клиент оставил замечания. Исправьте и сообщите', 'Ждём исправлений от исполнителя'],
    awaiting_payment: [`Ждём остаток ${remaining}`, `Оплатите остаток ${remaining}`],
    paid: ['Оплачено. Приложите чек', 'Оплачено. Ждём чек от исполнителя'],
    closed: ['Сделка закрыта, квитанция отправлена', 'Сделка закрыта, квитанция отправлена'],
    cancelled: ['Сделка отменена', 'Сделка отменена'],
  };
  return text[row.status][role === 'seller' ? 0 : 1];
}

const DAY_MONTH = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });

function chequeTextOf(row: MockDeal, st: MockFull): string | null {
  if (st.receiptAt) return `Чек приложен ${formatDateTime(st.receiptAt).slice(0, 5)}`;
  if (st.closedWithoutReceipt) return 'Закрыта без чека';
  if (row.status !== 'paid') return null;
  // Срок чека «Мой налог» — 9-е число следующего месяца; бот напоминает 7-го (§10.2).
  const now = new Date();
  return `Чек: до ${DAY_MONTH.format(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 9, 9)))}`;
}

/** Ожидается ли возврат предоплаты при отмене клиентом — правило отмены §5.3. */
function clientRefundExpected(row: MockDeal): boolean {
  const rule = row.cancel ?? 'free_24h';
  if (rule === 'full_refund') return true;
  if (rule === 'nonrefundable') return false;
  const iso = mockIso(row);
  if (!iso) return true;
  return new Date(iso).getTime() - Date.now() >= (rule === 'free_48h' ? 48 : 24) * HOUR;
}

function cancelConsequenceOf(row: MockDeal, st: MockFull, role: DealRole): string | null {
  if (TERMINAL.includes(row.status)) return null;
  const prepaid = st.payments.some((p) => p.kind === 'prepayment' && p.status === 'succeeded');
  if (!prepaid) return null;
  const sum = formatKopecks(row.prepay * 100);
  if (role === 'seller') return `Предоплату ${sum} нужно будет вернуть клиенту тем же способом, каким она пришла`;
  return clientRefundExpected(row)
    ? `По правилу отмены предоплата ${sum} должна вернуться, исполнитель вернёт её тем же способом`
    : `⚠️ По правилу отмены предоплата ${sum} не вернётся.`;
}

/** После выполнения клиенту отмена закрыта (T18, E7). */
const CLIENT_CANCEL_LOCKED: readonly DealStatus[] = ['awaiting_acceptance', 'remarks', 'awaiting_payment'];

/** Кнопки карточки роли в статусе — SPEC §5.5 (у сервера — из cardKeyboard). */
function mockActions(row: MockDeal, st: MockFull, role: DealRole): ActionCode[] {
  const refund = row.status === 'cancelled' && st.refundExpected;
  if (role === 'seller') {
    switch (row.status) {
      case 'awaiting_confirmation':
        return clientNameOf(row) ? ['edit', 'remind_client', 'cancel'] : ['share', 'edit', 'open_as_client', 'cancel'];
      case 'changes_requested':
        return [...(st.proposal ? (['accept_time'] as const) : []), 'edit', 'keep_as_is', 'cancel'];
      case 'awaiting_prepayment':
      case 'awaiting_payment':
        return [...(st.payments.some((p) => p.status === 'claimed') ? (['confirm_transfer'] as const) : []), 'remind_client', 'cancel'];
      case 'scheduled':
        return ['done', 'cancel'];
      case 'awaiting_acceptance':
        return ['remind_client', 'cancel'];
      case 'remarks':
        return ['fixed', 'cancel'];
      case 'paid':
        return ['attach_receipt', 'close_without_receipt'];
      default:
        return [...(refund && !st.refundSentAt ? (['refund_confirmed'] as const) : []), 'receipt_pdf', ...(row.demo ? [] : (['repeat'] as const))];
    }
  }
  switch (row.status) {
    case 'awaiting_confirmation':
      return ['confirm', 'request_changes', 'decline'];
    case 'awaiting_prepayment':
      return ['pay', 'cancel'];
    case 'scheduled':
      return ['cancel'];
    case 'awaiting_acceptance':
      return ['accept', 'remarks'];
    case 'awaiting_payment':
      return ['pay'];
    case 'changes_requested':
    case 'remarks':
    case 'paid':
      return [];
    default:
      return [...(refund && !st.refundReceivedAt ? (['refund_confirmed'] as const) : []), 'receipt_pdf'];
  }
}

function dealFull(row: MockDeal, role: DealRole): DealFull {
  const st = fullOf(row);
  const current = st.versions[st.versions.length - 1];
  const remaining = (row.total - row.prepay) * 100;
  const client = clientNameOf(row);
  const cancelRule = row.cancel ?? 'free_24h';
  return {
    public_id: row.id,
    role,
    can_view_as_client: Boolean(row.demo),
    demo: Boolean(row.demo),
    status: row.status,
    status_text: statusTextOf(row, role),
    status_short: SHORT[row.status][role],
    link: `https://max.ru/${BOT}?start=d_${row.id}`,
    share_text: `Подтвердите условия: ${row.title}`,
    terms: {
      version: current.version,
      title: row.title,
      description: row.description ?? null,
      scheduled_at: mockIso(row),
      total_kopecks: row.total * 100,
      prepayment_kopecks: row.prepay * 100,
      remaining_kopecks: remaining,
      cancel_rule: cancelRule,
      cancel_rule_text: CANCEL_RULE_TEXT[cancelRule],
      created_at: current.created_at,
      confirmed_at: current.confirmed_at,
    },
    versions: st.versions.map((v) => ({ ...v })),
    seller: { name: sellerNameOf(row) },
    client: client ? { name: client } : null,
    money: {
      paid_kopecks: st.payments.filter((p) => p.status === 'succeeded').reduce((sum, p) => sum + p.amount_kopecks, 0),
      due_kopecks: row.status === 'awaiting_prepayment' ? row.prepay * 100 : row.status === 'awaiting_payment' ? remaining : 0,
      payments: st.payments.map((p) => ({ ...p })),
    },
    timeline: st.timeline.map((t) => ({ ...t })),
    documents: { receipt_pdf: TERMINAL.includes(row.status), cheque_text: chequeTextOf(row, st) },
    actions: mockActions(row, st, role),
    cancel_consequence: cancelConsequenceOf(row, st, role),
    time_proposal: st.proposal ? { ...st.proposal } : null,
    // §7.11: исполнителю — своя строка; клиенту — если исполнитель её показывает (на стенде — у «Стрижки и укладки»)
    reliability_line: role === 'seller' ? '12 сделок, 92 % без споров' : row.id === 'Cli2Confrm' ? '48 сделок, 98 % без споров' : null,
    rating: row.status === 'closed' ? { score: 5, comment: row.role === 'seller' ? 'Всё аккуратно, приду ещё' : null } : null,
  };
}

/** Чьими глазами: без `as` — своя роль; `as=client` у исполнителя — только демо (там клиент — он сам). */
function roleFor(row: MockDeal, as: DealRole | undefined): DealRole {
  if (!as || as === row.role) return row.role;
  if (as === 'client' && row.demo) return 'client';
  throw new ApiError(403, 'forbidden', as === 'client' ? 'Смотреть как клиент можно только демо-сделку' : 'Это не ваша сделка');
}

function fullDeal(publicId: string, as: DealRole | undefined): DealFull {
  if (publicId === FORBIDDEN_ID) throw new ApiError(403, 'forbidden', 'Это не ваша сделка');
  const row = findRow(publicId);
  return dealFull(row, roleFor(row, as));
}

/** VITE_MOCK_WRITE_FAIL=conflict — действие отвечает 409 invalid_transition: экран перезагружается и показывает тост. */
function maybeFailAction(): void {
  maybeFailWrite();
  if (WRITE_FAIL === 'conflict') throw new ApiError(409, 'invalid_transition', E1);
}

function textOf(body: DealActionRequest): string {
  const text = (body.text ?? '').trim();
  if (text.length === 0) throw new ApiError(400, 'validation', 'Напишите текст от 1 до 500 символов');
  if (text.length > 500) throw new ApiError(400, 'validation', 'Слишком длинно: до 500 символов');
  return text;
}

/** POST /api/deals/:id/actions — упрощённая таблица переходов SPEC §5.2. */
function applyAction(publicId: string, body: DealActionRequest): DealActionResponse {
  const row = findRow(publicId);
  const role = roleFor(row, body.as);
  const st = fullOf(row);
  const key = `${role}:${body.action}`;
  const repeatable = body.action === 'remind_client' || body.action === 'receipt_pdf';
  if (!repeatable && st.last?.key === key && st.last.status === row.status) {
    return { deal: dealFull(row, role), result: 'already_done', notice: null };
  }
  maybeFailAction();
  if (!mockActions(row, st, role).includes(body.action)) {
    if (body.action === 'cancel' && role === 'client' && CLIENT_CANCEL_LOCKED.includes(row.status)) {
      throw new ApiError(409, 'client_cancel_locked', E7);
    }
    if (body.action === 'receipt_pdf') throw new ApiError(409, 'receipt_not_ready', 'Квитанция будет, когда сделка завершится');
    throw new ApiError(409, 'invalid_transition', E1);
  }

  const now = new Date().toISOString();
  const log = (actor: DealTimelineItem['actor'], text: string) => st.timeline.push({ at: now, actor, text });
  const prepay = formatKopecks(row.prepay * 100);
  let notice: string | null = null;

  switch (body.action) {
    case 'confirm': {
      const current = st.versions[st.versions.length - 1];
      if (typeof body.version !== 'number') throw new ApiError(400, 'validation', 'Не указана версия условий');
      if (body.version !== current.version) {
        throw new ApiError(409, 'version_mismatch', 'Условия изменились, посмотрите новую версию');
      }
      current.confirmed_at = now;
      row.status = row.prepay > 0 ? 'awaiting_prepayment' : 'scheduled';
      log('client', `Клиент подтвердил условия версии ${current.version}`);
      break;
    }
    case 'request_changes': {
      const text = textOf(body);
      row.status = 'changes_requested';
      st.pendingRequest = text;
      log('client', `Клиент предложил изменения: «${text}»`);
      break;
    }
    case 'remarks': {
      const text = textOf(body);
      row.status = 'remarks';
      log('client', `Клиент оставил замечания: «${text}»`);
      break;
    }
    case 'decline':
      row.status = 'declined';
      log('client', 'Клиент отказался от сделки');
      break;
    case 'accept_time': {
      // Как на сервере: новая версия с предложенным временем (T5), клиент подтверждает её заново (§7.10).
      if (!st.proposal) throw new ApiError(409, 'invalid_transition', E1);
      const prev = st.versions[st.versions.length - 1];
      row.iso = st.proposal.scheduled_at;
      st.versions.push({ ...prev, version: prev.version + 1, created_at: now, confirmed_at: null, scheduled_at: st.proposal.scheduled_at, change_request_text: `Предлагаю другое время: ${formatDateTime(st.proposal.scheduled_at)}` });
      row.version = prev.version + 1;
      row.status = 'awaiting_confirmation';
      st.proposal = null;
      log('seller', `Исполнитель изменил условия (версия ${prev.version + 1}): срок`);
      notice = 'Время принято: клиент получил новую версию условий и подтвердит её.';
      break;
    }
    case 'keep_as_is':
      row.status = 'awaiting_confirmation';
      st.pendingRequest = null;
      st.proposal = null;
      log('seller', 'Исполнитель оставил условия как есть');
      break;
    case 'done':
      row.status = 'awaiting_acceptance';
      log('seller', 'Исполнитель отметил «Выполнено»');
      break;
    case 'accept':
      row.status = row.total > row.prepay ? 'awaiting_payment' : 'paid';
      log('client', 'Клиент принял работу');
      break;
    case 'fixed':
      row.status = 'awaiting_acceptance';
      log('seller', 'Исполнитель исправил замечания');
      break;
    case 'close_without_receipt':
      row.status = 'closed';
      st.closedWithoutReceipt = true;
      log('seller', 'Исполнитель закрыл сделку без чека');
      log('system', 'Квитанция PDF отправлена обеим сторонам');
      break;
    case 'remind_client':
      if (st.remindedAt !== null && Date.now() - st.remindedAt < 4 * HOUR) {
        throw new ApiError(429, 'rate_limited', 'Напоминание уже отправлено. Следующее можно через 4 часа');
      }
      st.remindedAt = Date.now();
      log('seller', 'Исполнитель напомнил клиенту');
      notice = 'Напоминание отправлено клиенту';
      break;
    case 'cancel': {
      const reason = (body.reason ?? '').trim();
      if (reason.length > 300) throw new ApiError(400, 'validation', 'Причина до 300 символов');
      const prepaid = st.payments.some((p) => p.kind === 'prepayment' && p.status === 'succeeded');
      st.refundExpected = prepaid && (role === 'seller' || clientRefundExpected(row));
      st.payments = st.payments.map((p) => (p.status === 'pending' ? mockPayment(p.kind, p.rail, 'canceled', p.amount_kopecks, p.at) : p));
      row.status = 'cancelled';
      log(role, `${role === 'seller' ? 'Исполнитель' : 'Клиент'} отменил сделку${reason ? `: «${reason}»` : ''}`);
      if (prepaid) {
        log('system', st.refundExpected ? `Предоплата ${prepay}: ожидается возврат` : `Предоплата ${prepay} не возвращается по правилу отмены`);
      }
      break;
    }
    case 'refund_confirmed':
      if (role === 'seller') {
        st.refundSentAt = now;
        log('seller', `Исполнитель вернул ${prepay}`);
        notice = 'Отметили возврат, клиент получил сообщение';
      } else {
        st.refundReceivedAt = now;
        log('client', `Клиент получил возврат ${prepay}`);
        notice = 'Спасибо, возврат отмечен, исполнитель получил сообщение';
      }
      break;
    case 'receipt_pdf':
      notice = 'Квитанция отправлена в чат с ботом';
      break;
  }
  st.last = { key, status: row.status };
  return { deal: dealFull(row, role), result: 'done', notice };
}

/** POST /api/deals/:id/receipt — T15 «чек приложен»: только исполнитель и только в `paid`. */
export async function mockUploadReceipt(publicId: string, file: File, contentType: string): Promise<ReceiptUploadResponse> {
  await delay(1500);
  if (AUTH_FAIL) throw new ApiError(401, 'init_data_invalid', 'Откройте мини-приложение внутри MAX');
  const row = findRow(publicId);
  if (row.role !== 'seller') throw new ApiError(403, 'forbidden', 'Чек прикладывает исполнитель');
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(contentType) || file.size === 0) {
    throw new ApiError(400, 'validation', 'Нужен файл PDF, JPG или PNG');
  }
  if (file.size > 20 * 1024 * 1024) throw new ApiError(413, 'file_too_large', 'Файл больше 20 МБ');
  maybeFailAction();
  if (row.status !== 'paid') throw new ApiError(409, 'invalid_transition', E1);
  const st = fullOf(row);
  const now = new Date().toISOString();
  st.receiptAt = now;
  st.last = null;
  row.status = 'closed';
  st.timeline.push({ at: now, actor: 'seller', text: `Чек приложен: ${file.name}` });
  st.timeline.push({ at: now, actor: 'system', text: 'Сделка закрыта, квитанция PDF отправлена обеим сторонам' });
  return { deal: dealFull(row, 'seller'), notice: 'Чек приложен, квитанция ушла обеим сторонам' };
}


// ───────────── «Другое время» (§7.10): GET …/busy, POST …/time-proposals ─────────────

const BUSY_STATUSES: readonly DealStatus[] = ['scheduled', 'awaiting_prepayment', 'awaiting_acceptance'];
let nextProposalId = 500;

/** Слот, который «успели занять», пока клиент выбирал: завтра 16:00 по МСК — показать 409 slot_busy на стенде. */
function takenSlotIso(): string {
  return moscowInputToIso(`${addDays(dayKey(new Date()), 1)}T16:00`) ?? '';
}

function busyOf(publicId: string) {
  if (publicId === FORBIDDEN_ID) throw new ApiError(403, 'forbidden', 'Это не ваша сделка');
  const row = findRow(publicId);
  const at = (days: number, time: string, minutes: number) => {
    const start = moscowInputToIso(`${addDays(dayKey(new Date()), days)}T${time}`) ?? '';
    return { start, end: new Date(Date.parse(start) + minutes * 60_000).toISOString() };
  };
  // У исполнителя этих сделок — занятость из его же «договорились»; у клиентских — выдуманный чужой график.
  const own =
    row.role === 'seller'
      ? MOCK_DEAL_ROWS.filter((r) => r.role === 'seller' && r.id !== row.id && !r.demo && BUSY_STATUSES.includes(r.status))
          .map((r) => ({ iso: mockIso(r), minutes: r.durationMin ?? 60 }))
          .filter((x): x is { iso: string; minutes: number } => Boolean(x.iso))
          .map((x) => ({ start: x.iso, end: new Date(Date.parse(x.iso) + x.minutes * 60_000).toISOString() }))
      : [at(1, '10:00', 90), at(1, '14:00', 60), at(2, '12:00', 60), at(2, '18:00', 120)];
  return {
    duration_min: row.durationMin ?? 60,
    step_min: 30,
    first_slot: '08:00',
    last_slot: '21:30',
    horizon_days: 30,
    min_lead_min: 30,
    now: new Date().toISOString(),
    current: mockIso(row),
    busy: own.sort((a, b) => a.start.localeCompare(b.start)),
  };
}

function proposeTime(publicId: string, body: { scheduled_at: string; as?: DealRole }) {
  const row = findRow(publicId);
  const role = roleFor(row, body.as);
  if (role !== 'client') throw new ApiError(403, 'forbidden', 'Время предлагает клиент');
  if (!['awaiting_confirmation', 'changes_requested'].includes(row.status)) throw new ApiError(409, 'invalid_transition', E1);
  maybeFailWrite();
  if (body.scheduled_at === mockIso(row)) throw new ApiError(400, 'validation', 'Это и так текущее время. Выберите другое');
  if (body.scheduled_at === takenSlotIso()) throw new ApiError(409, 'slot_busy', 'Это время уже заняли. Выберите другое');
  const st = fullOf(row);
  st.proposal = { id: nextProposalId++, scheduled_at: body.scheduled_at };
  row.status = 'changes_requested';
  st.timeline.push({ at: new Date().toISOString(), actor: 'client', text: `Клиент предложил другое время: ${formatDateTime(body.scheduled_at)}` });
  return { proposal: { ...st.proposal, status: 'pending' as const }, deal: dealFull(row, role) };
}

/** Какой группе запросов принадлежит путь: для ?mock_hang и ?mock_fail. */
function groupOf(method: string, path: string): 'me' | 'deals' | 'deal' | 'other' {
  if (path === '/me' || path === '/templates') return 'me';
  if (method === 'GET' && path.startsWith('/deals?')) return 'deals';
  if (method === 'GET' && path.startsWith('/deals/')) return 'deal';
  return 'other';
}

export async function mockRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const group = groupOf(method, path);
  if (listed('hang', '').includes(group)) await new Promise<never>(() => undefined);
  await delay(300);
  if (listed('fail', '').includes(group)) throw new ApiError(0, 'network', 'Нет связи. Проверьте интернет и повторите');
  if (AUTH_FAIL) throw new ApiError(401, 'init_data_invalid', 'Откройте мини-приложение внутри MAX');
  if (method === 'GET' && path === '/me') return me() as unknown as T;
  if (method === 'GET' && path === '/templates') return TEMPLATES as unknown as T;
  if (method === 'GET' && path.startsWith('/deals?')) return listDeals() as unknown as T;
  const dealPath = /^\/deals\/([A-Za-z0-9]+)$/.exec(path);
  if (dealPath && method === 'GET') return details(findRow(dealPath[1])) as unknown as T;
  if (dealPath && method === 'PUT') return updateDeal(dealPath[1], body as UpdateDealRequest) as unknown as T;
  const fullPath = /^\/deals\/([A-Za-z0-9]+)\/full(?:\?as=(seller|client))?$/.exec(path);
  if (fullPath && method === 'GET') return fullDeal(fullPath[1], fullPath[2] as DealRole | undefined) as unknown as T;
  const busyPath = /^\/deals\/([A-Za-z0-9]+)\/busy$/.exec(path);
  if (busyPath && method === 'GET') return busyOf(busyPath[1]) as unknown as T;
  const proposalPath = /^\/deals\/([A-Za-z0-9]+)\/time-proposals$/.exec(path);
  if (proposalPath && method === 'POST') return proposeTime(proposalPath[1], body as { scheduled_at: string; as?: DealRole }) as unknown as T;
  const actionPath = /^\/deals\/([A-Za-z0-9]+)\/actions$/.exec(path);
  if (actionPath && method === 'POST') return applyAction(actionPath[1], body as DealActionRequest) as unknown as T;
  if (method === 'PUT' && path === '/me/profile') return { profile: saveProfile(body as SellerProfile) } as unknown as T;
  if (method === 'GET' && (path === '/services' || path === '/services?all=1')) {
    return { items: orderedServices(path.endsWith('all=1')) } as unknown as T;
  }
  if (method === 'POST' && path === '/services') return createService(body as ServiceBody) as unknown as T;
  if (method === 'PUT' && path === '/services/order') return reorderServices((body as { ids: number[] }).ids) as unknown as T;
  const servicePath = /^\/services\/(\d+)$/.exec(path);
  if (servicePath && method === 'PUT') return updateService(Number(servicePath[1]), body as ServiceBody) as unknown as T;
  if (method === 'POST' && path === '/deals') {
    const request = body as CreateDealRequest;
    maybeFailWrite();
    if (request.profile && !profile) saveProfile(request.profile);
    return createDeal(request) as unknown as T;
  }
  throw new Error(`mock: нет заглушки для ${method} ${path}`);
}
