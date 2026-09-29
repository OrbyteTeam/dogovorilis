// Навигация мини-приложения (ЗАДАЧА_08 A, SPEC §7.1): стартовый экран, вкладки, история «назад».
import { describe, expect, it } from 'vitest';

import {
  back,
  canGoBack,
  current,
  HISTORY_LIMIT,
  initialRoute,
  parseHash,
  push,
  routeToHash,
  startHistory,
  tabOf,
  tabRoute,
  type Route,
} from '../src/nav';

const ID = 'AbCdE12345';

describe('стартовый экран', () => {
  it('start_param ведёт на свой экран', () => {
    expect(initialRoute('', 'new')).toEqual({ name: 'new' });
    expect(initialRoute('', 'deals')).toEqual({ name: 'deals' });
    expect(initialRoute('', 'settings')).toEqual({ name: 'settings' });
    expect(initialRoute('', `d_${ID}`)).toEqual({ name: 'done', id: ID });
    expect(initialRoute('', `edit_${ID}`)).toEqual({ name: 'edit', id: ID });
    expect(initialRoute('', `repeat_${ID}`)).toEqual({ name: 'new', from: ID });
    expect(initialRoute('', `deal_${ID}`)).toEqual({ name: 'deal', id: ID });
    expect(initialRoute('', `time_${ID}`)).toEqual({ name: 'time', id: ID });
  });

  it('неизвестный или испорченный start_param — форма новой сделки', () => {
    expect(initialRoute('', null)).toEqual({ name: 'new' });
    expect(initialRoute('', 'что-то')).toEqual({ name: 'new' });
    expect(initialRoute('', 'edit_short')).toEqual({ name: 'new' });
    expect(initialRoute('', 'deal_short')).toEqual({ name: 'new' });
    expect(initialRoute('', `deal_${ID}X`)).toEqual({ name: 'new' });
    expect(initialRoute('', `deal_${ID.slice(0, 9)}-`)).toEqual({ name: 'new' });
    expect(initialRoute('', 'time_short')).toEqual({ name: 'new' });
    expect(initialRoute('', `time_${ID}X`)).toEqual({ name: 'new' });
  });

  it('«Мои услуги» и форма услуги: id — положительное целое или new, пример — только известная ниша', () => {
    expect(parseHash('#/settings/services')).toEqual({ name: 'services' });
    expect(parseHash('#/settings/services/new')).toEqual({ name: 'service', id: 'new' });
    expect(parseHash('#/settings/services/7')).toEqual({ name: 'service', id: 7 });
    expect(parseHash('#/settings/services/new?template=lesson')).toEqual({ name: 'service', id: 'new', template: 'lesson' });
    expect(parseHash('#/settings/services/new?template=unknown')).toEqual({ name: 'service', id: 'new' });
    expect(parseHash('#/settings/services/0')).toBeNull();
    expect(parseHash('#/settings/services/-1')).toBeNull();
    expect(parseHash('#/settings/services/abc')).toBeNull();
    expect(routeToHash({ name: 'service', id: 12 })).toBe('#/settings/services/12');
  });

  it('экран сделки и правка условий не путаются', () => {
    expect(parseHash(`#/deals/${ID}`)).toEqual({ name: 'deal', id: ID });
    expect(parseHash(`#/deals/${ID}/edit`)).toEqual({ name: 'edit', id: ID });
    expect(parseHash('#/deals/short')).toBeNull();
    expect(parseHash(`#/deals/${ID}X`)).toBeNull();
    expect(parseHash(`#/deals/${ID}/`)).toBeNull();
    expect(routeToHash({ name: 'deal', id: ID })).toBe(`#/deals/${ID}`);
  });

  it('«Другое время» — свой экран, не экран сделки и не правка', () => {
    expect(parseHash(`#/deals/${ID}/time`)).toEqual({ name: 'time', id: ID });
    expect(routeToHash({ name: 'time', id: ID })).toBe(`#/deals/${ID}/time`);
    expect(parseHash(`#/deals/${ID}`)).toEqual({ name: 'deal', id: ID });
    expect(parseHash(`#/deals/${ID}/edit`)).toEqual({ name: 'edit', id: ID });
    expect(parseHash(`#/deals/${ID}/time/`)).toBeNull();
    expect(parseHash(`#/deals/${ID}/times`)).toBeNull();
    expect(parseHash(`#/deals/${ID}X/time`)).toBeNull();
    expect(parseHash('#/deals/short/time')).toBeNull();
  });

  it('hash после перезагрузки главнее start_param', () => {
    expect(initialRoute('#/settings', 'deals')).toEqual({ name: 'settings' });
  });

  it('hash и маршрут переводятся друг в друга без потерь', () => {
    const routes: Route[] = [
      { name: 'new' },
      { name: 'new', from: ID },
      { name: 'done', id: ID },
      { name: 'deals' },
      { name: 'edit', id: ID },
      { name: 'deal', id: ID },
      { name: 'time', id: ID },
      { name: 'settings' },
      { name: 'services' },
      { name: 'service', id: 'new' },
      { name: 'service', id: 'new', template: 'beauty' },
      { name: 'service', id: 42 },
    ];
    for (const r of routes) expect(parseHash(routeToHash(r))).toEqual(r);
  });
});

describe('вкладки', () => {
  it('подсвечена вкладка раздела, к которому относится экран', () => {
    expect(tabOf({ name: 'new' })).toBe('new');
    expect(tabOf({ name: 'done', id: ID })).toBe('new');
    expect(tabOf({ name: 'deals' })).toBe('deals');
    expect(tabOf({ name: 'edit', id: ID })).toBe('deals');
    expect(tabOf({ name: 'deal', id: ID })).toBe('deals');
    expect(tabOf({ name: 'time', id: ID })).toBe('deals');
    expect(tabOf({ name: 'new', from: ID })).toBe('deals');
    expect(tabOf({ name: 'settings' })).toBe('settings');
    expect(tabOf({ name: 'services' })).toBe('settings');
    expect(tabOf({ name: 'service', id: 'new' })).toBe('settings');
    expect(tabOf({ name: 'service', id: 3 })).toBe('settings');
  });

  it('вкладка открывает корневой экран раздела', () => {
    expect(tabRoute('new')).toEqual({ name: 'new' });
    expect(tabRoute('deals')).toEqual({ name: 'deals' });
    expect(tabRoute('settings')).toEqual({ name: 'settings' });
  });
});

describe('история «назад»', () => {
  it('на корневом экране «назад» нет — MAX закрывает приложение', () => {
    const h = startHistory({ name: 'deals' });
    expect(canGoBack(h)).toBe(false);
    expect(back(h)).toEqual(h);
  });

  it('«назад» возвращает по пройденным экранам', () => {
    let h = startHistory({ name: 'new' });
    h = push(h, { name: 'deals' });
    h = push(h, { name: 'edit', id: ID });
    expect(canGoBack(h)).toBe(true);
    h = back(h);
    expect(current(h)).toEqual({ name: 'deals' });
    h = back(h);
    expect(current(h)).toEqual({ name: 'new' });
    expect(canGoBack(h)).toBe(false);
  });

  it('с правки, открытой из чата, «назад» закрывает приложение, а «Мои сделки» — обычный шаг вперёд', () => {
    let h = startHistory({ name: 'edit', id: ID });
    expect(canGoBack(h)).toBe(false);
    h = push(h, { name: 'deals' });
    expect(current(h)).toEqual({ name: 'deals' });
    expect(current(back(h))).toEqual({ name: 'edit', id: ID });
  });

  it('из списка в сделку, оттуда в правку — «назад» возвращает по шагам', () => {
    let h = startHistory({ name: 'deals' });
    h = push(h, { name: 'deal', id: ID });
    h = push(h, { name: 'edit', id: ID });
    expect(current(back(h))).toEqual({ name: 'deal', id: ID });
    expect(current(back(back(h)))).toEqual({ name: 'deals' });
  });

  it('сделка → «Другое время» → после отправки «К сделке» возвращает к той же сделке, без экрана времени в стеке', () => {
    let h = startHistory({ name: 'deals' });
    h = push(h, { name: 'deal', id: ID });
    h = push(h, { name: 'time', id: ID });
    expect(current(back(h))).toEqual({ name: 'deal', id: ID });
    h = push(h, { name: 'deal', id: ID }, { replace: true });
    expect(h).toEqual([{ name: 'deals' }, { name: 'deal', id: ID }]);
  });

  it('«Другое время», открытое из чата (time_<id>), — корень; «К сделке» занимает его место', () => {
    let h = startHistory(initialRoute('', `time_${ID}`));
    expect(current(h)).toEqual({ name: 'time', id: ID });
    expect(canGoBack(h)).toBe(false);
    h = push(h, { name: 'deal', id: ID }, { replace: true });
    expect(h).toEqual([{ name: 'deal', id: ID }]);
    expect(canGoBack(h)).toBe(false);
  });

  it('экран сделки, открытый из чата (deal_<id>), — корень: «назад» закрывает приложение', () => {
    const h = startHistory(initialRoute('', `deal_${ID}`));
    expect(current(h)).toEqual({ name: 'deal', id: ID });
    expect(canGoBack(h)).toBe(false);
  });

  it('настройки → услуги → форма; сохранение возвращает к списку, а не к форме', () => {
    let h = startHistory({ name: 'settings' });
    h = push(h, { name: 'services' });
    h = push(h, { name: 'service', id: 'new', template: 'beauty' });
    h = push(h, { name: 'services' }, { replace: true });
    expect(h).toEqual([{ name: 'settings' }, { name: 'services' }]);
    expect(current(back(h))).toEqual({ name: 'settings' });
  });

  it('переключение вкладок туда-обратно не растит стек', () => {
    let h = startHistory({ name: 'new' });
    h = push(h, { name: 'deals' });
    h = push(h, { name: 'settings' });
    h = push(h, { name: 'deals' });
    expect(h).toEqual([{ name: 'new' }, { name: 'deals' }]);
    h = push(h, { name: 'new' });
    expect(h).toEqual([{ name: 'new' }]);
    expect(canGoBack(h)).toBe(false);
  });

  it('повторное нажатие текущей вкладки ничего не меняет', () => {
    const h = push(startHistory({ name: 'new' }), { name: 'deals' });
    expect(push(h, { name: 'deals' })).toEqual(h);
  });

  it('«Готово» заменяет форму: «назад» не возвращает к отправленной форме', () => {
    let h = startHistory({ name: 'deals' });
    h = push(h, { name: 'new' });
    h = push(h, { name: 'done', id: ID }, { replace: true });
    expect(h).toEqual([{ name: 'deals' }, { name: 'done', id: ID }]);
    expect(current(back(h))).toEqual({ name: 'deals' });
  });

  it('форма, с которой открыли приложение, после отправки уступает корень «Готово»', () => {
    const h = push(startHistory({ name: 'new' }), { name: 'done', id: ID }, { replace: true });
    expect(h).toEqual([{ name: 'done', id: ID }]);
    expect(canGoBack(h)).toBe(false);
  });

  it('стек ограничен, корень сохраняется', () => {
    let h = startHistory({ name: 'settings' });
    for (let i = 0; i < HISTORY_LIMIT * 2; i += 1) h = push(h, { name: 'edit', id: `Id${String(i).padStart(8, '0')}` });
    expect(h.length).toBe(HISTORY_LIMIT);
    expect(h[0]).toEqual({ name: 'settings' });
  });
});
