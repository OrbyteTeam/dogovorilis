// «Мои услуги» — `#/settings/services`, docs/SPEC.md §7.6a, контракт ЗАДАЧА_08 C: показываемые услуги по порядку со
// стрелками «выше / ниже», «Добавить услугу», ниже — «Скрытые»; пусто — подсказка и примеры ниш. Услуга — инструмент
// исполнителя, а не витрина: клиент этот список не видит. Строка — настоящая кнопка, стрелки стоят рядом с ней, а не
// внутри. Вид — docs/DESIGN.md §4.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, CellSimple, IconButton, Panel, Typography } from '@maxhub/max-ui';

import { api, errorText } from '../api';
import { haptic } from '../bridge';
import { AppHeader } from '../components/AppHeader';
import { ErrorScreen, LoadingScreen } from '../components/StateScreen';
import { TemplateChips } from '../components/TemplateChips';
import { useToast } from '../components/Toast';
import { formatRub } from '../format';
import { exampleTemplates, moveService, serviceSubtitle, SERVICES_LIMIT, splitServices } from '../services';
import type { Service, Template, TemplateKey } from '../types';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; items: Service[] };

function ArrowIcon({ up }: { up: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d={up ? 'M5 12.5 10 7.5l5 5' : 'M5 7.5l5 5 5-5'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const arrowId = (id: number, up: boolean) => `service-${id}-${up ? 'up' : 'down'}`;

/** После сдвига фокус остаётся на стрелке той же услуги; упёрлась в край — на соседней стрелке. */
function focusArrow(id: number, up: boolean) {
  window.requestAnimationFrame(() => {
    const same = document.getElementById(arrowId(id, up)) as HTMLButtonElement | null;
    const other = document.getElementById(arrowId(id, !up)) as HTMLButtonElement | null;
    const target = same && !same.disabled ? same : other;
    try {
      target?.focus({ preventScroll: true });
    } catch {
      /* фокус не обязателен */
    }
  });
}

export interface ServicesScreenProps {
  templates: Template[];
  /** Форма услуги `#/settings/services/<id>`. */
  onOpen: (id: number) => void;
  /** Новая услуга; с примером ниши — предзаполненная. */
  onNew: (template?: TemplateKey) => void;
  onSettings: () => void;
}

export function ServicesScreen({ templates, onOpen, onNew, onSettings }: ServicesScreenProps) {
  const showToast = useToast();
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Пока сервер сохраняет порядок, следующий сдвиг ждёт: иначе ответы придут не в том порядке, что нажатия.
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      // Все, со скрытыми: новый порядок уходит полным списком (PUT /api/services/order).
      const { items } = await api.services(true);
      setState({ kind: 'ready', items });
    } catch (error) {
      setState({ kind: 'error', message: errorText(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function move(id: number, up: boolean) {
    if (state.kind !== 'ready' || busyRef.current) return;
    const next = moveService(state.items, id, up ? -1 : 1);
    if (!next) return;
    const before = state.items;
    busyRef.current = true;
    // Сразу на экране — ответ сервера только подтверждает порядок; не сохранилось — возвращаем как было.
    setState({ kind: 'ready', items: next });
    haptic('selection');
    focusArrow(id, up);
    try {
      const { items } = await api.reorderServices(next.map((s) => s.id));
      setState({ kind: 'ready', items });
    } catch (error) {
      setState({ kind: 'ready', items: before });
      haptic('error');
      showToast(errorText(error), 'error');
    } finally {
      busyRef.current = false;
    }
  }

  if (state.kind === 'loading') return <LoadingScreen />;
  if (state.kind === 'error') {
    return <ErrorScreen message={state.message} onRetry={() => void load()} secondary={{ label: 'Настройки', onClick: onSettings }} />;
  }

  const { visible, hidden } = splitServices(state.items);
  const full = state.items.length >= SERVICES_LIMIT;

  return (
    <Panel mode="secondary" className="dg-root">
      <div className="dg-screen dg-screen_plain">
        <AppHeader title="Мои услуги" subtitle="Готовые условия для новой сделки. Клиент этот список не видит" />

        {state.items.length === 0 ? (
          <section className="dg-card" aria-label="Услуг пока нет">
            <Typography.Text variant="body" color="secondary">
              Сохраните то, что делаете чаще всего: карточка соберётся в одно нажатие
            </Typography.Text>
            <div className="dg-field">
              <span className="dg-field__label">Начните с примера</span>
              <TemplateChips
                items={exampleTemplates(templates)}
                value={null}
                onSelect={(template) => onNew(template.key)}
                ariaLabel="Примеры услуг"
              />
            </div>
          </section>
        ) : null}

        {visible.length > 0 ? (
          <section className="dg-section" aria-labelledby="services-visible">
            <div className="dg-section__head">
              <Typography.Text variant="title" asChild>
                <h2 id="services-visible">В новой сделке</h2>
              </Typography.Text>
              <Typography.Text variant="description" color="tertiary">
                В этом порядке их видно в форме сделки
              </Typography.Text>
            </div>
            <div className="dg-island">
              {visible.map((service, index) => (
                <div key={service.id} className="dg-service">
                  <ServiceRow service={service} onOpen={onOpen} />
                  <div className="dg-service__order" role="group" aria-label={`Порядок: ${service.title}`}>
                    <IconButton
                      id={arrowId(service.id, true)}
                      type="button"
                      variant="secondary"
                      size="small"
                      className="dg-arrow"
                      aria-label={`Выше: ${service.title}`}
                      disabled={index === 0}
                      onClick={() => void move(service.id, true)}
                    >
                      <ArrowIcon up />
                    </IconButton>
                    <IconButton
                      id={arrowId(service.id, false)}
                      type="button"
                      variant="secondary"
                      size="small"
                      className="dg-arrow"
                      aria-label={`Ниже: ${service.title}`}
                      disabled={index === visible.length - 1}
                      onClick={() => void move(service.id, false)}
                    >
                      <ArrowIcon up={false} />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="dg-actions">
          <Button type="button" variant="primary" size="large" stretched disabled={full} onClick={() => onNew()}>
            Добавить услугу
          </Button>
          {full ? (
            <Typography.Text variant="description" color="secondary">
              {`Услуг уже ${SERVICES_LIMIT}. Скройте ненужные или измените существующую`}
            </Typography.Text>
          ) : null}
        </div>

        {hidden.length > 0 ? (
          <section className="dg-section" aria-labelledby="services-hidden">
            <div className="dg-section__head">
              <Typography.Text variant="title" asChild>
                <h2 id="services-hidden">Скрытые</h2>
              </Typography.Text>
              <Typography.Text variant="description" color="tertiary">
                В форме сделки не предлагаются. Откройте, чтобы показывать снова
              </Typography.Text>
            </div>
            <div className="dg-island">
              {hidden.map((service) => (
                <ServiceRow key={service.id} service={service} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * Строка услуги — кнопка, открывающая форму: название, под ним сумма, длительность и предоплата. Сумма в подписи,
 * а не колонкой справа: рядом стоят стрелки порядка, и на узком экране название иначе ломалось посреди слова.
 */
function ServiceRow({ service, onOpen }: { service: Service; onOpen: (id: number) => void }) {
  return (
    <CellSimple
      as="button"
      className="dg-deal__open dg-service__open"
      onClick={() => onOpen(service.id)}
      title={service.title}
      subtitle={`${formatRub(service.price_rub)}, ${serviceSubtitle(service)}`}
    />
  );
}
