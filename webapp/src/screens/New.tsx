// Экран «Новая сделка» — docs/SPEC.md §7.2 (таблица полей и правил), §7.6 (шаблоны); вид — docs/DESIGN.md §4–§5.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Panel, Radio, Switch, Textarea, Typography } from '@maxhub/max-ui';

import { api, errorText } from '../api';
import { disableClosingConfirmation, enableClosingConfirmation, haptic, userDisplayName } from '../bridge';
import { ControlRow } from '../components/ControlRow';
import { Field } from '../components/Field';
import { Segmented } from '../components/Segmented';
import { TemplateChips } from '../components/TemplateChips';
import { useToast } from '../components/Toast';
import { CANCEL_RULE_LABEL, CANCEL_RULE_TEXT, CANCEL_RULES, formatRub, TAX_MODE_LABEL, TAX_MODES } from '../format';
import type {
  CancelRule,
  CreateDealRequest,
  CreateDealResponse,
  MeResponse,
  SellerProfile,
  TaxMode,
  Template,
  TemplateKey,
} from '../types';

const TOTAL_MIN = 1;
const TOTAL_MAX = 1_000_000;
const TITLE_MIN = 2;
const TITLE_MAX = 80;
const NAME_MIN = 2;
const NAME_MAX = 40;
const DESCRIPTION_MAX = 1000;
const PAYOUT_MAX = 200;
/** «Когда» — не раньше чем через 30 минут (SPEC §7.2). */
const LEAD_TIME_MS = 30 * 60 * 1000;

type PrepayMode = 'none' | 'p30' | 'p50' | 'custom';

type FieldName = 'display_name' | 'payout_details' | 'title' | 'description' | 'scheduled_at' | 'total' | 'prepayment';

type Errors = Partial<Record<FieldName, string>>;

function digitsOnly(value: string, maxLength: number): string {
  return value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, maxLength);
}

function toInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export interface NewScreenProps {
  me: MeResponse;
  templates: Template[];
  /** `savedProfile` — профиль, сохранённый этим же запросом; null, если он уже был. */
  onCreated: (result: CreateDealResponse, savedProfile: SellerProfile | null) => void;
}

export function NewScreen({ me, templates, onCreated }: NewScreenProps) {
  const showToast = useToast();
  const needProfile = me.profile === null;

  // Блок «О вас» — только когда профиля ещё нет (SPEC §7.2).
  const [displayName, setDisplayName] = useState(() => me.profile?.display_name ?? userDisplayName() ?? '');
  const [taxMode, setTaxMode] = useState<TaxMode>(me.profile?.tax_mode ?? 'npd');
  const [payoutDetails, setPayoutDetails] = useState(me.profile?.payout_details ?? '');

  const [templateKey, setTemplateKey] = useState<TemplateKey | null>(null);
  const [templateHint, setTemplateHint] = useState<string | null>(null);
  const [dateRequired, setDateRequired] = useState(false);
  const templateTitle = useRef('');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [noDate, setNoDate] = useState(true);
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [totalRaw, setTotalRaw] = useState('');
  const [prepayMode, setPrepayMode] = useState<PrepayMode>('none');
  const [prepayCustomRaw, setPrepayCustomRaw] = useState('');
  /** Процент из шаблона, которого нет в сегментах (например 100 %): сумма пересчитывается за «Своя сумма». */
  const [autoPercent, setAutoPercent] = useState<number | null>(null);
  const [cancelRule, setCancelRule] = useState<CancelRule>(me.profile?.default_cancel_rule ?? 'free_24h');

  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);

  const minDateValue = useMemo(() => toLocalInputValue(new Date(Date.now() + LEAD_TIME_MS)), []);

  const totalRub = toInt(totalRaw);

  const prepaymentRub = useMemo(() => {
    const percent = prepayMode === 'p30' ? 30 : prepayMode === 'p50' ? 50 : prepayMode === 'custom' ? autoPercent : null;
    if (prepayMode === 'none') return 0;
    if (percent !== null) {
      // Округление до рубля вверх (SPEC §7.2).
      return totalRub === null ? null : Math.ceil((totalRub * percent) / 100);
    }
    return toInt(prepayCustomRaw);
  }, [prepayMode, autoPercent, totalRub, prepayCustomRaw]);

  const prepayCustomValue = autoPercent !== null ? String(prepaymentRub ?? '') : prepayCustomRaw;

  const errors = useMemo<Errors>(() => {
    const next: Errors = {};

    if (needProfile) {
      const name = displayName.trim();
      if (name.length < NAME_MIN || name.length > NAME_MAX) {
        next.display_name = `Имя — от ${NAME_MIN} до ${NAME_MAX} символов`;
      }
      if (payoutDetails.trim().length > PAYOUT_MAX) {
        next.payout_details = `Реквизиты — не больше ${PAYOUT_MAX} символов`;
      }
    }

    const dealTitle = title.trim();
    if (dealTitle.length < TITLE_MIN || dealTitle.length > TITLE_MAX) {
      next.title = `Название — от ${TITLE_MIN} до ${TITLE_MAX} символов`;
    }
    if (description.trim().length > DESCRIPTION_MAX) {
      next.description = `Уточнения — не больше ${DESCRIPTION_MAX} символов`;
    }

    if (noDate) {
      if (dateRequired) next.scheduled_at = 'Для этого шаблона нужны дата и время';
    } else if (!scheduledLocal) {
      next.scheduled_at = 'Укажите дату и время или выберите «Без даты»';
    } else {
      const at = new Date(scheduledLocal).getTime();
      if (Number.isNaN(at)) next.scheduled_at = 'Укажите дату и время или выберите «Без даты»';
      else if (at < Date.now() + LEAD_TIME_MS - 60_000) next.scheduled_at = 'Дата не раньше чем через 30 минут';
    }

    if (totalRub === null || totalRub < TOTAL_MIN || totalRub > TOTAL_MAX) {
      next.total = 'Сумма — от 1 до 1 000 000 ₽';
    }

    if (prepaymentRub === null) {
      next.prepayment = 'Укажите предоплату числом';
    } else if (prepaymentRub < 0 || (totalRub !== null && prepaymentRub > totalRub)) {
      next.prepayment = totalRub === null ? 'Предоплата не больше суммы' : `Предоплата — от 0 до ${formatRub(totalRub)}`;
    }

    return next;
  }, [
    needProfile,
    displayName,
    payoutDetails,
    title,
    description,
    noDate,
    dateRequired,
    scheduledLocal,
    totalRub,
    prepaymentRub,
  ]);

  const shown = (field: FieldName): string | null =>
    submitted || touched[field] ? (errors[field] ?? null) : null;

  const markTouched = (field: FieldName) => setTouched((prev) => ({ ...prev, [field]: true }));

  // Подтверждение закрытия, пока в форме есть несохранённые данные (SPEC §7.1).
  const dirty =
    templateKey !== null ||
    title.trim() !== '' ||
    description.trim() !== '' ||
    totalRaw !== '' ||
    prepayCustomRaw !== '' ||
    (!noDate && scheduledLocal !== '') ||
    (needProfile && (displayName.trim() !== '' || payoutDetails.trim() !== ''));

  useEffect(() => {
    if (dirty) enableClosingConfirmation();
    else disableClosingConfirmation();
  }, [dirty]);

  useEffect(() => () => disableClosingConfirmation(), []);

  function applyTemplate(template: Template) {
    setTemplateKey(template.key);
    setTemplateHint(template.hint);
    // Название подставляем, если пользователь его ещё не менял руками.
    if (template.title && (title.trim() === '' || title === templateTitle.current)) {
      setTitle(template.title);
      templateTitle.current = template.title;
    }
    setCancelRule(template.cancel_rule);
    const percent = template.prepayment_percent;
    if (percent <= 0) {
      setPrepayMode('none');
      setAutoPercent(null);
    } else if (percent === 30) {
      setPrepayMode('p30');
      setAutoPercent(null);
    } else if (percent === 50) {
      setPrepayMode('p50');
      setAutoPercent(null);
    } else {
      setPrepayMode('custom');
      setAutoPercent(percent);
    }
    setDateRequired(template.date_required);
    if (template.date_required) setNoDate(false);
    haptic('selection');
  }

  function buildProfile(): SellerProfile {
    const details = payoutDetails.trim();
    return {
      display_name: displayName.trim(),
      tax_mode: taxMode,
      payout_details: details === '' ? null : details,
      transfer_enabled: details !== '',
      link_enabled: me.config.provider !== 'none',
      default_cancel_rule: cancelRule,
    };
  }

  async function submit() {
    setSubmitted(true);
    if (Object.keys(errors).length > 0 || totalRub === null || prepaymentRub === null) {
      haptic('error');
      showToast('Проверьте выделенные поля', 'error');
      return;
    }
    if (sending) return;

    const payload: CreateDealRequest = {
      template: templateKey ?? 'free',
      title: title.trim(),
      scheduled_at: noDate ? null : new Date(scheduledLocal).toISOString(),
      total_rub: totalRub,
      prepayment_rub: prepaymentRub,
      cancel_rule: cancelRule,
    };
    const trimmedDescription = description.trim();
    if (trimmedDescription) payload.description = trimmedDescription;
    if (needProfile) payload.profile = buildProfile();

    setSending(true);
    try {
      const result = await api.createDeal(payload);
      disableClosingConfirmation();
      haptic('success');
      onCreated(result, payload.profile ?? null);
    } catch (error) {
      haptic('error');
      showToast(errorText(error), 'error');
    } finally {
      setSending(false);
    }
  }

  const payoutEmpty = payoutDetails.trim() === '';

  return (
    <Panel mode="secondary" className="dg-root">
      <form
        className="dg-screen"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Typography.Headline variant="large-strong" asChild>
          <h1>Новая сделка</h1>
        </Typography.Headline>

        {needProfile ? (
          <section className="dg-card" aria-labelledby="about-you">
            <Typography.Text variant="title" asChild>
              <h2 id="about-you">О вас</h2>
            </Typography.Text>

            <Field
              label="Как вас подписать в карточке"
              htmlFor="display-name"
              hint="Клиент увидит это имя как исполнителя"
              error={shown('display_name')}
            >
              <Input
                id="display-name"
                value={displayName}
                maxLength={NAME_MAX}
                placeholder="Анна Аксёнова"
                onChange={(event) => setDisplayName(event.currentTarget.value)}
                onBlur={() => markTouched('display_name')}
              />
            </Field>

            <Field label="Ваш статус">
              <div>
                {TAX_MODES.map((mode) => (
                  <ControlRow
                    key={mode}
                    title={TAX_MODE_LABEL[mode]}
                    control={
                      <Radio
                        name="tax-mode"
                        value={mode}
                        checked={taxMode === mode}
                        onChange={() => setTaxMode(mode)}
                      />
                    }
                  />
                ))}
              </div>
            </Field>

            <Field
              label="Реквизиты для перевода"
              htmlFor="payout-details"
              hint="например: СБП +7 900 000-00-00, Т-Банк, получатель Анна А."
              error={shown('payout_details')}
            >
              <Textarea
                id="payout-details"
                mode="secondary"
                rows={2}
                value={payoutDetails}
                maxLength={PAYOUT_MAX}
                onChange={(event) => setPayoutDetails(event.currentTarget.value)}
                onBlur={() => markTouched('payout_details')}
              />
            </Field>

            {payoutEmpty ? (
              <p className="dg-warning">
                <span aria-hidden="true">⚠️</span>
                <span>
                  Без реквизитов клиент не сможет перевести вам деньги — останется только оплата по ссылке
                  {me.config.provider === 'none' ? ', а она на этом сервере пока не подключена' : ''}.
                </span>
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="dg-card" aria-labelledby="deal-terms">
          <Typography.Text variant="title" asChild>
            <h2 id="deal-terms">Условия</h2>
          </Typography.Text>

          <Field label="Шаблон" hint={templateHint ?? 'Шаблон подставит название, предоплату и правило отмены'}>
            <TemplateChips items={templates} value={templateKey} onSelect={applyTemplate} />
          </Field>

          <Field label="Что делаем" htmlFor="deal-title" error={shown('title')}>
            <Input
              id="deal-title"
              value={title}
              maxLength={TITLE_MAX}
              placeholder="Маникюр с покрытием"
              onChange={(event) => setTitle(event.currentTarget.value)}
              onBlur={() => markTouched('title')}
            />
          </Field>

          <Field
            label="Уточнения"
            htmlFor="deal-description"
            hint="Адрес, материалы, что входит в цену — всё, о чём договорились"
            error={shown('description')}
          >
            <Textarea
              id="deal-description"
              mode="secondary"
              rows={3}
              value={description}
              maxLength={DESCRIPTION_MAX}
              onChange={(event) => setDescription(event.currentTarget.value)}
              onBlur={() => markTouched('description')}
            />
          </Field>

          <Field label="Когда" htmlFor="deal-date" error={shown('scheduled_at')}>
            <div className="dg-field">
              <input
                id="deal-date"
                className="dg-datetime"
                type="datetime-local"
                value={scheduledLocal}
                min={minDateValue}
                disabled={noDate}
                onChange={(event) => setScheduledLocal(event.currentTarget.value)}
                onBlur={() => markTouched('scheduled_at')}
              />
              <ControlRow
                title="Без даты"
                subtitle="Срок обсудим отдельно"
                control={
                  <Switch
                    checked={noDate}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setNoDate(on);
                      markTouched('scheduled_at');
                      if (on) setScheduledLocal('');
                    }}
                  />
                }
              />
            </div>
          </Field>

          <Field label="Сумма, ₽" htmlFor="deal-total" error={shown('total')}>
            <Input
              id="deal-total"
              inputMode="numeric"
              autoComplete="off"
              value={totalRaw}
              placeholder="2500"
              onChange={(event) => setTotalRaw(digitsOnly(event.currentTarget.value, 7))}
              onBlur={() => markTouched('total')}
            />
          </Field>

          <Field
            label="Предоплата"
            error={shown('prepayment')}
            hint={
              prepaymentRub !== null && prepaymentRub > 0
                ? `Предоплата ${formatRub(prepaymentRub)}, остаток ${formatRub(Math.max((totalRub ?? 0) - prepaymentRub, 0))}`
                : 'Без предоплаты клиент платит всю сумму после выполнения'
            }
          >
            <Segmented<PrepayMode>
              ariaLabel="Предоплата"
              value={prepayMode}
              onChange={(mode) => {
                setPrepayMode(mode);
                setAutoPercent(null);
                markTouched('prepayment');
              }}
              options={[
                { value: 'none', label: 'Нет' },
                { value: 'p30', label: '30 %' },
                { value: 'p50', label: '50 %' },
                { value: 'custom', label: 'Своя' },
              ]}
            />
          </Field>

          {prepayMode === 'custom' ? (
            <Field label="Сумма предоплаты, ₽" htmlFor="deal-prepayment">
              <Input
                id="deal-prepayment"
                inputMode="numeric"
                autoComplete="off"
                value={prepayCustomValue}
                placeholder="0"
                onChange={(event) => {
                  setAutoPercent(null);
                  setPrepayCustomRaw(digitsOnly(event.currentTarget.value, 7));
                }}
                onBlur={() => markTouched('prepayment')}
              />
            </Field>
          ) : null}

          <Field label="Правило отмены" hint={CANCEL_RULE_TEXT[cancelRule]}>
            <div>
              {CANCEL_RULES.map((rule) => (
                <ControlRow
                  key={rule}
                  title={CANCEL_RULE_LABEL[rule]}
                  control={
                    <Radio
                      name="cancel-rule"
                      value={rule}
                      checked={cancelRule === rule}
                      onChange={() => setCancelRule(rule)}
                    />
                  }
                />
              ))}
            </div>
          </Field>
        </section>

        <Button type="submit" variant="primary" size="large" stretched loading={sending} disabled={sending}>
          Создать карточку
        </Button>

        <Typography.Text variant="description" color="tertiary">
          Карточка появится в вашем чате с ботом — оттуда её можно отправить клиенту ссылкой.
          {me.config.demo ? ' Демо-режим включён: в карточке будет кнопка «Открыть как клиент».' : ''}
          {me.config.provider === 'none' ? ' Оплата по ссылке на этом сервере не подключена (тестовая среда).' : ''}
        </Typography.Text>
      </form>
    </Panel>
  );
}
