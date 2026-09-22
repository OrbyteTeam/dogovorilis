// Шаблоны сделок (SPEC §7.6). Данные, а не тексты: подставляют название, предоплату и правило отмены в форму.
import type { CancelRule, TemplateKey } from '../types.js';

export type Template = {
  key: TemplateKey;
  /** подпись чипа в мини-приложении */
  label: string;
  /** название сделки по умолчанию */
  title: string;
  prepaymentPercent: number;
  cancelRule: CancelRule;
  /** дата обязательна по смыслу шаблона (подсказка форме, не жёсткая валидация) */
  dateRequired: boolean;
  hint: string | null;
};

export const TEMPLATES: readonly Template[] = [
  { key: 'beauty', label: '💅 Красота', title: 'Маникюр с покрытием', prepaymentPercent: 30, cancelRule: 'free_24h', dateRequired: true, hint: 'Дата обязательна — клиент увидит время визита' },
  { key: 'lesson', label: '📚 Занятие', title: 'Занятие 60 минут', prepaymentPercent: 100, cancelRule: 'free_24h', dateRequired: true, hint: 'Предоплата 100 % — занятие оплачивается заранее' },
  { key: 'repair', label: '🔧 Ремонт/выезд', title: 'Ремонт / выезд мастера', prepaymentPercent: 0, cancelRule: 'free_24h', dateRequired: false, hint: 'В уточнениях укажите адрес и стоимость диагностики' },
  { key: 'custom_order', label: '🎂 На заказ', title: 'Изделие на заказ', prepaymentPercent: 50, cancelRule: 'nonrefundable', dateRequired: true, hint: 'Дата — это выдача заказа' },
  { key: 'freelance', label: '💻 Работа под ключ', title: 'Работа под ключ', prepaymentPercent: 50, cancelRule: 'full_refund', dateRequired: true, hint: 'Дата — срок сдачи' },
  { key: 'free', label: '✍️ Своя', title: '', prepaymentPercent: 0, cancelRule: 'free_24h', dateRequired: false, hint: null },
];

export function templateByKey(key: string): Template | null {
  return TEMPLATES.find((t) => t.key === key) ?? null;
}

/** Демо-сделка из меню S1: шаблон beauty с данными-примером (SPEC §12). */
export function demoDealDraft(now: Date): {
  template: TemplateKey;
  title: string;
  description: string | null;
  scheduledAt: Date;
  totalKopecks: number;
  prepaymentKopecks: number;
  cancelRule: CancelRule;
} {
  // «завтра 14:00» по местному времени показа; считаем от текущей даты в UTC+3 — точность до часа здесь не критична,
  // важно, чтобы дата была в будущем и попадала в окно напоминания event_tomorrow.
  const tomorrow = new Date(now.getTime() + 24 * 3600_000);
  tomorrow.setUTCHours(11, 0, 0, 0); // 14:00 МСК
  return {
    template: 'beauty',
    title: 'Маникюр с покрытием',
    description: 'Пример сделки для демонстрации. Адрес: онлайн-запись, кабинет 3.',
    scheduledAt: tomorrow,
    totalKopecks: 250_000,
    prepaymentKopecks: 50_000,
    cancelRule: 'free_24h',
  };
}
