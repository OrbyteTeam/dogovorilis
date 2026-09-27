// DEV-ONLY заглушка API для визуальной проверки экранов без сервера: включается VITE_MOCK_API=1.
// В прод-бандл не попадает — импорт в api.ts стоит под `import.meta.env.DEV` (мёртвая ветка вырезается сборкой).
// Данные повторяют контракт docs/SPEC.md §7.8 и шаблоны §7.6.
import { ApiError } from '../api';
import { moscowInputToIso } from '../format';
import { addDays, dayKey } from '../schedule';
import type {
  CancelRule,
  CreateDealRequest,
  CreateDealResponse,
  DealDetails,
  DealListItem,
  DealStatus,
  DealView,
  MeResponse,
  SellerProfile,
  TemplateKey,
  TemplatesResponse,
  UpdateDealRequest,
  UpdateDealResponse,
} from '../types';

const BOT = String(import.meta.env.VITE_BOT_USERNAME ?? 'dogovorilis_bot').trim();
const CARD_SENT = import.meta.env.VITE_MOCK_CARD_SENT !== '0';
/** VITE_MOCK_PROFILE=1 — как будто профиль исполнителя уже сохранён (блок «О вас» скрыт). */
const HAS_PROFILE = import.meta.env.VITE_MOCK_PROFILE === '1';

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
  };
}

/** Как на сервере: поле, которого нет в теле, — значение по умолчанию (08:00). */
function saveProfile(body: SellerProfile): SellerProfile {
  profile = { ...body, digest_time: body.digest_time === undefined ? 480 : body.digest_time };
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
      hint: 'Дата обязательна — клиент увидит время визита',
    },
    {
      key: 'lesson',
      label: 'Занятие',
      title: 'Занятие 60 минут',
      prepayment_percent: 100,
      cancel_rule: 'free_24h',
      date_required: true,
      hint: 'Предоплата 100 % — занятие оплачивается заранее',
    },
    {
      key: 'repair',
      label: 'Ремонт / выезд',
      title: 'Ремонт / выезд мастера',
      prepayment_percent: 0,
      cancel_rule: 'free_24h',
      date_required: false,
      hint: 'В «Уточнениях» напишите адрес и что входит в диагностику',
    },
    {
      key: 'custom_order',
      label: 'На заказ',
      title: 'Изделие на заказ',
      prepayment_percent: 50,
      cancel_rule: 'nonrefundable',
      date_required: true,
      hint: 'Дата — день выдачи заказа',
    },
    {
      key: 'freelance',
      label: 'Работа под ключ',
      title: 'Работа под ключ',
      prepayment_percent: 50,
      cancel_rule: 'full_refund',
      date_required: true,
      hint: 'Дата — срок сдачи',
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

// ───────────── «Мои сделки»: набор на разные дни, роли и статусы (VITE_MOCK_DEALS=none|seller|client) ─────────────

const MOCK_DEALS = String(import.meta.env.VITE_MOCK_DEALS ?? 'all');

const SHORT: Record<DealStatus, { seller: string; client: string }> = {
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
}

const MOCK_DEAL_ROWS: MockDeal[] = [
  { id: 'Sc0Today10', role: 'seller', status: 'scheduled', title: 'Маникюр с покрытием', at: [0, '10:00'], total: 2500, prepay: 750, client: 'Саша' },
  { id: 'Pp0Today14', role: 'seller', status: 'awaiting_prepayment', title: 'Покрытие гель-лак', at: [0, '14:00'], total: 1800, prepay: 540, client: 'Марина' },
  { id: 'Cf1Tmrw183', role: 'seller', status: 'awaiting_confirmation', title: 'Коррекция и окрашивание бровей', at: [1, '18:30'], total: 1500, prepay: 0 },
  { id: 'Dm2Demo150', role: 'seller', status: 'scheduled', title: 'Маникюр с покрытием', at: [2, '15:00'], total: 2500, prepay: 750, demo: true, client: 'Анна' },
  { id: 'Cr3Chng120', role: 'seller', status: 'changes_requested', title: 'Маникюр с дизайном на все пальцы, долгое название', at: [3, '12:00'], total: 3200, prepay: 1600, client: 'Ольга' },
  { id: 'Cl2Past110', role: 'seller', status: 'closed', title: 'Маникюр с покрытием', at: [-2, '11:00'], total: 2500, prepay: 750, client: 'Саша', description: 'Френч, форма миндаль' },
  { id: 'Cn1Cancel9', role: 'seller', status: 'cancelled', title: 'Педикюр', at: [-1, '09:00'], total: 3000, prepay: 900, client: 'Вера' },
  { id: 'NoDateRep1', role: 'seller', status: 'awaiting_confirmation', title: 'Ремонт / выезд мастера', at: null, total: 4000, prepay: 0, description: 'Адрес: ул. Ленина, 5. Диагностика стиральной машины' },
  { id: 'ExpNoDate1', role: 'seller', status: 'expired', title: 'Изделие на заказ', at: null, total: 6000, prepay: 3000 },
  { id: 'Later30day', role: 'seller', status: 'scheduled', title: 'Занятие 60 минут', at: [30, '19:00'], total: 2000, prepay: 2000, client: 'Игорь' },
  { id: 'Cli5Lesson', role: 'client', status: 'awaiting_prepayment', title: 'Занятие 60 минут', at: [5, '16:00'], total: 2000, prepay: 2000 },
  { id: 'Cli3Closed', role: 'client', status: 'closed', title: 'Стрижка', at: [-3, '13:00'], total: 1200, prepay: 0 },
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

/** VITE_MOCK_WRITE_FAIL=network|500 — отправка формы падает: видно тост и «Повторить». */
const WRITE_FAIL = String(import.meta.env.VITE_MOCK_WRITE_FAIL ?? '');

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
  if (same) throw new ApiError(409, 'no_changes', 'Условия не изменились');
  Object.assign(row, next, { template: body.template, status: 'awaiting_confirmation', version: (row.version ?? 1) + 1 });
  return { deal: dealView(row), version: row.version ?? 2, client_notified: Boolean(row.client) };
}

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function createDeal(body: CreateDealRequest): CreateDealResponse {
  const publicId = 'MK7Q2XD4LP';
  const link = `https://max.ru/${BOT}?start=d_${publicId}`;
  const now = new Date().toISOString();
  return {
    deal: {
      public_id: publicId,
      status: 'awaiting_confirmation',
      status_text: 'Ждём подтверждения клиента',
      template: body.template,
      demo: false,
      seller: { name: body.profile?.display_name ?? DEMO_PROFILE.display_name },
      client: null,
      version: {
        version: 1,
        title: body.title,
        description: body.description ?? null,
        scheduled_at: body.scheduled_at ?? null,
        total_kopecks: body.total_rub * 100,
        prepayment_kopecks: body.prepayment_rub * 100,
        cancel_rule: body.cancel_rule,
        photo_max_token: null,
      },
      remaining_kopecks: (body.total_rub - body.prepayment_rub) * 100,
      paid_kopecks: 0,
      link,
      timestamps: {
        created_at: now,
        confirmed_at: null,
        done_at: null,
        accepted_at: null,
        paid_at: null,
        closed_at: null,
        cancelled_at: null,
      },
    },
    link,
    share_text: `Подтвердите нашу договорённость: ${body.title}`,
    card_sent: CARD_SENT,
  };
}

/** VITE_MOCK_AUTH_FAIL=1 — сервер не принял initData (401): экран «Не удалось подтвердить вход через MAX». */
const AUTH_FAIL = import.meta.env.VITE_MOCK_AUTH_FAIL === '1';

export async function mockRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  await delay(300);
  if (AUTH_FAIL) throw new ApiError(401, 'init_data_invalid', 'Откройте мини-приложение внутри MAX');
  if (method === 'GET' && path === '/me') return me() as unknown as T;
  if (method === 'GET' && path === '/templates') return TEMPLATES as unknown as T;
  if (method === 'GET' && path.startsWith('/deals?')) return listDeals() as unknown as T;
  const dealPath = /^\/deals\/([A-Za-z0-9]+)$/.exec(path);
  if (dealPath && method === 'GET') return details(findRow(dealPath[1])) as unknown as T;
  if (dealPath && method === 'PUT') return updateDeal(dealPath[1], body as UpdateDealRequest) as unknown as T;
  if (method === 'PUT' && path === '/me/profile') return { profile: saveProfile(body as SellerProfile) } as unknown as T;
  if (method === 'POST' && path === '/deals') {
    const request = body as CreateDealRequest;
    maybeFailWrite();
    if (request.profile && !profile) saveProfile(request.profile);
    return createDeal(request) as unknown as T;
  }
  throw new Error(`mock: нет заглушки для ${method} ${path}`);
}
