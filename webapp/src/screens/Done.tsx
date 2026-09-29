// Экран «Готово» (DESIGN_BRIEF §5.3, SPEC §7.3): сделка создана, превью карточки так, как её увидит клиент, ссылка и
// отправка клиенту. Каждое утверждение опирается на ответ сервера (ЗАДАЧА_04 D1): «карточка уже в чате» только при
// card_sent, «карточка ушла клиенту» только при client_card_sent. Открыт по прямой ссылке без результата создания:
// условия подгружаются из GET /api/deals/:id, о доставке экран ничего не утверждает.
import { useCallback, useEffect, useState } from 'react';
import { Button, CellSimple, Typography } from '@maxhub/max-ui';

import { api, ApiError, errorText } from '../api';
import { botLink, copyToClipboard, haptic, openBot, shareDeal } from '../bridge';
import { AppHeader } from '../components/AppHeader';
import { Island, Screen } from '../components/Screen';
import { useSnackbar } from '../components/Snackbar';
import { ErrorState, NoticeState, Skeleton } from '../components/States';
import { StatusBadge } from '../components/StatusBadge';
import { renderCardPreview, statusShort, type CardPreviewInput } from '../format';
import type { CreateDealResponse, DealDetails, MeResponse } from '../types';

export interface DoneScreenProps {
  publicId: string;
  me: MeResponse;
  /** Результат POST /api/deals; null: экран открыт по ссылке #/done/:id или start_param d_<id>. */
  result: CreateDealResponse | null;
  onDeals: () => void;
  /** «К сделке»: экран сделки `#/deals/:id` (SPEC §7.3, §7.9, ЗАДАЧА_08 B). */
  onOpenDeal: () => void;
}

type Loaded =
  | { kind: 'result'; preview: CardPreviewInput; status: DealDetails['status'] }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'forbidden' }
  | { kind: 'details'; preview: CardPreviewInput; details: DealDetails };

function fromResult(result: CreateDealResponse): CardPreviewInput {
  const d = result.deal;
  return {
    publicId: d.public_id,
    status: d.status,
    // Только что созданная сделка: клиент увидит «подтвердите условия».
    statusText: 'Подтвердите условия',
    title: d.version.title,
    description: d.version.description,
    scheduledAt: d.version.scheduled_at,
    totalKopecks: d.version.total_kopecks,
    prepaymentKopecks: d.version.prepayment_kopecks,
    cancelRule: d.version.cancel_rule,
    sellerName: d.seller.name,
    clientName: d.client?.name ?? null,
    demo: d.demo,
  };
}

function fromDetails(d: DealDetails, sellerName: string): CardPreviewInput {
  return {
    publicId: d.public_id,
    status: d.status,
    statusText: statusShort(d.status, 'client'),
    title: d.title,
    description: d.description,
    scheduledAt: d.scheduled_at,
    totalKopecks: d.total_rub * 100,
    prepaymentKopecks: d.prepayment_rub * 100,
    cancelRule: d.cancel_rule,
    sellerName,
    clientName: d.client?.name ?? null,
    demo: d.demo,
  };
}

export function DoneScreen({ publicId, me, result, onDeals, onOpenDeal }: DoneScreenProps) {
  const snackbar = useSnackbar();
  const bot = me.config.bot_username;
  const link = result?.link ?? botLink(bot, `d_${publicId}`);
  const sellerName = me.profile?.display_name ?? me.user.first_name;
  const [loaded, setLoaded] = useState<Loaded>(() =>
    result ? { kind: 'result', preview: fromResult(result), status: result.deal.status } : { kind: 'loading' },
  );

  const load = useCallback(async () => {
    if (result) return;
    setLoaded({ kind: 'loading' });
    try {
      const details = await api.deal(publicId);
      setLoaded({ kind: 'details', details, preview: fromDetails(details, sellerName) });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        setLoaded({ kind: 'forbidden' });
        return;
      }
      setLoaded({ kind: 'error', message: errorText(error) });
    }
  }, [publicId, result, sellerName]);

  useEffect(() => {
    void load();
  }, [load]);

  // Текст приглашения без ссылки: ссылка уходит отдельным параметром (ЗАДАЧА_04 A1).
  const shareText = result?.share_text ?? 'Подтвердите условия';
  /** Карточка не дошла до исполнителя: он ещё не нажимал «Начать» в чате с ботом (SPEC §7.3). */
  const needStartBot = result !== null && !result.card_sent;
  /** Повтор с тем же клиентом: карточка уже у клиента, ни ссылка, ни «Отправить клиенту» не нужны. */
  const sentToClient = result?.client_card_sent === true;
  /** Тот же клиент запрошен, но у него нет диалога с ботом: сделка обычная, ссылку отправляет исполнитель. */
  const clientNoDialog = result?.client_no_dialog === true;
  const clientName = result?.client?.name ?? null;

  async function onCopy() {
    const ok = await copyToClipboard(link);
    haptic(ok ? 'success' : 'error');
    snackbar(ok ? 'Ссылка скопирована' : 'Не удалось скопировать. Выделите ссылку вручную', { tone: ok ? 'success' : 'error' });
  }

  async function onShare() {
    const outcome = await shareDeal({ text: shareText, link });
    if (outcome === 'unavailable') {
      haptic('error');
      snackbar('Не удалось открыть отправку. Скопируйте ссылку и пришлите её клиенту', { tone: 'error', action: { label: 'Скопировать', onClick: () => void onCopy() } });
    } else {
      haptic('success');
    }
  }

  function onOpenBot(payload?: string) {
    if (!openBot(bot, payload)) {
      snackbar('Не удалось открыть чат с ботом. Скопируйте ссылку и откройте её в MAX', { tone: 'error' });
    }
  }

  const title = sentToClient ? 'Карточка ушла клиенту' : result ? 'Сделка создана' : `Сделка #${publicId}`;

  if (loaded.kind === 'loading') {
    return (
      <Screen>
        <AppHeader title={title} />
        <Skeleton kind="card" />
      </Screen>
    );
  }
  if (loaded.kind === 'error') {
    return (
      <Screen>
        <AppHeader title={title} />
        <ErrorState title="Не удалось загрузить сделку" text={loaded.message} onRetry={() => void load()} secondary={{ label: 'Все сделки', onClick: onDeals }} />
      </Screen>
    );
  }
  if (loaded.kind === 'forbidden' || (loaded.kind === 'details' && loaded.details.role !== 'seller')) {
    const client = loaded.kind === 'details';
    return (
      <Screen>
        <AppHeader title={title} />
        <NoticeState
          tone="locked"
          title={client ? 'Эту сделку вам предложили' : 'Это не ваша сделка'}
          text={client ? 'Подтвердите условия на карточке в чате с ботом' : 'Ссылку на сделку может отправить только её исполнитель'}
          actions={client ? [{ label: 'Открыть чат с ботом', onClick: () => onOpenBot(`d_${publicId}`) }, { label: 'Все сделки', onClick: onDeals }] : [{ label: 'Все сделки', onClick: onDeals }]}
        />
      </Screen>
    );
  }

  const preview = loaded.preview;
  const status = loaded.kind === 'result' ? loaded.status : loaded.details.status;

  return (
    <Screen>
      <AppHeader
        title={title}
        subtitle={sentToClient ? `${clientName ?? 'Клиент'} увидит её в чате с ботом. Ждём подтверждения` : result ? `#${publicId}` : undefined}
      />
      <div>
        <StatusBadge status={status} role="seller" text={statusShort(status, 'seller')} />
      </div>

      <Island id="done-preview" title="Так её увидит клиент">
        <pre className="dg-preview">{renderCardPreview(preview)}</pre>
      </Island>

      {clientNoDialog ? (
        <p className="dg-warning" role="note">
          {`${clientName ?? 'Клиент'} ещё не начинал(а) диалог с ботом, поэтому отправьте ссылку сами`}
        </p>
      ) : null}

      {sentToClient ? null : (
        <CellSimple
          surface="island"
          overline="Ссылка для клиента"
          title={<span className="dg-link">{link}</span>}
          after={
            <Button type="button" variant="secondary" size="small" onClick={() => void onCopy()}>
              Скопировать
            </Button>
          }
        />
      )}

      {needStartBot ? (
        <Island flat>
          <Typography.Body variant="medium-strong">Откройте чат с ботом и нажмите «Начать»: карточка придёт туда</Typography.Body>
          <Typography.Label variant="small" className="dg-note">
            Пока вы не начали диалог, бот не может написать вам первым. Так устроен MAX.
          </Typography.Label>
          <Button variant="secondary" size="large" stretched onClick={() => onOpenBot(`d_${publicId}`)}>
            Открыть чат с ботом
          </Button>
        </Island>
      ) : null}

      <div className="dg-actions">
        {sentToClient ? null : (
          <Button variant="primary" size="large" stretched onClick={() => void onShare()}>
            Отправить клиенту
          </Button>
        )}
        {/* При needStartBot кнопка чата уже есть в блоке выше, вторую такую же не показываем. */}
        {needStartBot ? null : (
          <Button variant={sentToClient ? 'primary' : 'secondary'} size="large" stretched onClick={() => onOpenBot()}>
            Открыть чат с ботом
          </Button>
        )}
        <Button variant="secondary" size="large" stretched onClick={onOpenDeal}>
          К сделке
        </Button>
        <Button variant="ghost" size="large" stretched onClick={onDeals}>
          Все сделки
        </Button>
      </div>

      {result?.card_sent ? (
        <Typography.Label variant="small" className="dg-note dg-note_center">
          {sentToClient
            ? 'Ваша карточка в чате с ботом, там вы увидите, когда клиент подтвердит'
            : 'Карточка уже в вашем чате с ботом, там вы увидите, когда клиент откроет ссылку'}
        </Typography.Label>
      ) : null}
    </Screen>
  );
}
