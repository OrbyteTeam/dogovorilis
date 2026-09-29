// Экран «Настройки» (DESIGN_BRIEF §5.3, SPEC §7.7): о вас, как принимаете деньги, правило отмены по умолчанию,
// утренняя сводка. «Мои услуги» и «Надёжность» появятся в ЗАДАЧА_08; телефон вместе с POST /api/me/phone.
import { useMemo, useState } from 'react';
import { Button, Input, Radio, Switch, Textarea, Typography } from '@maxhub/max-ui';

import { useFormDirty } from '../formGuard';
import { api, errorText } from '../api';
import { AppHeader } from '../components/AppHeader';
import { ControlRow } from '../components/ControlRow';
import { Field, revealField } from '../components/Field';
import { Island, Screen } from '../components/Screen';
import { useSnackbar } from '../components/Snackbar';
import {
  CANCEL_RULE_LABEL,
  CANCEL_RULES,
  DIGEST_DEFAULT_MINUTES,
  DIGEST_TIMES,
  formatMinutes,
  TAX_MODE_LABEL,
  TAX_MODES,
} from '../format';
import { haptic } from '../bridge';
import type { CancelRule, MeResponse, SellerProfile, TaxMode } from '../types';

const NAME_MIN = 2;
const NAME_MAX = 40;
const PAYOUT_MAX = 200;
/** Значение пункта «Выключено» в выпадающем списке сводки. */
const DIGEST_OFF = 'off';

/** undefined: профиля нет или сервер ещё не отдаёт поле; значение вне сетки тоже по умолчанию (08:00). */
function initialDigestTime(profile: SellerProfile | null): number | null {
  const value = profile?.digest_time;
  if (value === null) return null;
  return value !== undefined && DIGEST_TIMES.includes(value) ? value : DIGEST_DEFAULT_MINUTES;
}

export interface SettingsScreenProps {
  me: MeResponse;
  /** Профиль сохранён: каркас кладёт его в `me`, чтобы форма сделки увидела свежие значения. */
  onSaved: (profile: SellerProfile) => void;
}

export function SettingsScreen({ me, onSaved }: SettingsScreenProps) {
  const snackbar = useSnackbar();
  const profile = me.profile;
  const providerOff = me.config.provider === 'none';

  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [taxMode, setTaxMode] = useState<TaxMode>(profile?.tax_mode ?? 'npd');
  const [payoutDetails, setPayoutDetails] = useState(profile?.payout_details ?? '');
  const [cancelRule, setCancelRule] = useState<CancelRule>(profile?.default_cancel_rule ?? 'free_24h');
  const [transferEnabled, setTransferEnabled] = useState(profile?.transfer_enabled ?? true);
  const [linkEnabled, setLinkEnabled] = useState(providerOff ? false : (profile?.link_enabled ?? true));
  const [digestTime, setDigestTime] = useState<number | null>(() => initialDigestTime(profile));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  const payoutEmpty = payoutDetails.trim() === '';

  const errors = useMemo(() => {
    const next: { display_name?: string; payout_details?: string } = {};
    const name = displayName.trim();
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      next.display_name = `Имя от ${NAME_MIN} до ${NAME_MAX} символов`;
    }
    if (payoutDetails.trim().length > PAYOUT_MAX) {
      next.payout_details = `Реквизиты не больше ${PAYOUT_MAX} символов`;
    }
    return next;
  }, [displayName, payoutDetails]);

  // Переводы без реквизитов невозможны: переключатель следует за полем, а не спорит с ним.
  const transferOn = transferEnabled && !payoutEmpty;

  // Несохранённые изменения: переход по нижней панели спросит подтверждение (DESIGN_BRIEF §5.2).
  const snapshot = JSON.stringify([displayName.trim(), taxMode, payoutDetails.trim(), cancelRule, transferOn, linkEnabled, digestTime]);
  const [saved, setSaved] = useState(snapshot);
  useFormDirty(snapshot !== saved && !saving);

  async function save() {
    setSubmitted(true);
    if (Object.keys(errors).length > 0) {
      haptic('error');
      snackbar('Проверьте выделенные поля', { tone: 'error' });
      const first = errors.display_name ? 'settings-field-name' : 'settings-field-payout';
      window.requestAnimationFrame(() => revealField(first));
      return;
    }
    if (saving) return;

    const body: SellerProfile = {
      display_name: displayName.trim(),
      tax_mode: taxMode,
      payout_details: payoutEmpty ? null : payoutDetails.trim(),
      transfer_enabled: transferOn,
      link_enabled: providerOff ? false : linkEnabled,
      default_cancel_rule: cancelRule,
      digest_time: digestTime,
    };

    setSaving(true);
    try {
      const response = await api.saveProfile(body);
      haptic('success');
      setSaved(snapshot);
      snackbar('Сохранено', { tone: 'success' });
      onSaved(response.profile);
    } catch (e) {
      haptic('error');
      snackbar(errorText(e), { tone: 'error', action: { label: 'Повторить', onClick: () => void save() } });
    } finally {
      setSaving(false);
    }
  }

  const shown = (field: 'display_name' | 'payout_details') => (submitted ? (errors[field] ?? null) : null);

  return (
    <Screen as="form" onSubmit={() => void save()}>
      <AppHeader title="Настройки" />

      <Island id="settings-profile" title="О вас">
        <Field
          label="Как вас подписать в карточке"
          htmlFor="settings-name"
          anchorId="settings-field-name"
          hint="Клиент увидит это имя как исполнителя"
          error={shown('display_name')}
        >
          <Input
            id="settings-name"
            value={displayName}
            maxLength={NAME_MAX}
            placeholder="Анна Аксёнова"
            onChange={(event) => setDisplayName(event.currentTarget.value)}
          />
        </Field>

        <Field label="Ваш статус">
          {TAX_MODES.map((mode) => (
            <ControlRow
              key={mode}
              control={<Radio name="settings-tax" value={mode} checked={taxMode === mode} onChange={() => setTaxMode(mode)} />}
              title={TAX_MODE_LABEL[mode]}
            />
          ))}
        </Field>

        <Field
          label="Реквизиты для перевода"
          htmlFor="settings-payout"
          anchorId="settings-field-payout"
          hint="Например: +7 900 000-00-00, Т-Банк, получатель Анна А."
          error={shown('payout_details')}
        >
          <Textarea
            id="settings-payout"
            mode="secondary"
            rows={2}
            value={payoutDetails}
            maxLength={PAYOUT_MAX}
            onChange={(event) => setPayoutDetails(event.currentTarget.value)}
          />
        </Field>
      </Island>

      <Island id="settings-payments" title="Как принимаете деньги">
        <ControlRow
          control={<Switch checked={transferOn} disabled={payoutEmpty} onChange={(event) => setTransferEnabled(event.currentTarget.checked)} />}
          title="Переводы по реквизитам"
          subtitle={payoutEmpty ? 'Заполните реквизиты выше, без них переводить некуда' : 'Клиент увидит ваши реквизиты и переведёт сам'}
        />
        <ControlRow
          control={
            <Switch checked={providerOff ? false : linkEnabled} disabled={providerOff} onChange={(event) => setLinkEnabled(event.currentTarget.checked)} />
          }
          title="Оплата по ссылке"
          subtitle={
            providerOff
              ? 'Не подключена на этом сервере'
              : '🧪 Тестовый магазин: клиент платит картой по ссылке, реальные деньги не списываются'
          }
        />
      </Island>

      <Island id="settings-cancel" title="Правило отмены по умолчанию">
        {CANCEL_RULES.map((rule) => (
          <ControlRow
            key={rule}
            control={<Radio name="settings-cancel-rule" value={rule} checked={cancelRule === rule} onChange={() => setCancelRule(rule)} />}
            title={CANCEL_RULE_LABEL[rule]}
          />
        ))}
        <Typography.Label variant="small" className="dg-note">
          Подставляется в новую сделку; в самой сделке правило можно поменять.
        </Typography.Label>
      </Island>

      <Island id="settings-digest" title="Утренняя сводка">
        <Field label="Когда присылать" htmlFor="settings-digest-time" hint="Каждое утро список сделок на сегодня, если они есть. Время МСК">
          <div className="dg-select">
            <select
              id="settings-digest-time"
              className="dg-select__control"
              value={digestTime === null ? DIGEST_OFF : String(digestTime)}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDigestTime(value === DIGEST_OFF ? null : Number(value));
              }}
            >
              <option value={DIGEST_OFF}>Выключено</option>
              {DIGEST_TIMES.map((minutes) => (
                <option key={minutes} value={String(minutes)}>
                  {`${formatMinutes(minutes)} (МСК)`}
                </option>
              ))}
            </select>
          </div>
        </Field>
      </Island>

      <div className="dg-actions">
        <Button type="submit" variant="primary" size="large" stretched loading={saving}>
          Сохранить
        </Button>
      </div>
    </Screen>
  );
}
