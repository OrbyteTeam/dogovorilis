// «Мои услуги» исполнителя — чистая логика: длительность и предоплата словами, подстановка услуги в форму сделки,
// тело «Сохранить как услугу», поля формы услуги и порядок — docs/SPEC.md §7.6a, контракт ЗАДАЧА_08 C.
// Услуга — инструмент исполнителя, а не витрина: клиент её не видит. Модуль без React и window — его покрывают
// unit-тесты webapp/test/services.test.ts.
import { formatRub } from './format';
import type { CancelRule, Service, ServiceBody, ServicePrepayment, Template, TemplateKey } from './types';

const NBSP = '\u00A0';

export const TITLE_MIN = 2;
export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 1000;
export const PRICE_MIN = 1;
export const PRICE_MAX = 1_000_000;
/** Больше не даёт сервер (409 services_limit). */
export const SERVICES_LIMIT = 50;

// ─────────────────────────────────────────── длительность ───────────────────────────────────────────

/** Пункты выбора длительности (контракт ЗАДАЧА_08 C, п. 3); сервер принимает 15…720 с шагом 15. */
export const SERVICE_DURATIONS: readonly number[] = [15, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720];
export const DEFAULT_DURATION_MIN = 60;

/** 45 → «45 мин», 60 → «1 ч», 90 → «1 ч 30 мин». Неразрывные пробелы — строка не рвётся между числом и единицей. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}${NBSP}мин`;
  return rest === 0 ? `${hours}${NBSP}ч` : `${hours}${NBSP}ч ${rest}${NBSP}мин`;
}

// ─────────────────────────────────────────── предоплата ───────────────────────────────────────────

/** Предоплата словами для строки списка: «предоплата 30 %», «предоплата 500 ₽», «без предоплаты». */
export function prepaymentText(p: ServicePrepayment): string {
  if (p.kind === 'percent' && p.value > 0) return `предоплата ${p.value}${NBSP}%`;
  if (p.kind === 'amount' && p.value > 0) return `предоплата ${formatRub(p.value)}`;
  return 'без предоплаты';
}

/** Подпись строки услуги: «1 ч 30 мин, предоплата 30 %». */
export function serviceSubtitle(s: Pick<Service, 'duration_min' | 'prepayment'>): string {
  return `${formatDuration(s.duration_min)}, ${prepaymentText(s.prepayment)}`;
}

/** Предоплата в рублях при полной цене: процент — с округлением до рубля вверх, как в форме сделки (SPEC §7.2). */
export function prepaymentRub(priceRub: number, p: ServicePrepayment): number {
  if (p.kind === 'percent' && p.value > 0) return Math.min(Math.ceil((priceRub * p.value) / 100), priceRub);
  if (p.kind === 'amount' && p.value > 0) return Math.min(p.value, priceRub);
  return 0;
}

// ─────────────────────────────────────────── форма сделки ───────────────────────────────────────────

/** Сегмент предоплаты — тот же в форме сделки и в форме услуги: Нет / 30 % / 50 % / Своя. */
export type PrepayMode = 'none' | 'p30' | 'p50' | 'custom';

/** Что услуга подставляет в форму сделки: всё, кроме даты (SPEC §7.6a). */
export interface DealFill {
  templateKey: TemplateKey;
  title: string;
  description: string;
  totalRaw: string;
  prepayMode: PrepayMode;
  prepayCustomRaw: string;
  cancelRule: CancelRule;
}

/**
 * Услуга → поля формы сделки. Процент 30 или 50 — сегментом; другой процент — «Своя» с суммой (округление вверх);
 * сумма — «Своя» как есть; без предоплаты — «Нет».
 */
export function dealFillFromService(s: Service): DealFill {
  let prepayMode: PrepayMode = 'none';
  let prepayCustomRaw = '';
  const { kind, value } = s.prepayment;
  if (kind === 'percent' && value === 30) prepayMode = 'p30';
  else if (kind === 'percent' && value === 50) prepayMode = 'p50';
  else if ((kind === 'percent' || kind === 'amount') && value > 0) {
    prepayMode = 'custom';
    prepayCustomRaw = String(prepaymentRub(s.price_rub, s.prepayment));
  }
  return {
    templateKey: s.template,
    title: s.title,
    description: s.description ?? '',
    totalRaw: String(s.price_rub),
    prepayMode,
    prepayCustomRaw,
    cancelRule: s.cancel_rule,
  };
}

/** «Сохранить как услугу» — только когда услуга не выбрана, а название и сумма уже введены (контракт, п. 4). */
export function canSaveAsService(v: { selectedId: number | null; title: string; totalRaw: string }): boolean {
  return v.selectedId === null && v.title.trim() !== '' && v.totalRaw.trim() !== '';
}

/** Поля формы сделки → новая услуга: длительность по умолчанию, 30/50 % — процентом, «Своя» — суммой. */
export function serviceBodyFromDeal(v: {
  title: string;
  description: string;
  totalRub: number;
  prepayMode: PrepayMode;
  prepaymentRub: number;
  cancelRule: CancelRule;
  templateKey: TemplateKey | null;
}): ServiceBody {
  const prepayment: ServicePrepayment =
    v.prepayMode === 'p30'
      ? { kind: 'percent', value: 30 }
      : v.prepayMode === 'p50'
        ? { kind: 'percent', value: 50 }
        : v.prepayMode === 'custom' && v.prepaymentRub > 0
          ? { kind: 'amount', value: v.prepaymentRub }
          : { kind: 'none', value: 0 };
  const description = v.description.trim();
  return {
    title: v.title.trim(),
    description: description === '' ? null : description,
    price_rub: v.totalRub,
    duration_min: DEFAULT_DURATION_MIN,
    prepayment,
    cancel_rule: v.cancelRule,
    template: v.templateKey ?? 'free',
  };
}

export interface ServiceChip {
  service: Service;
  /** Скрытая услуга прежней сделки: «Повторить» и правка всё равно её показывают — выбранной и с пометкой. */
  hidden: boolean;
}

/** Чипы «Выбрать услугу»: показываемые по порядку; выбранная скрытая — в конце. */
export function serviceChips(visible: readonly Service[], selected: Service | null): ServiceChip[] {
  const chips = visible.filter((s) => s.active).map((service) => ({ service, hidden: false }));
  if (selected && !chips.some((c) => c.service.id === selected.id)) chips.push({ service: selected, hidden: !selected.active });
  return chips;
}

// ─────────────────────────────────────────── форма услуги ───────────────────────────────────────────

export type ServiceField = 'title' | 'description' | 'price' | 'duration' | 'prepayment';

export interface ServiceFormValues {
  title: string;
  description: string;
  priceRaw: string;
  duration: number;
  prepayMode: PrepayMode;
  prepayCustomRaw: string;
  /** Процент, которого нет в сегментах (100 % у «Занятия»): хранится процентом, сумма за «Своя» — расчётная. */
  autoPercent: number | null;
  cancelRule: CancelRule;
  template: TemplateKey;
}

function prepayFromPercent(percent: number): Pick<ServiceFormValues, 'prepayMode' | 'prepayCustomRaw' | 'autoPercent'> {
  if (percent <= 0) return { prepayMode: 'none', prepayCustomRaw: '', autoPercent: null };
  if (percent === 30) return { prepayMode: 'p30', prepayCustomRaw: '', autoPercent: null };
  if (percent === 50) return { prepayMode: 'p50', prepayCustomRaw: '', autoPercent: null };
  return { prepayMode: 'custom', prepayCustomRaw: '', autoPercent: percent };
}

/** Сохранённая услуга → поля формы. */
export function serviceFormFrom(s: Service): ServiceFormValues {
  const prepay =
    s.prepayment.kind === 'percent'
      ? prepayFromPercent(s.prepayment.value)
      : s.prepayment.kind === 'amount' && s.prepayment.value > 0
        ? { prepayMode: 'custom' as const, prepayCustomRaw: String(s.prepayment.value), autoPercent: null }
        : prepayFromPercent(0);
  return {
    title: s.title,
    description: s.description ?? '',
    priceRaw: String(s.price_rub),
    duration: SERVICE_DURATIONS.includes(s.duration_min) ? s.duration_min : DEFAULT_DURATION_MIN,
    ...prepay,
    cancelRule: s.cancel_rule,
    template: s.template,
  };
}

/** Новая услуга: с нуля или из примера ниши (название, предоплата, правило; цену вводит исполнитель). */
export function serviceFormPreset(template: Template | null, defaultRule: CancelRule): ServiceFormValues {
  return {
    title: template?.title ?? '',
    description: '',
    priceRaw: '',
    duration: DEFAULT_DURATION_MIN,
    ...prepayFromPercent(template?.prepayment_percent ?? 0),
    cancelRule: template?.cancel_rule ?? defaultRule,
    template: template?.key ?? 'free',
  };
}

function toInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** Предоплата формы услуги: как её сохранить и сколько это рублей (для подсказки). null — ввод не разобран. */
export function formPrepayment(v: ServiceFormValues): { prepayment: ServicePrepayment; rub: number | null } | null {
  const price = toInt(v.priceRaw);
  switch (v.prepayMode) {
    case 'none':
      return { prepayment: { kind: 'none', value: 0 }, rub: 0 };
    case 'p30':
    case 'p50': {
      const value = v.prepayMode === 'p30' ? 30 : 50;
      return { prepayment: { kind: 'percent', value }, rub: price === null ? null : prepaymentRub(price, { kind: 'percent', value }) };
    }
    case 'custom': {
      if (v.autoPercent !== null) {
        const p: ServicePrepayment = { kind: 'percent', value: v.autoPercent };
        return { prepayment: p, rub: price === null ? null : prepaymentRub(price, p) };
      }
      const amount = toInt(v.prepayCustomRaw);
      return amount === null ? null : { prepayment: { kind: 'amount', value: amount }, rub: amount };
    }
  }
}

/** Проверка до отправки — те же границы, что у сервера (server/src/domain/services.ts); текст — у поля. */
export function validateServiceForm(v: ServiceFormValues): Partial<Record<ServiceField, string>> {
  const errors: Partial<Record<ServiceField, string>> = {};
  const title = v.title.trim();
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) errors.title = `Название от ${TITLE_MIN} до ${TITLE_MAX} символов`;
  if (v.description.trim().length > DESCRIPTION_MAX) errors.description = `Уточнения до ${DESCRIPTION_MAX} символов`;
  const raw = toInt(v.priceRaw);
  const price = raw !== null && raw >= PRICE_MIN && raw <= PRICE_MAX ? raw : null;
  if (price === null) errors.price = 'Сумма от 1 до 1 000 000 ₽';
  if (!SERVICE_DURATIONS.includes(v.duration)) errors.duration = 'Выберите длительность';
  const prepay = formPrepayment(v);
  if (prepay === null) errors.prepayment = 'Укажите сумму предоплаты числом';
  else if (prepay.prepayment.kind === 'amount' && (prepay.prepayment.value < 1 || (price !== null && prepay.prepayment.value > price))) {
    errors.prepayment = price !== null ? `Предоплата от 1 ₽ до ${formatRub(price)}` : 'Предоплата от 1 ₽ до суммы услуги';
  }
  return errors;
}

/** Поля формы → тело запроса. Вызывать после validateServiceForm без ошибок. */
export function serviceBodyFromForm(v: ServiceFormValues, active?: boolean): ServiceBody {
  const description = v.description.trim();
  const body: ServiceBody = {
    title: v.title.trim(),
    description: description === '' ? null : description,
    price_rub: toInt(v.priceRaw) ?? 0,
    duration_min: v.duration,
    prepayment: formPrepayment(v)?.prepayment ?? { kind: 'none', value: 0 },
    cancel_rule: v.cancelRule,
    template: v.template,
  };
  if (active !== undefined) body.active = active;
  return body;
}

/** 400 сервера — к какому полю (у ошибки нет поля в ответе, только текст из server/src/domain/services.ts). */
export function serviceErrorField(message: string): ServiceField | null {
  const text = message.trim().toLowerCase();
  if (text.startsWith('название')) return 'title';
  if (text.startsWith('уточнения')) return 'description';
  if (text.startsWith('сумма')) return 'price';
  if (text.startsWith('длительность')) return 'duration';
  if (text.startsWith('предоплата')) return 'prepayment';
  return null;
}

// ─────────────────────────────────────────── список и порядок ───────────────────────────────────────────

export function splitServices(items: readonly Service[]): { visible: Service[]; hidden: Service[] } {
  return { visible: items.filter((s) => s.active), hidden: items.filter((s) => !s.active) };
}

/**
 * Сдвиг показываемой услуги на одну позицию. Результат — все услуги в новом порядке для `PUT /api/services/order`:
 * показываемые, затем скрытые в прежнем порядке. null — сдвигать некуда (край списка) или услуги нет.
 */
export function moveService(items: readonly Service[], id: number, direction: -1 | 1): Service[] | null {
  const { visible, hidden } = splitServices(items);
  const from = visible.findIndex((s) => s.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= visible.length) return null;
  const next = [...visible];
  [next[from], next[to]] = [next[to], next[from]];
  return [...next, ...hidden];
}

/** Примеры ниш для пустого экрана — все шаблоны, кроме «Своей» (у неё нет готовых условий). */
export function exampleTemplates(templates: readonly Template[]): Template[] {
  return templates.filter((t) => t.key !== 'free');
}
