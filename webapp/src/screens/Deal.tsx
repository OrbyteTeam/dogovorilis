// Экран сделки `#/deals/:id` (`start_param` `deal_<id>`) — docs/SPEC.md §7.9, контракт ЗАДАЧА_08 B.
// Сверху вниз: заголовок и статус → условия → стороны → деньги → хронология → история версий → документы → действия.
// Действия — ровно кнопки карточки этой роли в чате (`actions` из GET …/full), идут тем же доменным сервисом, что
// кнопки в чате; ответ — свежий DealFull, экран перерисовывается из него. Оплата остаётся в чате: на экране статус
// и «Открыть чат». Необратимое — через лист подтверждения, ввод текста — через лист с полем. Вид — docs/DESIGN.md §4, §5.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Avatar, Button, CellSimple, Panel, Spinner, Textarea, Typography } from '@maxhub/max-ui';

import { api, ApiError, errorText } from '../api';
import { copyToClipboard, haptic, openBot, shareDeal } from '../bridge';
import { Field } from '../components/Field';
import { Segmented } from '../components/Segmented';
import { Sheet } from '../components/Sheet';
import { ErrorScreen, LoadingScreen, NoticeScreen } from '../components/StateScreen';
import { useToast } from '../components/Toast';
import {
  ACTOR_LABEL,
  actionErrorOutcome,
  avatarGradient,
  buttonBehavior,
  checkReceiptFile,
  confirmSheet,
  initials,
  layoutActions,
  RECEIPT_ACCEPT,
  RECEIPT_PDF_LABEL,
  REASON_MAX,
  statusTone,
  TEXT_MAX,
  textSheet,
  validateText,
  type ActionLayout,
  type ButtonKey,
  type ConfirmCode,
  type TextCode,
} from '../deal-screen';
import { formatDateTime, formatKopecks, statusEmoji } from '../format';
import { shortDateTime } from '../schedule';
import type { DealActionRequest, DealFull, DealRole, MeResponse, PostActionCode } from '../types';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** 403 — не участник сделки, 404 — сделки нет (SPEC §7.9). */
  | { kind: 'denied'; reason: 'forbidden' | 'not_found' }
  | { kind: 'ready'; deal: DealFull };

type SheetState = { kind: 'confirm'; code: ConfirmCode } | { kind: 'text'; code: TextCode };

/** Что сейчас выполняется: кнопка «Действий» или «Квитанция PDF в чат» из «Документов». */
type BusyKey = ButtonKey | 'receipt_pdf';

const VIEW_OPTIONS: { value: DealRole; label: string }[] = [
  { value: 'seller', label: 'Я исполнитель' },
  { value: 'client', label: 'Как видит клиент' },
];

const DENIED_TEXT: Record<'forbidden' | 'not_found', { title: string; text: string }> = {
  forbidden: {
    title: 'Это не ваша сделка',
    text: 'Условия и действия видят только исполнитель и клиент этой сделки.',
  },
  not_found: {
    title: 'Сделка не найдена',
    text: 'Проверьте ссылку или откройте сделку из списка.',
  },
};

const CHAT_FAILED = 'Не удалось открыть чат с ботом. Откройте его в MAX вручную';

function failedState(error: unknown): LoadState {
  if (error instanceof ApiError && !error.isAuth) {
    if (error.status === 403) return { kind: 'denied', reason: 'forbidden' };
    if (error.status === 404) return { kind: 'denied', reason: 'not_found' };
  }
  return { kind: 'error', message: errorText(error) };
}

export interface DealScreenProps {
  publicId: string;
  me: MeResponse;
  /** «Изменить условия» → `#/deals/:id/edit` (§7.5). */
  onEdit: (publicId: string) => void;
  /** «Повторить» → `#/new?from=:id` (§7.5). */
  onRepeat: (publicId: string) => void;
  onDeals: () => void;
}

export function DealScreen({ publicId, me, onEdit, onRepeat, onDeals }: DealScreenProps) {
  const showToast = useToast();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  /** Демо: чьими глазами смотреть. undefined — как решит сервер (роль смотрящего); 'client' — `?as=client`. */
  const [viewAs, setViewAs] = useState<DealRole | undefined>(undefined);
  /** Роль, на которую переключаемся, пока идёт перезапрос: сегмент откликается сразу. */
  const [switchingTo, setSwitchingTo] = useState<DealRole | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<BusyKey | null>(null);
  // Состояние обновится только после перерисовки — второй тап в тот же кадр ловит ref (двойное нажатие, DESIGN §5).
  const busyRef = useRef(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (as?: DealRole) => {
      setState({ kind: 'loading' });
      try {
        setState({ kind: 'ready', deal: await api.dealFull(publicId, as) });
      } catch (error) {
        setState(failedState(error));
      }
    },
    [publicId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Перезапрос без экрана загрузки: после 409 и при переключении демо. Ошибка — тостом, экран остаётся.
   * `as` передаётся всегда явно: undefined здесь значит «роль смотрящего», а не «как сейчас».
   */
  async function refresh(as: DealRole | undefined): Promise<boolean> {
    setRefreshing(true);
    try {
      setState({ kind: 'ready', deal: await api.dealFull(publicId, as) });
      return true;
    } catch (error) {
      showToast(errorText(error), 'error');
      return false;
    } finally {
      setRefreshing(false);
    }
  }

  function startBusy(key: BusyKey): boolean {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(key);
    return true;
  }

  function endBusy() {
    busyRef.current = false;
    setBusy(null);
  }

  function openChat() {
    if (!openBot(me.config.bot_username, `d_${publicId}`)) showToast(CHAT_FAILED, 'error');
  }

  async function switchRole(next: DealRole) {
    if (state.kind !== 'ready' || next === state.deal.role || busyRef.current || switchingTo) return;
    haptic('selection');
    const as = next === 'client' ? 'client' : undefined;
    setSwitchingTo(next);
    if (await refresh(as)) setViewAs(as);
    setSwitchingTo(null);
  }

  function handleActionError(error: unknown, hasField: boolean) {
    haptic('error');
    const message = errorText(error);
    const outcome = error instanceof ApiError ? actionErrorOutcome(error, hasField) : 'retry';
    if (outcome === 'field') {
      setFieldError(message);
      return;
    }
    // Сеть, таймаут, 5xx — лист остаётся открытым: текст не теряется, можно нажать ещё раз.
    if (outcome === 'retry') {
      showToast(message, 'error');
      return;
    }
    setSheet(null);
    showToast(message, 'error');
    // Сделка ушла дальше или условия сменились — показываем, какая она теперь (контракт ЗАДАЧА_08 B).
    if (outcome === 'reload') void refresh(viewAs);
  }

  async function runAction(
    deal: DealFull,
    code: PostActionCode,
    extra: Omit<DealActionRequest, 'action' | 'as'> = {},
  ): Promise<void> {
    if (!startBusy(code)) return;
    const hasField = sheet !== null && (sheet.kind === 'text' || confirmSheet(sheet.code, deal.role).reasonField);
    try {
      // `as` — роль, под которой открыт экран: в демо клиентские действия идут от роли клиента, как в чате.
      const response = await api.dealAction(publicId, { action: code, as: deal.role, ...extra });
      setState({ kind: 'ready', deal: response.deal });
      setSheet(null);
      setText('');
      haptic('success');
      showToast(response.notice ?? (response.result === 'already_done' ? 'Уже сделано, экран обновлён' : 'Готово'));
    } catch (error) {
      handleActionError(error, hasField);
    } finally {
      endBusy();
    }
  }

  function openSheet(next: SheetState) {
    setText('');
    setFieldError(null);
    setSheet(next);
  }

  function closeSheet() {
    if (busyRef.current) return;
    setSheet(null);
    setFieldError(null);
  }

  function submitSheet(deal: DealFull) {
    if (!sheet || busyRef.current) return;
    if (sheet.kind === 'text') {
      const error = validateText(text, { max: TEXT_MAX, emptyError: textSheet(sheet.code).emptyError });
      if (error) {
        haptic('error');
        setFieldError(error);
        return;
      }
      void runAction(deal, sheet.code, { text: text.trim() });
      return;
    }
    if (confirmSheet(sheet.code, deal.role).reasonField) {
      const error = validateText(text, { max: REASON_MAX });
      if (error) {
        haptic('error');
        setFieldError(error);
        return;
      }
      const reason = text.trim();
      void runAction(deal, sheet.code, reason ? { reason } : {});
      return;
    }
    void runAction(deal, sheet.code);
  }

  async function share(deal: DealFull) {
    // Текст без ссылки — ссылка уходит отдельным параметром (ЗАДАЧА_04 A1), как на экране «Готово».
    const outcome = await shareDeal({ text: deal.share_text, link: deal.link });
    if (outcome === 'unavailable') {
      haptic('error');
      showToast('Не удалось открыть отправку. Скопируйте ссылку и пришлите её клиенту', 'error');
    } else {
      haptic('success');
    }
  }

  async function copyLink(deal: DealFull) {
    const ok = await copyToClipboard(deal.link);
    haptic(ok ? 'success' : 'error');
    showToast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать. Ссылка — в блоке «Стороны»', ok ? 'info' : 'error');
  }

  function pickFile() {
    const input = fileRef.current;
    if (!input || busyRef.current) return;
    // Сброс — чтобы повторный выбор того же файла после ошибки снова вызвал onChange.
    input.value = '';
    input.click();
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    // Тип и размер — до отправки: 20 МБ по мобильной сети впустую не грузим (контракт ЗАДАЧА_08 B).
    const check = checkReceiptFile(file);
    if (!check.ok) {
      haptic('error');
      showToast(check.error, 'error');
      return;
    }
    if (!startBusy('attach_receipt')) return;
    setUploading(file.name);
    try {
      const response = await api.uploadReceipt(publicId, file, check.contentType);
      setState({ kind: 'ready', deal: response.deal });
      haptic('success');
      showToast(response.notice ?? 'Чек приложен');
    } catch (error) {
      handleActionError(error, false);
    } finally {
      setUploading(null);
      endBusy();
    }
  }

  function onButton(deal: DealFull, key: ButtonKey) {
    if (busyRef.current || refreshing) return;
    const behavior = buttonBehavior(key);
    switch (behavior.kind) {
      case 'post':
        // «Подтверждаю» — с номером версии, которую клиент видит: сменились условия — 409 version_mismatch.
        void runAction(deal, behavior.code, behavior.code === 'confirm' ? { version: deal.terms.version } : {});
        return;
      case 'confirm':
      case 'text':
        openSheet(behavior);
        return;
      case 'edit':
        onEdit(publicId);
        return;
      case 'repeat':
        onRepeat(publicId);
        return;
      case 'file':
        pickFile();
        return;
      case 'share':
        void share(deal);
        return;
      case 'copy':
        void copyLink(deal);
        return;
    }
  }

  /** Лист подтверждения или ввода текста; пока идёт запрос — не закрывается. */
  function renderSheet(current: DealFull, open: SheetState) {
    const sending = busy !== null;
    if (open.kind === 'text') {
      const copy = textSheet(open.code);
      return (
        <Sheet title={copy.title} onClose={closeSheet} locked={sending}>
          <TextField
            id="deal-sheet-text"
            label={copy.label}
            placeholder={copy.placeholder}
            value={text}
            max={TEXT_MAX}
            error={fieldError}
            onChange={(value) => {
              setText(value);
              if (fieldError) setFieldError(null);
            }}
          />
          <div className="dg-actions">
            <Button type="button" variant="primary" size="large" stretched loading={sending} onClick={() => submitSheet(current)}>
              {copy.submitLabel}
            </Button>
            <Button type="button" variant="secondary" size="large" stretched disabled={sending} onClick={closeSheet}>
              Закрыть
            </Button>
          </div>
        </Sheet>
      );
    }
    const copy = confirmSheet(open.code, current.role);
    return (
      <Sheet title={copy.title} onClose={closeSheet} locked={sending}>
        <Typography.Text variant="body" color="secondary">
          {copy.text}
        </Typography.Text>
        {open.code === 'cancel' && current.cancel_consequence ? (
          <p className="dg-warning">
            <span>{current.cancel_consequence}</span>
          </p>
        ) : null}
        {copy.reasonField ? (
          <TextField
            id="deal-sheet-reason"
            label="Причина (необязательно)"
            value={text}
            max={REASON_MAX}
            error={fieldError}
            rows={2}
            onChange={(value) => {
              setText(value);
              if (fieldError) setFieldError(null);
            }}
          />
        ) : null}
        <div className="dg-actions">
          <Button
            type="button"
            variant={copy.destructive ? 'destructive' : 'primary'}
            size="large"
            stretched
            loading={sending}
            onClick={() => submitSheet(current)}
          >
            {copy.confirmLabel}
          </Button>
          <Button type="button" variant="secondary" size="large" stretched disabled={sending} onClick={closeSheet}>
            {copy.dismissLabel}
          </Button>
        </div>
      </Sheet>
    );
  }

  if (state.kind === 'loading') return <LoadingScreen />;

  if (state.kind === 'error') {
    return (
      <ErrorScreen
        message={state.message}
        onRetry={() => void load(viewAs)}
        secondary={{ label: 'Все сделки', onClick: onDeals }}
      />
    );
  }

  if (state.kind === 'denied') {
    const { title, text: body } = DENIED_TEXT[state.reason];
    return <NoticeScreen title={title} text={body} actions={[{ label: 'Все сделки', onClick: onDeals }]} />;
  }

  const deal = state.deal;
  const layout = layoutActions(deal.actions, deal.role);
  const tone = statusTone(deal.status, layout);
  const locked = busy !== null || refreshing;
  const hasAttach = layout.buttons.some((b) => b.key === 'attach_receipt');

  return (
    <Panel mode="secondary" className="dg-root">
      <div className="dg-screen dg-screen_deal">
        {/* 1. Заголовок, #id, бейдж «демо», статус для роли */}
        <header className="dg-head">
          <Typography.Text variant="subheader" asChild>
            <h1>{deal.terms.title}</h1>
          </Typography.Text>
          <div className="dg-deal-id">
            <Typography.Text variant="description" color="tertiary">{`#${deal.public_id}`}</Typography.Text>
            {deal.demo ? <span className="dg-tag">демо</span> : null}
            {refreshing ? <Spinner size={16} appearance="themed" aria-label="Обновляем" /> : null}
          </div>
        </header>

        <p className={`dg-status dg-status_${tone}`}>
          <span aria-hidden="true">{statusEmoji(deal.status)}</span>
          <span>{deal.status_text}</span>
        </p>

        {deal.can_view_as_client ? (
          <Segmented
            options={VIEW_OPTIONS}
            value={switchingTo ?? deal.role}
            onChange={(next) => void switchRole(next)}
            ariaLabel="Чьими глазами смотреть"
          />
        ) : null}

        <TermsSection deal={deal} />
        {/* Действия — сразу под условиями: прочитал условия и действуешь, без прокрутки хронологии (ЗАДАЧА_08 B, прогон удобства).
            Главное — первым, «Отменить сделку» — последней (DESIGN §4, §6); оплата — подсказкой «в чате» над кнопками. */}
        {layout.buttons.length > 0 || layout.payInChat || layout.transferClaimed ? (
          <Section id="deal-actions" title="Действия">
            {layout.payInChat ? (
              <ChatHint text="Оплата — в чате с ботом" sub="Ссылка на оплату и реквизиты — на карточке сделки" onOpenChat={openChat} />
            ) : null}
            {layout.transferClaimed ? <ChatHint text="Клиент сообщил о переводе — подтвердите в чате" onOpenChat={openChat} /> : null}
            <div className="dg-actions">
              {layout.buttons.map((button) => (
                <Button
                  key={button.key}
                  type="button"
                  variant={button.variant}
                  size="large"
                  stretched
                  loading={busy === button.key}
                  disabled={locked && busy !== button.key}
                  onClick={() => onButton(deal, button.key)}
                >
                  {button.label}
                </Button>
              ))}
            </div>
            {uploading ? (
              <div className="dg-upload" role="status">
                <Spinner size={16} appearance="themed" aria-hidden="true" />
                <span>{`Загружаем «${uploading}»…`}</span>
              </div>
            ) : null}
            {hasAttach ? (
              <input ref={fileRef} type="file" accept={RECEIPT_ACCEPT} hidden onChange={(event) => void onFile(event)} />
            ) : null}
          </Section>
        ) : null}

        <PartiesSection deal={deal} />
        <MoneySection deal={deal} />
        <TimelineSection deal={deal} />
        <VersionsSection deal={deal} />
        <DocumentsSection
          deal={deal}
          layout={layout}
          loading={busy === 'receipt_pdf'}
          disabled={locked && busy !== 'receipt_pdf'}
          onReceipt={() => {
            if (!busyRef.current && !refreshing) void runAction(deal, 'receipt_pdf');
          }}
        />

        <footer className="dg-card dg-card_flat dg-card_row">
          <Typography.Text variant="description" color="secondary">
            Карточка сделки — в чате с ботом
          </Typography.Text>
          <Button type="button" variant="secondary" size="small" onClick={openChat}>
            Открыть чат
          </Button>
        </footer>
      </div>

      {sheet ? renderSheet(deal, sheet) : null}
    </Panel>
  );
}

// ─────────────────────────────────────────── блоки экрана ───────────────────────────────────────────

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section className="dg-section" aria-labelledby={id}>
      <div className="dg-section__head">
        <Typography.Text variant="title" asChild>
          <h2 id={id}>{title}</h2>
        </Typography.Text>
        {note ? (
          <Typography.Text variant="description" color="tertiary">
            {note}
          </Typography.Text>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Money({ kopecks }: { kopecks: number }) {
  return <span className="dg-num">{formatKopecks(kopecks)}</span>;
}

/** 2. Условия текущей версии. Время — по Москве с меткой «(МСК)» (SPEC §7.1). */
function TermsSection({ deal }: { deal: DealFull }) {
  const t = deal.terms;
  const rows: { label: string; value: ReactNode }[] = [
    { label: 'Когда', value: t.scheduled_at ? formatDateTime(t.scheduled_at) : 'Без даты' },
    { label: 'Сумма', value: <Money kopecks={t.total_kopecks} /> },
    { label: 'Предоплата', value: t.prepayment_kopecks > 0 ? <Money kopecks={t.prepayment_kopecks} /> : 'Без предоплаты' },
  ];
  if (t.prepayment_kopecks > 0) rows.push({ label: 'Остаток', value: <Money kopecks={t.remaining_kopecks} /> });
  rows.push({ label: 'Правило отмены', value: t.cancel_rule_text });
  if (t.description?.trim()) rows.push({ label: 'Уточнения', value: t.description.trim() });
  if (t.confirmed_at) rows.push({ label: 'Клиент подтвердил', value: formatDateTime(t.confirmed_at) });
  return (
    <Section id="deal-terms" title="Условия" note={t.version > 1 ? `Версия ${t.version}` : undefined}>
      <div className="dg-island">
        {rows.map((row) => (
          <CellSimple key={row.label} height="compact" overline={row.label} title={row.value} />
        ))}
      </div>
    </Section>
  );
}

function PartyAvatar({ name }: { name: string | null }) {
  if (!name) {
    return (
      <span className="dg-avatar-empty" aria-hidden="true">
        ?
      </span>
    );
  }
  return (
    <Avatar.Container size={40} aria-hidden="true">
      <Avatar.Text gradient={avatarGradient(name)}>{initials(name) || '?'}</Avatar.Text>
    </Avatar.Container>
  );
}

/** 3. Стороны. Клиента ещё нет — исполнителю здесь же ссылка для него (её можно выделить, если копирование не сработало). */
function PartiesSection({ deal }: { deal: DealFull }) {
  const you = (role: DealRole) => (deal.role === role ? 'Это вы' : undefined);
  return (
    <Section id="deal-parties" title="Стороны">
      <div className="dg-island">
        <CellSimple
          height="compact"
          before={<PartyAvatar name={deal.seller.name} />}
          overline="Исполнитель"
          title={deal.seller.name}
          subtitle={you('seller')}
        />
        <CellSimple
          height="compact"
          before={<PartyAvatar name={deal.client?.name ?? null} />}
          overline="Клиент"
          title={deal.client ? deal.client.name : 'Ещё не открыл ссылку'}
          subtitle={deal.client ? you('client') : deal.role === 'seller' ? <span className="dg-break">{deal.link}</span> : undefined}
        />
      </div>
    </Section>
  );
}

function ChatHint({ text, sub, onOpenChat }: { text: string; sub?: string; onOpenChat: () => void }) {
  return (
    <div className="dg-card dg-card_flat dg-card_row">
      <div className="dg-hint-text">
        <Typography.Text variant="body-strong">{text}</Typography.Text>
        {sub ? (
          <Typography.Text variant="description" color="secondary">
            {sub}
          </Typography.Text>
        ) : null}
      </div>
      <Button type="button" variant="primary" size="small" onClick={onOpenChat}>
        Открыть чат
      </Button>
    </div>
  );
}

/** 4. Деньги: оплачено, сколько ждём, платежи. Кнопок оплаты нет — оплата в карточке в чате (SPEC §7.9). */
function MoneySection({ deal }: { deal: DealFull }) {
  const { money } = deal;
  return (
    <Section id="deal-money" title="Деньги" note={money.payments.some((p) => p.at) ? 'время — МСК' : undefined}>
      <div className="dg-island">
        <CellSimple
          height="compact"
          overline="Оплачено"
          title={
            <>
              <Money kopecks={money.paid_kopecks} />
              {' из '}
              <Money kopecks={deal.terms.total_kopecks} />
            </>
          }
        />
        {money.due_kopecks > 0 ? (
          <CellSimple height="compact" overline="Ждём сейчас" title={<Money kopecks={money.due_kopecks} />} />
        ) : null}
        {money.payments.map((payment, index) => (
          <CellSimple
            key={`${payment.kind}-${index}`}
            height="compact"
            title={payment.label}
            subtitle={payment.at ? shortDateTime(payment.at) : undefined}
          />
        ))}
        {money.payments.length === 0 ? <p className="dg-island__note">Платежей пока нет</p> : null}
      </div>
    </Section>
  );
}

/** 5. Хронология: время (МСК), кто, что — от старых к новым; тексты готовит сервер. */
function TimelineSection({ deal }: { deal: DealFull }) {
  if (deal.timeline.length === 0) return null;
  return (
    <Section id="deal-timeline" title="Хронология" note="время — МСК">
      <ol className="dg-timeline">
        {deal.timeline.map((item, index) => (
          <li key={`${item.at}-${index}`} className="dg-timeline__item">
            <span className="dg-timeline__meta">{`${shortDateTime(item.at)} · ${ACTOR_LABEL[item.actor]}`}</span>
            <span className="dg-timeline__text">{item.text}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/** 6. История версий — только если версий больше одной. */
function VersionsSection({ deal }: { deal: DealFull }) {
  if (deal.versions.length <= 1) return null;
  return (
    <Section id="deal-versions" title="История версий" note="время — МСК">
      <div className="dg-island">
        {deal.versions.map((v) => {
          const when = v.scheduled_at ? shortDateTime(v.scheduled_at) : 'без даты';
          const prepay = v.prepayment_kopecks > 0 ? `предоплата ${formatKopecks(v.prepayment_kopecks)}` : 'без предоплаты';
          return (
            <div key={v.version} className="dg-version">
              <div className="dg-version__head">
                <span className="dg-version__title">{`Версия ${v.version}`}</span>
                {v.version === deal.terms.version ? <span className="dg-tag">текущая</span> : null}
                <span className="dg-version__date">{shortDateTime(v.created_at)}</span>
              </div>
              {v.change_request_text ? (
                <p className="dg-version__request">{`Клиент просил: «${v.change_request_text}»`}</p>
              ) : null}
              {v.title !== deal.terms.title ? <p className="dg-version__line">{v.title}</p> : null}
              <p className="dg-version__line dg-num">{`${when} · ${formatKopecks(v.total_kopecks)} · ${prepay}`}</p>
              <p className="dg-version__line">
                {v.confirmed_at ? `Клиент подтвердил ${shortDateTime(v.confirmed_at)}` : 'Клиент не подтверждал'}
              </p>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

interface DocumentsSectionProps {
  deal: DealFull;
  layout: ActionLayout;
  loading: boolean;
  disabled: boolean;
  onReceipt: () => void;
}

/**
 * 7. Документы. Квитанция PDF уходит в чат с ботом (действие `receipt_pdf`): скачать файл с заголовком авторизации
 * WebView не умеет (SPEC §7.9). Строка чека — готовый текст сервера.
 */
function DocumentsSection({ deal, layout, loading, disabled, onReceipt }: DocumentsSectionProps) {
  const pdfNote = layout.receiptPdf
    ? 'Пришлём файлом в чат с ботом'
    : deal.documents.receipt_pdf
      ? 'Готова'
      : 'Будет, когда сделка завершится';
  return (
    <Section id="deal-documents" title="Документы">
      <div className="dg-island">
        <CellSimple height="compact" title="Квитанция PDF" subtitle={pdfNote} />
        {deal.documents.cheque_text ? <CellSimple height="compact" title={deal.documents.cheque_text} /> : null}
      </div>
      {layout.receiptPdf ? (
        <Button type="button" variant="secondary" size="large" stretched loading={loading} disabled={disabled} onClick={onReceipt}>
          {RECEIPT_PDF_LABEL}
        </Button>
      ) : null}
    </Section>
  );
}

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  max: number;
  error: string | null;
  placeholder?: string;
  rows?: number;
  onChange: (value: string) => void;
}

/** Textarea MAX UI; под ней в одну строку — ошибка у поля слева и счётчик «N/500» справа (DESIGN §4, §5). */
function TextField({ id, label, value, max, error, placeholder, rows = 4, onChange }: TextFieldProps) {
  const errorId = `${id}-error`;
  return (
    <Field label={label} htmlFor={id}>
      <Textarea
        id={id}
        mode="secondary"
        rows={rows}
        value={value}
        maxLength={max}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <div className="dg-field__meta">
        {error ? (
          <span className="dg-field__hint dg-field__hint_error" id={errorId} role="alert">
            {error}
          </span>
        ) : (
          <span />
        )}
        <span className={value.trim().length > max ? 'dg-counter dg-counter_over' : 'dg-counter'} aria-hidden="true">
          {`${value.length}/${max}`}
        </span>
      </div>
    </Field>
  );
}
