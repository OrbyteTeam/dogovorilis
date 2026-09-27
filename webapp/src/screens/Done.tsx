// Экран «Готово» — docs/SPEC.md §7.3 (превью, ссылка, кнопки, шаг «нажмите Начать»), вид — docs/DESIGN.md §4.
// Каждое утверждение на экране опирается на ответ сервера (ЗАДАЧА_04 D1): «карточка уже в чате» — только при card_sent,
// «карточка ушла клиенту» — только при client_card_sent (повтор с тем же клиентом, ЗАДАЧА_04 F), а если экран открыт
// без результата создания (перезагрузка, прямая ссылка) — ничего о доставке не утверждаем.
import { Button, CellSimple, IconButton, Panel, Typography } from '@maxhub/max-ui';

import { botLink, copyToClipboard, haptic, openBot, shareDeal } from '../bridge';
import { useToast } from '../components/Toast';
import { renderCardPreview } from '../format';
import type { CreateDealResponse, MeResponse } from '../types';

function CopyIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="7" y="7" width="9" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13 4.5H6.5A2.5 2.5 0 0 0 4 7v7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export interface DoneScreenProps {
  publicId: string;
  me: MeResponse;
  /** Результат POST /api/deals; null — экран открыт напрямую по ссылке #/done/:id. */
  result: CreateDealResponse | null;
  onNewDeal: () => void;
  onDeals: () => void;
}

export function DoneScreen({ publicId, me, result, onNewDeal, onDeals }: DoneScreenProps) {
  const showToast = useToast();
  const bot = me.config.bot_username;
  const link = result?.link ?? botLink(bot, `d_${publicId}`);
  // Текст приглашения без ссылки — ссылка уходит отдельным параметром (ЗАДАЧА_04 A1).
  const shareText = result?.share_text ?? 'Подтвердите нашу договорённость';
  /** Карточка не дошла до исполнителя: он ещё не нажимал «Начать» в чате с ботом (SPEC §7.3). */
  const needStartBot = result !== null && !result.card_sent;
  /** Повтор с тем же клиентом: карточка уже у клиента — ни ссылка, ни «Отправить клиенту» не нужны. */
  const sentToClient = result?.client_card_sent === true;
  /** Тот же клиент запрошен, но у него нет диалога с ботом — сделка обычная, ссылку отправляет исполнитель. */
  const clientNoDialog = result?.client_no_dialog === true;
  const clientName = result?.client?.name ?? null;

  async function onCopy() {
    const ok = await copyToClipboard(link);
    haptic(ok ? 'success' : 'error');
    showToast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать — выделите ссылку вручную', ok ? 'info' : 'error');
  }

  async function onShare() {
    const outcome = await shareDeal({ text: shareText, link });
    if (outcome === 'unavailable') {
      haptic('error');
      showToast('Не удалось открыть отправку. Скопируйте ссылку и пришлите её клиенту', 'error');
    } else {
      haptic('success');
    }
  }

  function onOpenBot(payload?: string) {
    if (!openBot(bot, payload)) {
      showToast('Не удалось открыть чат с ботом. Скопируйте ссылку и откройте её в MAX', 'error');
    }
  }

  return (
    <Panel mode="secondary" className="dg-root">
      <div className="dg-screen">
        <div className="dg-head">
          <Typography.Text variant="subheader" asChild>
            <h1>{sentToClient ? 'Карточка ушла клиенту' : result ? 'Карточка создана' : `Сделка #${publicId}`}</h1>
          </Typography.Text>
          {sentToClient ? (
            <Typography.Text variant="body" color="secondary">
              {`${clientName ?? 'Клиент'} увидит её в чате с ботом. Ждём подтверждения`}
            </Typography.Text>
          ) : null}
        </div>

        {result ? (
          <section className="dg-card">
            <Typography.Text variant="label" color="tertiary">
              Так её увидит клиент
            </Typography.Text>
            <pre className="dg-preview">{renderCardPreview(result.deal)}</pre>
          </section>
        ) : (
          <section className="dg-card">
            <Typography.Text variant="body" color="secondary">
              Здесь — ссылка для клиента. Статус и кнопки сделки — на её карточке в чате с ботом.
            </Typography.Text>
          </section>
        )}

        {clientNoDialog ? (
          <p className="dg-warning">
            <span aria-hidden="true">⚠️</span>
            <span>{`${clientName ?? 'Клиент'} ещё не начинал(а) диалог с ботом — отправьте ссылку`}</span>
          </p>
        ) : null}

        {sentToClient ? null : (
          <CellSimple
            surface="island"
            overline={`Ссылка для клиента · #${publicId}`}
            title={link}
            after={
              <IconButton variant="secondary" size="small" aria-label="Скопировать ссылку" onClick={() => void onCopy()}>
                <CopyIcon />
              </IconButton>
            }
          />
        )}

        {needStartBot ? (
          <section className="dg-card dg-card_flat">
            <Typography.Text variant="body-strong">
              Откройте чат с ботом и нажмите «Начать» — карточка придёт туда
            </Typography.Text>
            <Typography.Text variant="description" color="secondary">
              Пока вы не начали диалог, бот не может написать вам первым — это ограничение MAX.
            </Typography.Text>
            <Button variant="secondary" size="large" stretched onClick={() => onOpenBot(`d_${publicId}`)}>
              Открыть чат с ботом
            </Button>
          </section>
        ) : null}

        <div className="dg-actions">
          {sentToClient ? null : (
            <Button variant="primary" size="large" stretched onClick={() => void onShare()}>
              Отправить клиенту
            </Button>
          )}
          {/* При needStartBot кнопка чата уже есть в блоке выше — вторую такую же не показываем. */}
          {needStartBot ? null : (
            <Button variant={sentToClient ? 'primary' : 'secondary'} size="large" stretched onClick={() => onOpenBot()}>
              Открыть чат с ботом
            </Button>
          )}
          <Button variant="ghost" size="large" stretched onClick={onDeals}>
            Мои сделки
          </Button>
          <Button variant="ghost" size="large" stretched onClick={onNewDeal}>
            Создать ещё одну
          </Button>
        </div>

        {result?.card_sent ? (
          <Typography.Text variant="description" color="tertiary">
            {sentToClient
              ? 'Ваша карточка — в чате с ботом: там вы увидите, когда клиент подтвердит.'
              : 'Карточка уже в вашем чате с ботом — там вы увидите, когда клиент откроет ссылку.'}
          </Typography.Text>
        ) : null}
      </div>
    </Panel>
  );
}
