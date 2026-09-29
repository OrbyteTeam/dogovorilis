// Форма сделки: SPEC §7.2 (поля и правила), §7.5 (правка условий и повтор), §7.6 (примеры условий);
// вид по DESIGN_BRIEF §5.3. Одна форма на создание, правку (T5) и повтор: режим задаёт заголовок, предзаполнение
// и кнопку, а куда отправлять, решает экран-владелец через onSubmit.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Radio, Switch, Textarea, Typography } from '@maxhub/max-ui';

import { useFormDirty } from '../formGuard';
import { errorText, isRetryable } from '../api';
import { disableClosingConfirmation, enableClosingConfirmation, haptic, userDisplayName } from '../bridge';
import { AppHeader } from '../components/AppHeader';
import { ControlRow } from '../components/ControlRow';
import { Field, revealField } from '../components/Field';
import { Island, Screen } from '../components/Screen';
import { Segmented } from '../components/Segmented';
import { useSnackbar } from '../components/Snackbar';
import { TemplateChips } from '../components/TemplateChips';
import { CANCEL_RULE_LABEL, CANCEL_RULE_TEXT, CANCEL_RULES, formatRub, isoToMoscowInput, moscowInputToIso, TAX_MODE_LABEL, TAX_MODES } from '../format';
import type {
  CancelRule,
  CreateDealRequest,
  DealDetails,
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

/** Порядок полей сверху вниз — к первому с ошибкой форма прокручивает и ставит в него фокус (ЗАДАЧА_04 D1). */
const FIELD_ORDER: FieldName[] = ['display_name', 'payout_details', 'title', 'description', 'scheduled_at', 'total', 'prepayment'];
const anchor = (field: FieldName) => `field-${field}`;
const PREPAY_CUSTOM_ANCHOR = 'field-prepayment-custom';

function digitsOnly(value: string, maxLength: number): string {
  return value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, maxLength);
}

function toInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Режим формы: создание с нуля, правка условий (T5, `#/deals/:id/edit`) или повтор закрытой сделки
 * (`#/new?from=:id`: всё как было, кроме даты).
 */
export type DealFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; source: DealDetails }
  | { kind: 'repeat'; source: DealDetails };

interface FormValues {
  templateKey: TemplateKey | null;
  title: string;
  description: string;
  noDate: boolean;
  scheduledLocal: string;
  totalRaw: string;
  prepayMode: PrepayMode;
  prepayCustomRaw: string;
  cancelRule: CancelRule;
}

/** Предоплата прежней сделки → сегмент: 0 → «Нет», ровно 30 % / 50 % (с округлением вверх) → сегмент, иначе «Своя». */
function prepayFrom(totalRub: number, prepaymentRub: number): Pick<FormValues, 'prepayMode' | 'prepayCustomRaw'> {
  if (prepaymentRub <= 0) return { prepayMode: 'none', prepayCustomRaw: '' };
  if (prepaymentRub === Math.ceil((totalRub * 30) / 100)) return { prepayMode: 'p30', prepayCustomRaw: '' };
  if (prepaymentRub === Math.ceil((totalRub * 50) / 100)) return { prepayMode: 'p50', prepayCustomRaw: '' };
  return { prepayMode: 'custom', prepayCustomRaw: String(prepaymentRub) };
}

function initialValues(me: MeResponse, mode: DealFormMode): FormValues {
  if (mode.kind === 'create') {
    return {
      templateKey: null,
      title: '',
      description: '',
      noDate: true,
      scheduledLocal: '',
      totalRaw: '',
      prepayMode: 'none',
      prepayCustomRaw: '',
      cancelRule: me.profile?.default_cancel_rule ?? 'free_24h',
    };
  }
  const src = mode.source;
  // Повтор — новая встреча: дату не копируем (прежняя почти всегда в прошлом). Была без даты — остаётся «Без даты».
  const keepDate = mode.kind === 'edit' && src.scheduled_at !== null;
  return {
    templateKey: src.template,
    title: src.title,
    description: src.description ?? '',
    noDate: src.scheduled_at === null,
    scheduledLocal: keepDate && src.scheduled_at ? isoToMoscowInput(new Date(src.scheduled_at)) : '',
    totalRaw: String(src.total_rub),
    ...prepayFrom(src.total_rub, src.prepayment_rub),
    cancelRule: src.cancel_rule,
  };
}

export interface NewScreenProps {
  me: MeResponse;
  templates: Template[];
  mode?: DealFormMode;
  /**
   * Отправка. Разрешился: экран-владелец сам решил, что дальше (переход, экран успеха, Snackbar и остаться).
   * Бросил: форма покажет Snackbar, а при сбое сети или сервера с действием «Повторить».
   */
  onSubmit: (payload: CreateDealRequest) => Promise<void>;
}

export function NewScreen({ me, templates, mode = { kind: 'create' }, onSubmit }: NewScreenProps) {
  const snackbar = useSnackbar();
  const editing = mode.kind === 'edit';
  const repeating = mode.kind === 'repeat';
  /** «Тот же клиент» — только при повторе сделки, у которой был настоящий клиент. */
  const sameClientName =
    mode.kind === 'repeat' && mode.source.same_client_available ? (mode.source.client?.name ?? 'прежний клиент') : null;
  // Блок «О вас» — только когда профиля ещё нет (SPEC §7.2) и никогда при правке: сделка уже подписана.
  const needProfile = me.profile === null && !editing;
  const [init] = useState(() => initialValues(me, mode));
  const initTemplate = templates.find((t) => t.key === init.templateKey) ?? null;

  const [displayName, setDisplayName] = useState(() => me.profile?.display_name ?? userDisplayName() ?? '');
  const [taxMode, setTaxMode] = useState<TaxMode>(me.profile?.tax_mode ?? 'npd');
  const [payoutDetails, setPayoutDetails] = useState(me.profile?.payout_details ?? '');

  const [templateKey, setTemplateKey] = useState<TemplateKey | null>(init.templateKey);
  const [templateHint, setTemplateHint] = useState<string | null>(initTemplate?.hint ?? null);
  const [dateRequired, setDateRequired] = useState(initTemplate?.date_required ?? false);
  // Название «из шаблона» — его можно заменить другим шаблоном; своё название пользователя не трогаем.
  const templateTitle = useRef(initTemplate && initTemplate.title === init.title ? init.title : '');

  const [title, setTitle] = useState(init.title);
  const [description, setDescription] = useState(init.description);
  const [noDate, setNoDate] = useState(init.noDate);
  const [scheduledLocal, setScheduledLocal] = useState(init.scheduledLocal);
  const [totalRaw, setTotalRaw] = useState(init.totalRaw);
  const [prepayMode, setPrepayMode] = useState<PrepayMode>(init.prepayMode);
  const [prepayCustomRaw, setPrepayCustomRaw] = useState(init.prepayCustomRaw);
  /** Процент из шаблона, которого нет в сегментах (например 100 %): сумма пересчитывается за «Своя сумма». */
  const [autoPercent, setAutoPercent] = useState<number | null>(null);
  const [cancelRule, setCancelRule] = useState<CancelRule>(init.cancelRule);

  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [sameClient, setSameClient] = useState(sameClientName !== null);
  const dateRef = useRef<HTMLInputElement>(null);

  // Повтор: «Когда» пустое и в фокусе — это единственное, что обычно надо заполнить (ЗАДАЧА_04 F).
  useEffect(() => {
    if (!repeating || init.noDate) return;
    try {
      dateRef.current?.focus();
    } catch {
      /* фокус не обязателен */
    }
  }, [repeating, init.noDate]);

  const minDateValue = useMemo(() => isoToMoscowInput(new Date(Date.now() + LEAD_TIME_MS)), []);

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
        next.display_name = `Имя от ${NAME_MIN} до ${NAME_MAX} символов`;
      }
      if (payoutDetails.trim().length > PAYOUT_MAX) {
        next.payout_details = `Реквизиты не больше ${PAYOUT_MAX} символов`;
      }
    }

    const dealTitle = title.trim();
    if (dealTitle.length < TITLE_MIN || dealTitle.length > TITLE_MAX) {
      next.title = `Название от ${TITLE_MIN} до ${TITLE_MAX} символов`;
    }
    if (description.trim().length > DESCRIPTION_MAX) {
      next.description = `Уточнения не больше ${DESCRIPTION_MAX} символов`;
    }

    if (noDate) {
      if (dateRequired) next.scheduled_at = 'Для этой услуги нужны дата и время';
    } else if (!scheduledLocal) {
      next.scheduled_at = 'Укажите дату и время или выберите «Без даты»';
    } else {
      const iso = moscowInputToIso(scheduledLocal);
      const at = iso ? new Date(iso).getTime() : Number.NaN;
      if (Number.isNaN(at)) next.scheduled_at = 'Укажите дату и время или выберите «Без даты»';
      else if (at < Date.now() + LEAD_TIME_MS - 60_000) next.scheduled_at = 'Дата не раньше чем через 30 минут';
    }

    if (totalRub === null || totalRub < TOTAL_MIN || totalRub > TOTAL_MAX) {
      next.total = 'Сумма от 1 до 1 000 000 ₽';
    }

    if (prepaymentRub === null) {
      next.prepayment = 'Укажите предоплату числом';
    } else if (prepaymentRub < 0 || (totalRub !== null && prepaymentRub > totalRub)) {
      next.prepayment = totalRub === null ? 'Предоплата не больше суммы' : `Предоплата от 0 до ${formatRub(totalRub)}`;
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

  // Снимок условий: при правке «ничего не изменили» проверяем по нему ещё до запроса (сервер ответил бы 409 no_changes).
  const terms = JSON.stringify([title.trim(), description.trim(), noDate ? null : scheduledLocal, totalRaw, prepaymentRub, cancelRule]);
  const [initialTerms] = useState(terms);
  // Подтверждение закрытия, пока в форме есть несохранённые данные (SPEC §7.1): отличие от того, с чего форма началась.
  const draft = JSON.stringify([
    terms,
    templateKey,
    sameClient,
    needProfile ? [displayName.trim(), taxMode, payoutDetails.trim()] : null,
  ]);
  const [initialDraft] = useState(draft);
  const dirty = draft !== initialDraft;

  useEffect(() => {
    if (dirty) enableClosingConfirmation();
    else disableClosingConfirmation();
  }, [dirty]);

  useEffect(() => () => disableClosingConfirmation(), []);
  // Переход по нижней панели с заполненной формы спросит подтверждение (DESIGN_BRIEF §5.2, BottomSheet).
  useFormDirty(dirty && !sending);

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
      snackbar('Проверьте выделенные поля', { tone: 'error' });
      const first = FIELD_ORDER.find((field) => errors[field]);
      // После перерисовки: подсказки с ошибками уже на месте и не сдвинут поле из-под фокуса.
      // Ошибка предоплаты при «Своей сумме» — про поле суммы предоплаты, а не про сегменты.
      const target = first === 'prepayment' && prepayMode === 'custom' ? PREPAY_CUSTOM_ANCHOR : first && anchor(first);
      if (target) window.requestAnimationFrame(() => revealField(target));
      return;
    }
    if (editing && terms === initialTerms) {
      snackbar('Вы ничего не изменили');
      return;
    }
    if (sending) return;

    const trimmedDescription = description.trim();
    const payload: CreateDealRequest = {
      template: templateKey ?? 'free',
      title: title.trim(),
      // Пустые уточнения при правке — явный null: иначе «стереть уточнения» не отличить от «не трогать».
      description: trimmedDescription === '' ? null : trimmedDescription,
      scheduled_at: noDate ? null : moscowInputToIso(scheduledLocal),
      total_rub: totalRub,
      prepayment_rub: prepaymentRub,
      cancel_rule: cancelRule,
    };
    if (needProfile) payload.profile = buildProfile();
    if (mode.kind === 'repeat') {
      payload.repeat_of = mode.source.public_id;
      if (sameClientName !== null) payload.same_client = sameClient;
    }

    setSending(true);
    try {
      await onSubmit(payload);
    } catch (error) {
      haptic('error');
      // Сбой сети или сервера: «Повторить» прямо в Snackbar; ошибка данных чинится в полях, повторять нечего.
      snackbar(errorText(error), { tone: 'error', action: isRetryable(error) ? { label: 'Повторить', onClick: () => void submit() } : undefined });
    } finally {
      setSending(false);
    }
  }

  const payoutEmpty = payoutDetails.trim() === '';

  const screenTitle = mode.kind === 'edit' ? 'Изменить условия' : mode.kind === 'repeat' ? 'Повторить сделку' : 'Новая сделка';
  const subtitle =
    mode.kind === 'edit'
      ? `Сделка #${mode.source.public_id}. Клиент получит новую версию и подтвердит её заново`
      : mode.kind === 'repeat'
        ? `Условия из сделки #${mode.source.public_id}, дата новая`
        : undefined;
  const submitLabel = editing ? 'Отправить новые условия' : sameClientName !== null && sameClient ? 'Создать и отправить клиенту' : 'Создать сделку';

  return (
    <Screen as="form" onSubmit={() => void submit()}>
      <AppHeader title={screenTitle} subtitle={subtitle} />

      {editing ? null : (
        <Island id="deal-service" title="Услуга">
          <Field label="Пример по нише" hint={templateHint ?? 'Пример подставит название, предоплату и правило отмены, дальше их можно поменять'}>
            <TemplateChips items={templates} value={templateKey} onSelect={applyTemplate} />
          </Field>
        </Island>
      )}

      {sameClientName !== null ? (
        <Island id="deal-client" title="Клиент">
          <ControlRow
            title={`Тот же клиент: ${sameClientName}`}
            subtitle={
              sameClient
                ? 'Карточка сразу уйдёт клиенту в чат с ботом, ссылку пересылать не нужно'
                : 'Будет обычная ссылка, отправите её клиенту сами'
            }
            control={<Switch checked={sameClient} onChange={(event) => setSameClient(event.currentTarget.checked)} />}
          />
        </Island>
      ) : null}

      {needProfile ? (
        <Island id="about-you" title="О вас">
          <Field
            label="Как вас подписать в карточке"
            htmlFor="display-name"
            anchorId={anchor('display_name')}
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
                  control={<Radio name="tax-mode" value={mode} checked={taxMode === mode} onChange={() => setTaxMode(mode)} />}
                />
              ))}
            </div>
          </Field>

          <Field
            label="Реквизиты для перевода"
            htmlFor="payout-details"
            anchorId={anchor('payout_details')}
            hint="Например: +7 900 000-00-00, Т-Банк, получатель Анна А."
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
              Без реквизитов клиент не сможет перевести вам деньги, останется только оплата по ссылке
              {me.config.provider === 'none' ? ', а она на этом сервере пока не подключена' : ''}.
            </p>
          ) : null}
        </Island>
      ) : null}

      <Island id="deal-terms" title="Условия">
        <Field label="Что делаем" htmlFor="deal-title" anchorId={anchor('title')} error={shown('title')}>
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
          anchorId={anchor('description')}
          hint="Адрес, материалы, что входит в сумму: всё, о чём договорились"
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

        <Field label="Когда" htmlFor="deal-date" anchorId={anchor('scheduled_at')} hint="Время по Москве (МСК)" error={shown('scheduled_at')}>
          <div className="dg-field">
            <input
              ref={dateRef}
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
              subtitle="Срок обсудите отдельно"
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

        <Field label="Сумма, ₽" htmlFor="deal-total" anchorId={anchor('total')} error={shown('total')}>
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
          anchorId={anchor('prepayment')}
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
              { value: 'p30', label: '30\u00A0%' },
              { value: 'p50', label: '50\u00A0%' },
              { value: 'custom', label: 'Своя' },
            ]}
          />
        </Field>

        {prepayMode === 'custom' ? (
          <Field label="Сумма предоплаты, ₽" htmlFor="deal-prepayment" anchorId={PREPAY_CUSTOM_ANCHOR}>
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
                control={<Radio name="cancel-rule" value={rule} checked={cancelRule === rule} onChange={() => setCancelRule(rule)} />}
              />
            ))}
          </div>
        </Field>
      </Island>

      <div className="dg-actions">
        <Button type="submit" variant="primary" size="large" stretched loading={sending} disabled={sending}>
          {submitLabel}
        </Button>
        <Typography.Label variant="small" className="dg-note dg-note_center">
          {editing
            ? 'Карточка обновится у вас и у клиента, а клиенту придёт перечень изменений'
            : sameClientName !== null && sameClient
              ? `Карточка сразу уйдёт клиенту (${sameClientName}), а вам в чат с ботом`
              : 'Карточка появится в вашем чате с ботом, ссылку на неё вы отправите клиенту'}
          {me.config.provider === 'none' ? '. Оплата по ссылке на этом сервере не подключена (тестовая среда)' : ''}
        </Typography.Label>
      </div>
    </Screen>
  );
}
