// Форма услуги — `#/settings/services/new` (в т. ч. из примера ниши) и `#/settings/services/<id>`, docs/SPEC.md §7.6a,
// контракт ЗАДАЧА_08 C. Поля: название, уточнения, цена, длительность, предоплата (тот же сегмент, что в форме сделки),
// правило отмены. «Сохранить» — назад к списку с тостом; у существующей — «Скрыть» / «Показывать снова» (удаления нет:
// на услугу ссылаются сделки). Ошибки — у поля, ввод не теряется. Вид — docs/DESIGN.md §4, §5.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Panel, Radio, Textarea, Typography } from '@maxhub/max-ui';

import { api, ApiError, errorText } from '../api';
import { disableClosingConfirmation, enableClosingConfirmation, haptic } from '../bridge';
import { ControlRow } from '../components/ControlRow';
import { Field, revealField } from '../components/Field';
import { Segmented } from '../components/Segmented';
import { ErrorScreen, LoadingScreen, NoticeScreen } from '../components/StateScreen';
import { useToast } from '../components/Toast';
import { CANCEL_RULE_LABEL, CANCEL_RULE_TEXT, CANCEL_RULES, formatRub } from '../format';
import {
  DESCRIPTION_MAX,
  formatDuration,
  formPrepayment,
  SERVICE_DURATIONS,
  serviceBodyFromForm,
  serviceErrorField,
  serviceFormFrom,
  serviceFormPreset,
  TITLE_MAX,
  validateServiceForm,
  type PrepayMode,
  type ServiceField,
  type ServiceFormValues,
} from '../services';
import type { MeResponse, Service, Template, TemplateKey } from '../types';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** Услуги с таким id у исполнителя нет (чужая, опечатка в адресе). */
  | { kind: 'missing' }
  | { kind: 'form'; service: Service | null };

const FIELD_ORDER: ServiceField[] = ['title', 'description', 'price', 'duration', 'prepayment'];
const anchor = (field: ServiceField) => `service-field-${field}`;
const PREPAY_CUSTOM_ANCHOR = 'service-field-prepayment-custom';

const PREPAY_OPTIONS: { value: PrepayMode; label: string }[] = [
  { value: 'none', label: 'Нет' },
  { value: 'p30', label: '30 %' },
  { value: 'p50', label: '50 %' },
  { value: 'custom', label: 'Своя' },
];

function digitsOnly(value: string, maxLength: number): string {
  return value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, maxLength);
}

export interface ServiceFormScreenProps {
  id: number | 'new';
  /** Пример ниши для новой услуги (с пустого экрана «Мои услуги»). */
  template?: TemplateKey;
  me: MeResponse;
  templates: Template[];
  /** Назад к списку «Мои услуги» (форма заменяется списком). */
  onDone: () => void;
}

export function ServiceFormScreen({ id, template, me, templates, onDone }: ServiceFormScreenProps) {
  const [state, setState] = useState<State>(() => (id === 'new' ? { kind: 'form', service: null } : { kind: 'loading' }));

  const load = useCallback(async () => {
    if (id === 'new') return;
    setState({ kind: 'loading' });
    try {
      // Отдельного GET одной услуги в API нет: берём весь список (со скрытыми) — их не больше 50.
      const { items } = await api.services(true);
      const service = items.find((s) => s.id === id);
      setState(service ? { kind: 'form', service } : { kind: 'missing' });
    } catch (error) {
      setState({ kind: 'error', message: errorText(error) });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') return <LoadingScreen />;
  if (state.kind === 'error') {
    return <ErrorScreen message={state.message} onRetry={() => void load()} secondary={{ label: 'Мои услуги', onClick: onDone }} />;
  }
  if (state.kind === 'missing') {
    return (
      <NoticeScreen
        title="Услуга не найдена"
        text="Такой услуги нет в вашем списке. Откройте «Мои услуги» и выберите другую."
        actions={[{ label: 'Мои услуги', onClick: onDone }]}
      />
    );
  }

  const preset = templates.find((t) => t.key === template) ?? null;
  const initial = state.service
    ? serviceFormFrom(state.service)
    : serviceFormPreset(preset, me.profile?.default_cancel_rule ?? 'free_24h');
  return <ServiceForm key={state.service?.id ?? 'new'} service={state.service} initial={initial} onDone={onDone} />;
}

/** Какому полю принадлежит значение формы — чтобы правка поля снимала с него ошибку сервера. */
const FIELD_OF: Record<keyof ServiceFormValues, ServiceField | null> = {
  title: 'title',
  description: 'description',
  priceRaw: 'price',
  duration: 'duration',
  prepayMode: 'prepayment',
  prepayCustomRaw: 'prepayment',
  autoPercent: 'prepayment',
  cancelRule: null,
  template: null,
};

interface ServiceFormProps {
  service: Service | null;
  initial: ServiceFormValues;
  onDone: () => void;
}

function ServiceForm({ service, initial, onDone }: ServiceFormProps) {
  const showToast = useToast();
  const [values, setValues] = useState<ServiceFormValues>(initial);
  const [touched, setTouched] = useState<Partial<Record<ServiceField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  /** Ошибки, которые вернул сервер (400): текст — у своего поля, пока поле не поправят. */
  const [serverErrors, setServerErrors] = useState<Partial<Record<ServiceField, string>>>({});
  /** Что отправляется: сохранение или «Скрыть» / «Показывать снова» — у той кнопки и спиннер. */
  const [saving, setSaving] = useState<'save' | 'toggle' | null>(null);

  const errors = useMemo(() => validateServiceForm(values), [values]);
  const prepay = formPrepayment(values);

  const shown = (field: ServiceField): string | null =>
    serverErrors[field] ?? (submitted || touched[field] ? (errors[field] ?? null) : null);
  const markTouched = (field: ServiceField) => setTouched((prev) => ({ ...prev, [field]: true }));

  function set<K extends keyof ServiceFormValues>(key: K, value: ServiceFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    const field = FIELD_OF[key];
    if (field && serverErrors[field]) setServerErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  // Подтверждение закрытия, пока форма отличается от того, с чего началась (SPEC §7.1).
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  useEffect(() => {
    if (dirty) enableClosingConfirmation();
    else disableClosingConfirmation();
  }, [dirty]);
  useEffect(() => () => disableClosingConfirmation(), []);

  function reveal(field: ServiceField) {
    const target = field === 'prepayment' && values.prepayMode === 'custom' ? PREPAY_CUSTOM_ANCHOR : anchor(field);
    window.requestAnimationFrame(() => revealField(target));
  }

  /** Сохранить; `active` — заодно скрыть или вернуть в форму сделки (только у существующей услуги). */
  async function save(active?: boolean) {
    setSubmitted(true);
    const first = FIELD_ORDER.find((field) => errors[field]);
    if (first) {
      haptic('error');
      showToast('Проверьте выделенные поля', 'error');
      reveal(first);
      return;
    }
    if (saving) return;
    const body = serviceBodyFromForm(values, service ? active : undefined);
    setSaving(active === undefined ? 'save' : 'toggle');
    try {
      if (service) await api.updateService(service.id, body);
      else await api.createService(body);
      haptic('success');
      disableClosingConfirmation();
      showToast(active === undefined ? 'Услуга сохранена' : active ? 'Услуга снова показывается' : 'Услуга скрыта');
      onDone();
    } catch (error) {
      haptic('error');
      setSaving(null);
      // 400 без поля в ответе — по тексту сервера находим поле; не нашли — тостом. Ввод не теряется.
      const field = error instanceof ApiError && error.status === 400 ? serviceErrorField(error.message) : null;
      if (field && error instanceof ApiError) {
        setServerErrors((prev) => ({ ...prev, [field]: error.message }));
        reveal(field);
        return;
      }
      showToast(errorText(error), 'error');
    }
  }

  const prepayHint =
    values.prepayMode === 'none'
      ? 'Без предоплаты клиент платит всю сумму после выполнения'
      : values.autoPercent !== null
        ? `${values.autoPercent} % от цены${prepay?.rub ? `: ${formatRub(prepay.rub)}` : ''}`
        : prepay?.rub
          ? `Предоплата ${formatRub(prepay.rub)}`
          : 'Сумма предоплаты считается от цены';

  const customValue = values.autoPercent !== null ? String(prepay?.rub ?? '') : values.prepayCustomRaw;

  return (
    <Panel mode="secondary" className="dg-root">
      <form
        className="dg-screen dg-screen_plain"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="dg-head">
          <Typography.Headline variant="large-strong" asChild>
            <h1>{service ? 'Услуга' : 'Новая услуга'}</h1>
          </Typography.Headline>
          <div className="dg-deal-id">
            <Typography.Text variant="body" color="secondary">
              Подставится в новую сделку целиком, кроме даты
            </Typography.Text>
            {service && !service.active ? <span className="dg-tag">скрыта</span> : null}
          </div>
        </header>

        <section className="dg-card" aria-label="Условия услуги">
          <Field label="Название" htmlFor="service-title" anchorId={anchor('title')} error={shown('title')}>
            <Input
              id="service-title"
              value={values.title}
              maxLength={TITLE_MAX}
              placeholder="Маникюр с покрытием"
              onChange={(event) => set('title', event.currentTarget.value)}
              onBlur={() => markTouched('title')}
            />
          </Field>

          <Field
            label="Уточнения"
            htmlFor="service-description"
            anchorId={anchor('description')}
            hint="Что входит в цену, материалы, адрес"
            error={shown('description')}
          >
            <Textarea
              id="service-description"
              mode="secondary"
              rows={3}
              value={values.description}
              maxLength={DESCRIPTION_MAX}
              onChange={(event) => set('description', event.currentTarget.value)}
              onBlur={() => markTouched('description')}
            />
          </Field>

          <Field label="Цена, ₽" htmlFor="service-price" anchorId={anchor('price')} error={shown('price')}>
            <Input
              id="service-price"
              inputMode="numeric"
              autoComplete="off"
              value={values.priceRaw}
              placeholder="2500"
              onChange={(event) => set('priceRaw', digitsOnly(event.currentTarget.value, 7))}
              onBlur={() => markTouched('price')}
            />
          </Field>

          <Field
            label="Длительность"
            htmlFor="service-duration"
            anchorId={anchor('duration')}
            hint="Сколько занимает визит"
            error={shown('duration')}
          >
            <div className="dg-select">
              <select
                id="service-duration"
                className="dg-select__control"
                value={String(values.duration)}
                onChange={(event) => set('duration', Number(event.currentTarget.value))}
              >
                {SERVICE_DURATIONS.map((minutes) => (
                  <option key={minutes} value={String(minutes)}>
                    {formatDuration(minutes)}
                  </option>
                ))}
              </select>
            </div>
          </Field>

          <Field label="Предоплата" anchorId={anchor('prepayment')} hint={prepayHint} error={values.prepayMode === 'custom' ? null : shown('prepayment')}>
            <Segmented<PrepayMode>
              ariaLabel="Предоплата"
              value={values.prepayMode}
              options={PREPAY_OPTIONS}
              onChange={(mode) => {
                setValues((prev) => ({ ...prev, prepayMode: mode, autoPercent: null }));
                if (serverErrors.prepayment) setServerErrors((prev) => ({ ...prev, prepayment: undefined }));
              }}
            />
          </Field>

          {values.prepayMode === 'custom' ? (
            <Field
              label="Сумма предоплаты, ₽"
              htmlFor="service-prepayment"
              anchorId={PREPAY_CUSTOM_ANCHOR}
              error={shown('prepayment')}
            >
              <Input
                id="service-prepayment"
                inputMode="numeric"
                autoComplete="off"
                value={customValue}
                placeholder="500"
                onChange={(event) => {
                  setValues((prev) => ({ ...prev, autoPercent: null, prepayCustomRaw: digitsOnly(event.currentTarget.value, 7) }));
                  if (serverErrors.prepayment) setServerErrors((prev) => ({ ...prev, prepayment: undefined }));
                }}
                onBlur={() => markTouched('prepayment')}
              />
            </Field>
          ) : null}

          <Field label="Правило отмены" hint={CANCEL_RULE_TEXT[values.cancelRule]}>
            <div>
              {CANCEL_RULES.map((rule) => (
                <ControlRow
                  key={rule}
                  title={CANCEL_RULE_LABEL[rule]}
                  control={
                    <Radio
                      name="service-cancel-rule"
                      value={rule}
                      checked={values.cancelRule === rule}
                      onChange={() => set('cancelRule', rule)}
                    />
                  }
                />
              ))}
            </div>
          </Field>
        </section>

        <div className="dg-actions">
          <Button
            type="submit"
            variant="primary"
            size="large"
            stretched
            loading={saving === 'save'}
            disabled={saving !== null && saving !== 'save'}
          >
            Сохранить
          </Button>
          {service ? (
            <Button
              type="button"
              variant="secondary"
              size="large"
              stretched
              loading={saving === 'toggle'}
              disabled={saving !== null && saving !== 'toggle'}
              onClick={() => void save(!service.active)}
            >
              {service.active ? 'Скрыть' : 'Показывать снова'}
            </Button>
          ) : null}
        </div>

        {service ? (
          <Typography.Text variant="description" color="tertiary">
            {service.active
              ? 'Скрытая услуга не предлагается в новой сделке, но остаётся у прежних сделок и в «Повторить».'
              : 'Сейчас услуга скрыта: в новой сделке её нет. Удалить нельзя, на неё ссылаются сделки.'}
          </Typography.Text>
        ) : null}
      </form>
    </Panel>
  );
}
