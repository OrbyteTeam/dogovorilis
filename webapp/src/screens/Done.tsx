// Экран «Готово» — docs/SPEC.md §7.3 (превью, ссылка, кнопки, шаг «нажмите Начать»), вид — docs/DESIGN.md §4.
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
}

export function DoneScreen({ publicId, me, result, onNewDeal }: DoneScreenProps) {
  const showToast = useToast();
  const bot = me.config.bot_username;
  const link = result?.link ?? botLink(bot, `d_${publicId}`);
  // Текст приглашения без ссылки — ссылка уходит отдельным параметром (ЗАДАЧА_04 A1).
  const shareText = result?.share_text ?? 'Подтвердите нашу договорённость';

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
        <Typography.Text variant="subheader" asChild>
          <h1>Карточка создана</h1>
        </Typography.Text>

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
              Подробности этой сделки — в вашем чате с ботом: карточка там обновляется сама. Здесь остаётся ссылка для
              клиента.
            </Typography.Text>
          </section>
        )}

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

        {result && !result.card_sent ? (
          <section className="dg-card dg-card_flat">
            <Typography.Text variant="body-strong">
              Откройте чат с ботом и нажмите «Начать» — карточка придёт туда
            </Typography.Text>
            <Typography.Text variant="description" color="secondary">
              Пока вы не начали диалог, бот не может написать вам первым — это ограничение MAX.
            </Typography.Text>
            <Button variant="primary" size="large" stretched onClick={() => onOpenBot(`d_${publicId}`)}>
              Открыть чат с ботом
            </Button>
          </section>
        ) : null}

        <div className="dg-actions">
          <Button variant="primary" size="large" stretched onClick={() => void onShare()}>
            Отправить клиенту
          </Button>
          <Button variant="secondary" size="large" stretched onClick={() => onOpenBot()}>
            Открыть в чате с ботом
          </Button>
          <Button variant="ghost" size="large" stretched onClick={onNewDeal}>
            Создать ещё одну
          </Button>
        </div>

        {result && !result.card_sent ? null : (
          <Typography.Text variant="description" color="tertiary">
            Карточка уже в вашем чате с ботом — там вы увидите, когда клиент откроет ссылку.
          </Typography.Text>
        )}
      </div>
    </Panel>
  );
}
