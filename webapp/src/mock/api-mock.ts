// DEV-ONLY заглушка API для визуальной проверки экранов без сервера: включается VITE_MOCK_API=1.
// В прод-бандл не попадает — импорт в api.ts стоит под `import.meta.env.DEV` (мёртвая ветка вырезается сборкой).
// Данные повторяют контракт docs/SPEC.md §7.8 и шаблоны §7.6.
import type { CreateDealRequest, CreateDealResponse, MeResponse, SellerProfile, TemplatesResponse } from '../types';

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
};

const ME: MeResponse = {
  user: { id: 1001, first_name: 'Анна', last_name: 'Аксёнова', username: 'anna', phone_verified: false },
  profile: HAS_PROFILE ? DEMO_PROFILE : null,
  config: { provider: 'none', demo: true, bot_username: BOT },
};

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

export async function mockRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  await delay(300);
  if (method === 'GET' && path === '/me') return ME as unknown as T;
  if (method === 'GET' && path === '/templates') return TEMPLATES as unknown as T;
  if (method === 'PUT' && path === '/me/profile') return { profile: body as SellerProfile } as unknown as T;
  if (method === 'POST' && path === '/deals') return createDeal(body as CreateDealRequest) as unknown as T;
  throw new Error(`mock: нет заглушки для ${method} ${path}`);
}
