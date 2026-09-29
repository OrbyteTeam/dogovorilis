// «Мои услуги» (ЗАДАЧА_08 C, SPEC §7.6a): длительность и предоплата словами, подстановка в форму сделки,
// «Сохранить как услугу», форма услуги, порядок.
import { describe, expect, it } from 'vitest';

import {
  canSaveAsService,
  dealFillFromService,
  exampleTemplates,
  formatDuration,
  moveService,
  prepaymentRub,
  prepaymentText,
  serviceBodyFromDeal,
  serviceBodyFromForm,
  serviceChips,
  serviceErrorField,
  serviceFormFrom,
  serviceFormPreset,
  serviceSubtitle,
  SERVICE_DURATIONS,
  validateServiceForm,
} from '../src/services';
import type { Service, Template } from '../src/types';

const plain = (s: string) => s.replace(/\u00A0/g, ' ');

function service(over: Partial<Service> = {}): Service {
  return {
    id: 1,
    title: 'Маникюр с покрытием',
    description: 'Френч',
    price_rub: 2500,
    duration_min: 90,
    prepayment: { kind: 'percent', value: 30 },
    cancel_rule: 'free_24h',
    template: 'beauty',
    active: true,
    sort_order: 1,
    ...over,
  };
}

const lesson: Template = {
  key: 'lesson',
  label: 'Занятие',
  title: 'Занятие 60 минут',
  prepayment_percent: 100,
  cancel_rule: 'free_24h',
  date_required: true,
  hint: null,
};

describe('длительность и предоплата словами', () => {
  it('длительность: минуты, часы, часы с минутами', () => {
    expect(plain(formatDuration(15))).toBe('15 мин');
    expect(plain(formatDuration(60))).toBe('1 ч');
    expect(plain(formatDuration(90))).toBe('1 ч 30 мин');
    expect(plain(formatDuration(150))).toBe('2 ч 30 мин');
    expect(plain(formatDuration(720))).toBe('12 ч');
  });

  it('пункты выбора — от 15 минут до 12 часов, шаг 15, по возрастанию', () => {
    expect(SERVICE_DURATIONS[0]).toBe(15);
    expect(SERVICE_DURATIONS[SERVICE_DURATIONS.length - 1]).toBe(720);
    for (const d of SERVICE_DURATIONS) expect(d % 15).toBe(0);
    expect([...SERVICE_DURATIONS].sort((a, b) => a - b)).toEqual([...SERVICE_DURATIONS]);
  });

  it('предоплата: процент, сумма, без предоплаты', () => {
    expect(plain(prepaymentText({ kind: 'percent', value: 30 }))).toBe('предоплата 30 %');
    expect(plain(prepaymentText({ kind: 'amount', value: 500 }))).toBe('предоплата 500 ₽');
    expect(prepaymentText({ kind: 'none', value: 0 })).toBe('без предоплаты');
    expect(plain(serviceSubtitle(service()))).toBe('1 ч 30 мин, предоплата 30 %');
  });

  it('новые подписи без длинных тире и точек-разделителей', () => {
    expect(serviceSubtitle(service())).not.toMatch(/[—·]/);
    expect(serviceSubtitle(service({ prepayment: { kind: 'none', value: 0 } }))).not.toMatch(/[—·]/);
  });

  it('процент — с округлением до рубля вверх и не больше цены', () => {
    expect(prepaymentRub(1999, { kind: 'percent', value: 30 })).toBe(600);
    expect(prepaymentRub(2000, { kind: 'percent', value: 100 })).toBe(2000);
    expect(prepaymentRub(1000, { kind: 'amount', value: 1500 })).toBe(1000);
    expect(prepaymentRub(1000, { kind: 'none', value: 0 })).toBe(0);
  });
});

describe('услуга в форме сделки', () => {
  it('подставляет всё, кроме даты: 30 % и 50 % — сегментом', () => {
    expect(dealFillFromService(service())).toEqual({
      templateKey: 'beauty',
      title: 'Маникюр с покрытием',
      description: 'Френч',
      totalRaw: '2500',
      prepayMode: 'p30',
      prepayCustomRaw: '',
      cancelRule: 'free_24h',
    });
    expect(dealFillFromService(service({ prepayment: { kind: 'percent', value: 50 } })).prepayMode).toBe('p50');
  });

  it('другой процент — «Своя» с суммой, округлённой вверх; сумма — «Своя» как есть; без предоплаты — «Нет»', () => {
    expect(dealFillFromService(service({ price_rub: 1999, prepayment: { kind: 'percent', value: 40 } }))).toMatchObject({
      prepayMode: 'custom',
      prepayCustomRaw: '800',
    });
    expect(dealFillFromService(service({ prepayment: { kind: 'amount', value: 750 } }))).toMatchObject({
      prepayMode: 'custom',
      prepayCustomRaw: '750',
    });
    expect(dealFillFromService(service({ prepayment: { kind: 'none', value: 0 }, description: null }))).toMatchObject({
      prepayMode: 'none',
      prepayCustomRaw: '',
      description: '',
    });
  });

  it('«Сохранить как услугу» — только без выбранной услуги и с названием и суммой', () => {
    expect(canSaveAsService({ selectedId: null, title: 'Стрижка', totalRaw: '1200' })).toBe(true);
    expect(canSaveAsService({ selectedId: 3, title: 'Стрижка', totalRaw: '1200' })).toBe(false);
    expect(canSaveAsService({ selectedId: null, title: '  ', totalRaw: '1200' })).toBe(false);
    expect(canSaveAsService({ selectedId: null, title: 'Стрижка', totalRaw: '' })).toBe(false);
  });

  it('тело «Сохранить как услугу»: длительность 60, 30/50 % — процентом, «Своя» — суммой, «Нет» — без предоплаты', () => {
    const base = { title: ' Стрижка ', description: '  ', totalRub: 1200, prepaymentRub: 360, cancelRule: 'free_48h' as const, templateKey: null };
    expect(serviceBodyFromDeal({ ...base, prepayMode: 'p30' })).toEqual({
      title: 'Стрижка',
      description: null,
      price_rub: 1200,
      duration_min: 60,
      prepayment: { kind: 'percent', value: 30 },
      cancel_rule: 'free_48h',
      template: 'free',
    });
    expect(serviceBodyFromDeal({ ...base, prepayMode: 'p50', prepaymentRub: 600 }).prepayment).toEqual({ kind: 'percent', value: 50 });
    expect(serviceBodyFromDeal({ ...base, prepayMode: 'custom', prepaymentRub: 400 }).prepayment).toEqual({ kind: 'amount', value: 400 });
    expect(serviceBodyFromDeal({ ...base, prepayMode: 'custom', prepaymentRub: 0 }).prepayment).toEqual({ kind: 'none', value: 0 });
    expect(serviceBodyFromDeal({ ...base, prepayMode: 'none', prepaymentRub: 0 }).prepayment).toEqual({ kind: 'none', value: 0 });
  });

  it('чипы: показываемые по порядку, выбранная скрытая — в конце с пометкой', () => {
    const a = service({ id: 1 });
    const b = service({ id: 2, title: 'Брови' });
    const hidden = service({ id: 9, title: 'Педикюр', active: false });
    expect(serviceChips([a, b], null).map((c) => [c.service.id, c.hidden])).toEqual([
      [1, false],
      [2, false],
    ]);
    expect(serviceChips([a, b], hidden).map((c) => [c.service.id, c.hidden])).toEqual([
      [1, false],
      [2, false],
      [9, true],
    ]);
    expect(serviceChips([a, b], b)).toHaveLength(2);
  });
});

describe('форма услуги', () => {
  it('пример ниши: название, предоплата, правило; цену вводит исполнитель', () => {
    const v = serviceFormPreset(lesson, 'nonrefundable');
    expect(v).toMatchObject({ title: 'Занятие 60 минут', priceRaw: '', duration: 60, cancelRule: 'free_24h', template: 'lesson' });
    // 100 % нет в сегментах — хранится процентом за «Своя».
    expect(v).toMatchObject({ prepayMode: 'custom', autoPercent: 100 });
    expect(serviceFormPreset(null, 'free_48h')).toMatchObject({ title: '', prepayMode: 'none', cancelRule: 'free_48h', template: 'free' });
  });

  it('сохранённая услуга → поля → то же тело', () => {
    for (const prepayment of [
      { kind: 'percent', value: 30 },
      { kind: 'percent', value: 100 },
      { kind: 'amount', value: 700 },
      { kind: 'none', value: 0 },
    ] as const) {
      const s = service({ prepayment });
      expect(serviceBodyFromForm(serviceFormFrom(s))).toEqual({
        title: s.title,
        description: s.description,
        price_rub: s.price_rub,
        duration_min: s.duration_min,
        prepayment,
        cancel_rule: s.cancel_rule,
        template: s.template,
      });
    }
    expect(serviceBodyFromForm(serviceFormFrom(service()), false).active).toBe(false);
  });

  it('ошибки — у полей, с теми же границами, что у сервера', () => {
    const ok = serviceFormFrom(service());
    expect(validateServiceForm(ok)).toEqual({});
    expect(validateServiceForm({ ...ok, title: 'М' }).title).toBe('Название от 2 до 80 символов');
    expect(validateServiceForm({ ...ok, description: 'а'.repeat(1001) }).description).toBe('Уточнения до 1000 символов');
    expect(validateServiceForm({ ...ok, priceRaw: '' }).price).toBe('Сумма от 1 до 1 000 000 ₽');
    expect(validateServiceForm({ ...ok, priceRaw: '1000001' }).price).toBe('Сумма от 1 до 1 000 000 ₽');
    expect(validateServiceForm({ ...ok, duration: 50 }).duration).toBe('Выберите длительность');
    const custom = { ...ok, prepayMode: 'custom' as const, autoPercent: null };
    expect(validateServiceForm({ ...custom, prepayCustomRaw: '' }).prepayment).toBe('Укажите сумму предоплаты числом');
    expect(plain(validateServiceForm({ ...custom, prepayCustomRaw: '3000' }).prepayment ?? '')).toBe('Предоплата от 1 ₽ до 2 500 ₽');
    expect(validateServiceForm({ ...custom, prepayCustomRaw: '0' }).prepayment).toBeDefined();
    expect(validateServiceForm({ ...custom, prepayCustomRaw: '2500' })).toEqual({});
  });

  it('текст 400 сервера попадает к своему полю', () => {
    expect(serviceErrorField('Название от 2 до 80 символов')).toBe('title');
    expect(serviceErrorField('Сумма целым числом рублей')).toBe('price');
    expect(serviceErrorField('Длительность от 15 минут до 12 часов, шаг 15 минут')).toBe('duration');
    expect(serviceErrorField('Предоплата: процент от 1 до 100 или сумма не больше цены')).toBe('prepayment');
    expect(serviceErrorField('Уточнения до 1000 символов')).toBe('description');
    expect(serviceErrorField('Проверьте заполнение полей')).toBeNull();
  });
});

describe('порядок', () => {
  const a = service({ id: 1 });
  const hiddenX = service({ id: 5, active: false });
  const b = service({ id: 2 });
  const c = service({ id: 3 });

  it('сдвиг среди показываемых; скрытые — в конце в прежнем порядке', () => {
    expect(moveService([a, hiddenX, b, c], 2, -1)?.map((s) => s.id)).toEqual([2, 1, 3, 5]);
    expect(moveService([a, b, c, hiddenX], 1, 1)?.map((s) => s.id)).toEqual([2, 1, 3, 5]);
  });

  it('на краях и для скрытой сдвигать некуда', () => {
    expect(moveService([a, b, c], 1, -1)).toBeNull();
    expect(moveService([a, b, c], 3, 1)).toBeNull();
    expect(moveService([a, b, hiddenX], 5, -1)).toBeNull();
  });

  it('примеры для пустого экрана — все ниши, кроме «Своей»', () => {
    const free: Template = { ...lesson, key: 'free', title: '' };
    expect(exampleTemplates([lesson, free]).map((t) => t.key)).toEqual(['lesson']);
  });
});
