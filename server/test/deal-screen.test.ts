// Экран сделки в мини-приложении (ЗАДАЧА_08 B, SPEC §7.9): GET /full, POST /actions, POST /receipt.
// Главное: действия экрана — ровно кнопки карточки, и выполняются они тем же путём, что кнопки в чате.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as texts from '../src/texts.js';
import { cardKeyboard } from '../src/transport/bot/keyboards.js';
import { actionOfButton, actionsFromKeyboard, timelineView, type ActionCode } from '../src/transport/http/deal-full.js';
import { chequeFileName, chequeUploadName } from '../src/transport/http/routes/deal-screen.js';
import type { CardRole, DealBundle, DealEvent, DealStatus, Payment } from '../src/types.js';
import { cardMid, createHarness, dealStatus, livePaymentId, truncateAll, type Harness } from './helpers/harness.js';

const DB = process.env.TEST_DATABASE_URL;
const SELLER = 4801;
const SELLER_CHAT = 7801;
const CLIENT = 4802;
const CLIENT_CHAT = 7802;
const STRANGER = 4803;
const TIMEOUT = 180_000;

// ─────────────────────────── без БД: действия = кнопки карточки ───────────────────────────

const ID = 'Qw3kZ9x1Rt';
type Over = { client?: boolean; demo?: boolean; payments?: Partial<Payment>[]; refundExpected?: boolean };

function bundle(status: DealStatus, over: Over = {}): DealBundle {
  const at = new Date('2026-09-20T09:00:00Z');
  const user = (id: number) => ({ maxUserId: id, firstName: `U${id}`, lastName: null, username: null, dialogChatId: id, locale: null, phone: null, phoneVerifiedAt: null });
  const payments = (over.payments ?? []).map(
    (p, i) =>
      ({
        id: i + 1, dealId: 1, kind: 'prepayment', rail: 'transfer', provider: 'manual', status: 'pending', amountKopecks: 50_000,
        idempotenceKey: 'k', providerPaymentId: null, providerStatus: null, confirmationUrl: null, qrPayload: null,
        cancellationReason: null, claimedAt: null, succeededAt: null, canceledAt: null, expiresAt: null, createdAt: at, updatedAt: at,
        ...p,
      }) as Payment,
  );
  return {
    deal: {
      id: 1, publicId: ID, sellerUserId: 1, clientUserId: over.client ? 2 : null, demo: over.demo ?? false, template: 'beauty',
      currentVersion: 1, status, statusChangedAt: at, clientJoinedAt: null, confirmedAt: null, doneAt: null, acceptedAt: null,
      paidAt: null, closedAt: null, cancelledAt: null, cancelledByRole: null, cancelReason: null,
      cancelRefundExpected: over.refundExpected ?? null, refundSentAt: null, refundReceivedAt: null, expiresAt: null, createdAt: at, updatedAt: at, serviceId: null, durationMin: null,
    },
    version: {
      id: 1, dealId: 1, version: 1, title: 'Маникюр', description: null, scheduledAt: null, totalKopecks: 250_000,
      prepaymentKopecks: 50_000, cancelRule: 'free_24h', photoMaxToken: null, changeRequestText: null, createdByUserId: 1,
      createdAt: at, confirmedAt: null, confirmedByUserId: null,
    },
    payments,
    seller: user(1),
    sellerProfile: null,
    client: over.client ? user(2) : null,
    receipt: null,
  };
}

const opts = {
  botUsername: 'dogovorilis_bot', demoMode: true, dealLink: `https://max.ru/dogovorilis_bot?start=d_${ID}`,
  linkRailVisible: true, transferRailVisible: true, linkRailRetry: false,
};
type Btn = { type?: string; payload?: string; url?: string; text?: string };
const kb = (b: DealBundle, role: CardRole) => cardKeyboard(b, role, opts);
const buttons = (b: DealBundle, role: CardRole): Btn[] => ((kb(b, role) as { payload?: { buttons?: Btn[][] } } | null)?.payload?.buttons ?? []).flat();
const actions = (b: DealBundle, role: CardRole) => actionsFromKeyboard(kb(b, role));

const ALL: DealStatus[] = [
  'awaiting_confirmation', 'changes_requested', 'declined', 'expired', 'awaiting_prepayment', 'scheduled',
  'awaiting_acceptance', 'remarks', 'awaiting_payment', 'paid', 'closed', 'cancelled',
];

describe('действия экрана сделки — кнопки карточки (SPEC §7.9)', () => {
  it('каждая кнопка карточки любой роли и статуса переводится в действие экрана — ничего не теряется', () => {
    const variants: Over[] = [
      {},
      { client: true },
      { client: true, demo: true },
      { client: true, payments: [{ status: 'claimed' }] },
      { client: true, payments: [{ status: 'pending', rail: 'link', provider: 'yookassa', confirmationUrl: 'https://yoomoney.ru/x' }] },
      { client: true, refundExpected: true },
    ];
    for (const s of ALL) {
      for (const v of variants) {
        for (const role of ['seller', 'client', 'client_demo'] as CardRole[]) {
          for (const b of buttons(bundle(s, v), role)) {
            expect(actionOfButton(b), `${s} ${role} ${JSON.stringify(v)}: «${b.text}»`).not.toBeNull();
          }
        }
      }
    }
  });

  it('набор действий по статусам совпадает с таблицей §5.5', () => {
    const seller = (s: DealStatus, v: Over = { client: true }) => actions(bundle(s, v), 'seller');
    const client = (s: DealStatus, v: Over = { client: true }) => actions(bundle(s, v), 'client');
    const expected: Array<[ActionCode[], ActionCode[]]> = [
      [seller('awaiting_confirmation', {}), ['share', 'edit', 'open_as_client', 'cancel']],
      [seller('awaiting_confirmation'), ['edit', 'remind_client', 'cancel']],
      [seller('changes_requested'), ['edit', 'keep_as_is', 'cancel']],
      [seller('awaiting_prepayment'), ['remind_client', 'cancel']],
      [seller('awaiting_prepayment', { client: true, payments: [{ status: 'claimed' }] }), ['confirm_transfer', 'cancel']],
      [seller('scheduled'), ['done', 'cancel']],
      [seller('awaiting_acceptance'), ['remind_client', 'cancel']],
      [seller('remarks'), ['fixed', 'cancel']],
      [seller('awaiting_payment'), ['remind_client', 'cancel']],
      [seller('paid'), ['attach_receipt', 'close_without_receipt']],
      [seller('closed'), ['receipt_pdf', 'repeat']],
      [seller('cancelled', { client: true, refundExpected: true }), ['refund_confirmed', 'receipt_pdf', 'repeat']],
      [client('awaiting_confirmation'), ['confirm', 'request_changes', 'decline']],
      [client('changes_requested'), []],
      [client('awaiting_prepayment'), ['pay', 'cancel']],
      [client('scheduled'), ['cancel']],
      [client('awaiting_acceptance'), ['accept', 'remarks']],
      [client('remarks'), []],
      [client('awaiting_payment'), ['pay']],
      [client('paid'), []],
      [client('closed'), ['receipt_pdf']],
      [client('cancelled', { client: true, refundExpected: true }), ['refund_confirmed', 'receipt_pdf']],
    ];
    for (const [got, want] of expected) expect(got).toEqual(want);
  });

  it('демо: клиентская сторона — те же действия, что у обычного клиента, «Повторить» у исполнителя нет', () => {
    expect(actions(bundle('awaiting_confirmation', { client: true, demo: true }), 'client_demo')).toEqual(['confirm', 'request_changes', 'decline']);
    expect(actions(bundle('closed', { client: true, demo: true }), 'seller')).toEqual(['receipt_pdf']);
  });
});

describe('хронология и имя файла чека', () => {
  const at = new Date('2026-09-21T10:00:00Z');
  const ev = (seq: number, type: string, actorRole: DealEvent['actorRole'], payload: Record<string, unknown> = {}): DealEvent =>
    ({ id: seq, dealId: 1, seq, type: type as DealEvent['type'], actorUserId: 1, actorRole, payload, createdAt: at });
  const pay = { ...bundle('scheduled').payments[0], id: 7, kind: 'prepayment', rail: 'transfer', provider: 'manual', amountKopecks: 50_000 } as Payment;

  it('основной сценарий читается по-человечески; служебные события пропущены', () => {
    const lines = timelineView(
      [
        ev(1, 'deal.created', 'seller', { source: 'app' }),
        ev(2, 'client.joined', 'client'),
        ev(3, 'version.confirmed', 'client', { version: 1 }),
        ev(4, 'payment.created', 'client', { payment_id: 7 }),
        ev(5, 'payment.claimed', 'client', { payment_id: 7 }),
        ev(6, 'payment.not_received', 'seller', { payment_id: 7 }),
        ev(7, 'payment.succeeded', 'system', { kind: 'prepayment', payment_id: 7 }),
        ev(8, 'reminder.sent', 'system'),
        ev(9, 'deal.done', 'seller'),
        ev(10, 'deal.accepted', 'client_demo'),
        ev(11, 'receipt.attached', 'seller'),
        ev(12, 'deal.closed', 'seller', { with_receipt: true }),
      ],
      [pay],
    );
    expect(lines.map((l) => l.text.replace(/\u00a0/g, ' '))).toEqual([
      'Исполнитель создал сделку',
      'Клиент открыл карточку',
      'Клиент подтвердил условия',
      'Клиент выбрал перевод по реквизитам: предоплата 500 ₽',
      'Клиент сообщил о переводе: предоплата 500 ₽',
      'Исполнитель не видит перевод: предоплата 500 ₽',
      'Предоплата 500 ₽ получена (перевод подтвердил исполнитель)',
      'Исполнитель отметил работу выполненной',
      'Клиент принял работу',
      'Исполнитель приложил чек',
      'Сделка закрыта, квитанция отправлена обеим сторонам',
    ]);
    expect(lines[8].actor).toBe('client'); // демо-клиент — клиентская сторона
  });

  it('новые тексты экрана без длинных тире и точек-разделителей (правило редизайна)', () => {
    const sample = [
      texts.paymentLabel({ kind: 'final', rail: 'link', provider: 'yookassa', status: 'succeeded', amountKopecks: 200_000, at }),
      texts.timelineText('version.created', { version: 2, changed: ['scheduled_at', 'total'] }, { actor: 'seller', payment: null }),
      texts.timelineText('deal.cancelled', { by: 'client', reason: 'заболела' }, { actor: 'client', payment: null }),
      texts.API_CHEQUE_TYPE, texts.API_CHEQUE_TOO_LARGE, texts.API_INVALID_TRANSITION, texts.API_VERSION_MISMATCH,
    ].join('\n');
    expect(sample).not.toMatch(/[—–·]/);
    expect(sample).toContain('Исполнитель изменил условия (версия 2): срок, сумма');
  });

  it('имя файла чека: без путей и мусора, расширение по типу, пустое — «Чек_<id>»', () => {
    expect(chequeFileName(encodeURIComponent('Чек 12.pdf'), ID, 'pdf')).toBe('Чек 12.pdf');
    expect(chequeFileName(encodeURIComponent('../../etc/passwd'), ID, 'pdf')).toBe('passwd.pdf');
    expect(chequeFileName(encodeURIComponent('фото.HEIC'), ID, 'jpg')).toBe('фото.jpg');
    expect(chequeFileName(undefined, ID, 'png')).toBe(`Чек_${ID}.png`);
    expect(chequeFileName('%E0%A4%A', ID, 'pdf')).toBe(`Чек_${ID}.pdf`);
    // в MAX файл уходит под латинским именем: кириллица в заголовке загрузки SDK не проходит
    expect(chequeUploadName(ID, 'jpg')).toMatch(/^[\x20-\x7e]+$/);
  });
});

// ─────────────────────────── с БД: API экрана сделки ───────────────────────────

describe.skipIf(!DB)('экран сделки: API', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(DB!);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await truncateAll();
    h.max.reset();
  });

  async function createDeal(title = 'Стрижка', prepayment = 500): Promise<string> {
    await h.start(SELLER, SELLER_CHAT);
    const res = await h.api('POST', '/api/deals', SELLER, {
      template: 'free', title, total_rub: 2500, prepayment_rub: prepayment, scheduled_at: null, cancel_rule: 'free_24h',
      profile: {
        display_name: 'Анна Мастер', tax_mode: 'npd', payout_details: 'СБП +7 900 000-00-00, Т-Банк', transfer_enabled: true,
        link_enabled: false, default_cancel_rule: 'free_24h',
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.deal.public_id as string;
  }

  async function withClient(title?: string, prepayment?: number): Promise<string> {
    const id = await createDeal(title, prepayment);
    await h.start(CLIENT, CLIENT_CHAT, `d_${id}`);
    return id;
  }

  const full = (id: string, user: number, as?: string) => h.api('GET', `/api/deals/${id}/full${as ? `?as=${as}` : ''}`, user);
  const act = (id: string, user: number, body: Record<string, unknown>) => h.api('POST', `/api/deals/${id}/actions`, user, body);

  /** Предоплата переводом кнопками в чате: оплата на экране не дублируется (SPEC §7.9). */
  async function payByTransfer(id: string, kind: 'prepayment' | 'final'): Promise<void> {
    const clientCard = await cardMid(h, id, 'client');
    const sellerCard = await cardMid(h, id, 'seller');
    await h.press(CLIENT, CLIENT_CHAT, `pt:${id}`, clientCard);
    const pid = await livePaymentId(h, id, kind);
    await h.press(CLIENT, CLIENT_CHAT, `tr:c:${id}:${pid}`, clientCard);
    await h.press(SELLER, SELLER_CHAT, `tr:g:${id}:${pid}`, sellerCard);
  }

  const eventTypes = async (id: string) =>
    (await h.query<{ type: string }>('SELECT e.type FROM deal_events e JOIN deals d ON d.id = e.deal_id WHERE d.public_id = $1 ORDER BY e.seq', [id])).map((r) => r.type);

  it('доступ: участникам — своими глазами, постороннему 403, чужая роль 403, нет сделки 404', async () => {
    const id = await withClient();
    const s = await full(id, SELLER);
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ public_id: id, role: 'seller', status: 'awaiting_confirmation', can_view_as_client: false, client: { name: expect.any(String) } });
    expect(s.json.actions).toEqual(['edit', 'remind_client', 'cancel']);
    expect(s.json.timeline.map((t: { text: string }) => t.text)).toEqual(['Исполнитель создал сделку', 'Клиент открыл карточку']);

    const c = await full(id, CLIENT);
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ role: 'client', status_text: 'Подтвердите условия', actions: ['confirm', 'request_changes', 'decline'] });

    expect((await full(id, STRANGER)).status).toBe(403);
    expect((await full(id, SELLER, 'client')).status).toBe(403);
    expect((await full(id, CLIENT, 'seller')).status).toBe(403);
    expect((await full('ZZZZZZZZZZ', SELLER)).status).toBe(404);
    expect((await full('bad', SELLER)).status).toBe(404);
    expect((await h.apiRaw('GET', `/api/deals/${id}/full`, {})).status).toBe(401);
  });

  it(
    'действия через API дают те же переходы и события, что кнопки в чате; карточки в чате обновляются',
    async () => {
      // Сделка A — кнопками в чате
      const a = await withClient('Через чат');
      await h.press(CLIENT, CLIENT_CHAT, `cf:${a}:1`, await cardMid(h, a, 'client'));
      await payByTransfer(a, 'prepayment');
      await h.press(SELLER, SELLER_CHAT, `dn:${a}`, await cardMid(h, a, 'seller'));
      await h.press(CLIENT, CLIENT_CHAT, `ac:${a}`, await cardMid(h, a, 'client'));

      // Сделка B — те же шаги через мини-приложение
      const b = await withClient('Через приложение');
      const sellerCardB = await cardMid(h, b, 'seller');
      h.max.reset();
      const confirmed = await act(b, CLIENT, { action: 'confirm', version: 1 });
      expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
      expect(confirmed.json).toMatchObject({ result: 'done', deal: { status: 'awaiting_prepayment', role: 'client', actions: ['pay', 'cancel'] } });
      // карточка исполнителя в чате правится на месте, исполнитель получает N2
      expect(h.max.sent.some((m) => m.kind === 'edit' && m.mid === sellerCardB)).toBe(true);
      expect(h.max.inChat(SELLER_CHAT).some((m) => m.text.includes('подтвердил(а) условия'))).toBe(true);

      await payByTransfer(b, 'prepayment');
      expect((await act(b, SELLER, { action: 'done' })).json.deal.status).toBe('awaiting_acceptance');
      expect((await act(b, CLIENT, { action: 'accept' })).json.deal.status).toBe('awaiting_payment');

      expect(await dealStatus(h, a)).toBe('awaiting_payment');
      expect(await eventTypes(b)).toEqual(await eventTypes(a));
    },
    TIMEOUT,
  );

  it(
    'ошибки и повторы: чужая роль, старая версия, отмена после «Выполнено», двойное нажатие, текст, напоминание',
    async () => {
      const id = await withClient('Ошибки', 0);
      // клиент не может «Выполнено», исполнитель не может «Подтверждаю»
      expect((await act(id, CLIENT, { action: 'done' })).status).toBe(403);
      expect((await act(id, SELLER, { action: 'confirm', version: 1 })).status).toBe(403);
      expect((await act(id, STRANGER, { action: 'cancel' })).status).toBe(403);
      // без версии и со старой версией
      expect((await act(id, CLIENT, { action: 'confirm' })).status).toBe(400);
      const edited = await h.api('PUT', `/api/deals/${id}`, SELLER, { title: 'Ошибки 2', total_rub: 2500, prepayment_rub: 0, cancel_rule: 'free_24h' });
      expect(edited.status).toBe(200);
      const stale = await act(id, CLIENT, { action: 'confirm', version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.json.error.code).toBe('version_mismatch');
      // текст «Предложить изменения»: пустой и длинный — 400
      expect((await act(id, CLIENT, { action: 'request_changes', text: '  ' })).status).toBe(400);
      expect((await act(id, CLIENT, { action: 'request_changes', text: 'x'.repeat(501) })).status).toBe(400);
      // напоминание: первое уходит, второе — пауза 4 часа (общий счётчик с кнопкой в чате)
      const r1 = await act(id, SELLER, { action: 'remind_client' });
      expect(r1.json.notice).toBe(texts.REMIND_SENT);
      const r2 = await act(id, SELLER, { action: 'remind_client' });
      expect(r2.json).toMatchObject({ notice: texts.REMIND_COOLDOWN, result: 'already_done' });
      // подтверждение версии 2 без предоплаты → запланировано; квитанция до завершения — 409
      expect((await act(id, CLIENT, { action: 'confirm', version: 2 })).json.deal.status).toBe('scheduled');
      expect((await act(id, CLIENT, { action: 'receipt_pdf' })).json.error.code).toBe('receipt_not_ready');
      // двойное «Выполнено» — второе «уже сделано», без второго события
      const d1 = await act(id, SELLER, { action: 'done' });
      const d2 = await act(id, SELLER, { action: 'done' });
      expect(d1.json.result).toBe('done');
      expect(d2.status).toBe(200);
      expect(d2.json).toMatchObject({ result: 'already_done', notice: texts.API_ALREADY_DONE });
      expect((await eventTypes(id)).filter((t) => t === 'deal.done')).toHaveLength(1);
      // «Напомнить» там, где его нет на карточке исполнителя, — 409
      // клиент после «Выполнено» отменить не может (E7)
      const locked = await act(id, CLIENT, { action: 'cancel' });
      expect(locked.status).toBe(409);
      expect(locked.json.error).toMatchObject({ code: 'client_cancel_locked', message: texts.E7 });
      // «Выполнено» уже нельзя — ни у кого; у исполнителя отмена ещё есть
      const cancelled = await act(id, SELLER, { action: 'cancel', reason: 'клиент не пришёл' });
      expect(cancelled.json.deal.status).toBe('cancelled');
      expect(cancelled.json.deal.timeline.at(-1).text).toBe('Исполнитель отменил(а) сделку: «клиент не пришёл»');
      expect(h.max.inChat(CLIENT_CHAT).some((m) => m.text.includes('отменена'))).toBe(true);
      // квитанция после отмены — в чат с ботом
      const pdf = await act(id, CLIENT, { action: 'receipt_pdf' });
      expect(pdf.json.notice).toBe(texts.API_RECEIPT_SENT);
    },
    TIMEOUT,
  );

  it(
    'сделка целиком через мини-приложение: подтверждение, выполнено, приёмка, чек файлом, квитанция обеим',
    async () => {
      const id = await withClient('Целиком', 500);
      expect((await act(id, CLIENT, { action: 'confirm', version: 1 })).json.deal.status).toBe('awaiting_prepayment');
      await payByTransfer(id, 'prepayment');
      expect((await act(id, SELLER, { action: 'done' })).json.deal.status).toBe('awaiting_acceptance');
      const remarks = await act(id, CLIENT, { action: 'remarks', text: 'Скол на мизинце' });
      expect(remarks.json.deal.status).toBe('remarks');
      expect((await act(id, SELLER, { action: 'fixed' })).json.deal.status).toBe('awaiting_acceptance');
      expect((await act(id, CLIENT, { action: 'accept' })).json.deal.status).toBe('awaiting_payment');
      await payByTransfer(id, 'final');
      const paid = await full(id, SELLER);
      expect(paid.json).toMatchObject({ status: 'paid', actions: ['attach_receipt', 'close_without_receipt'], money: { paid_kopecks: 250_000, due_kopecks: 0 } });
      expect(paid.json.documents.cheque_text).toMatch(/^Чек: до /);

      const pdfBytes = Buffer.from('%PDF-1.4\n% чек\n');
      // чужой, клиент, не тот тип, пустое тело — отказ; сделка не меняется
      expect((await h.apiUpload(`/api/deals/${id}/receipt`, STRANGER, pdfBytes, 'application/pdf')).status).toBe(403);
      expect((await h.apiUpload(`/api/deals/${id}/receipt`, CLIENT, pdfBytes, 'application/pdf')).status).toBe(403);
      const wrong = await h.apiUpload(`/api/deals/${id}/receipt`, SELLER, Buffer.from('x'), 'application/msword', 'чек.doc');
      expect(wrong.status).toBe(400);
      expect(wrong.json.error.message).toBe(texts.API_CHEQUE_TYPE);
      const big = await h.apiUpload(`/api/deals/${id}/receipt`, SELLER, Buffer.alloc(20 * 1024 * 1024 + 1), 'application/pdf');
      expect(big.status).toBe(413);
      expect(big.json.error.code).toBe('file_too_large');
      expect(await dealStatus(h, id)).toBe('paid');

      h.max.reset();
      const uploadsBefore = h.max.uploads;
      const ok = await h.apiUpload(`/api/deals/${id}/receipt`, SELLER, pdfBytes, 'application/pdf', 'Чек НПД.pdf');
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(ok.json.deal).toMatchObject({ status: 'closed', actions: ['receipt_pdf', 'repeat'] });
      expect(ok.json.deal.documents.cheque_text).toMatch(/^Чек приложен/);
      // файл чека и квитанция PDF загружены в MAX; клиенту — чек и квитанция, исполнителю — квитанция
      expect(h.max.uploads - uploadsBefore).toBeGreaterThanOrEqual(2);
      const toClient = h.max.inChat(CLIENT_CHAT);
      expect(toClient.some((m) => m.text.startsWith(texts.RECEIPT_FORWARDED) && m.attachmentTypes.includes('file'))).toBe(true);
      expect(toClient.some((m) => m.text.includes('закрыта') && m.attachmentTypes.includes('file'))).toBe(true);
      expect(h.max.inChat(SELLER_CHAT).some((m) => m.text.includes('закрыта') && m.attachmentTypes.includes('file'))).toBe(true);
      const receipt = await h.query<{ file_name: string; attachment_type: string }>(
        'SELECT r.file_name, r.attachment_type FROM receipts r JOIN deals d ON d.id = r.deal_id WHERE d.public_id = $1',
        [id],
      );
      expect(receipt).toEqual([{ file_name: 'Чек НПД.pdf', attachment_type: 'file' }]);
      // повторная загрузка в закрытую сделку — 409
      expect((await h.apiUpload(`/api/deals/${id}/receipt`, SELLER, pdfBytes, 'application/pdf')).status).toBe(409);

      const timeline = (await full(id, CLIENT)).json.timeline.map((t: { text: string }) => t.text);
      expect(timeline).toContain('Клиент оставил замечания: «Скол на мизинце»');
      expect(timeline).toContain('Исполнитель приложил чек');
      expect(timeline.at(-1)).toBe('Сделка закрыта, квитанция отправлена обеим сторонам');
    },
    TIMEOUT,
  );

  it(
    'демо: исполнитель смотрит клиентскую сторону и действует от роли клиента',
    async () => {
      await h.start(SELLER, SELLER_CHAT);
      await h.press(SELLER, SELLER_CHAT, 'dm:new', null);
      const [{ public_id: id }] = await h.query<{ public_id: string }>('SELECT public_id FROM deals ORDER BY id DESC LIMIT 1');
      const asSeller = await full(id, SELLER);
      expect(asSeller.json).toMatchObject({ role: 'seller', demo: true, can_view_as_client: true, client: { name: 'демо-клиент (вы)' } });
      const asClient = await full(id, SELLER, 'client');
      expect(asClient.json).toMatchObject({ role: 'client', actions: ['confirm', 'request_changes', 'decline'] });
      const confirmed = await act(id, SELLER, { action: 'confirm', version: 1, as: 'client' });
      expect(confirmed.json.deal).toMatchObject({ role: 'client', status: 'awaiting_prepayment' });
      // «Подтверждаю» — действие клиента: с as=seller его не выполнить
      expect((await act(id, SELLER, { action: 'accept', as: 'seller' })).status).toBe(403);
      const [ev] = await h.query<{ actor_role: string }>(
        `SELECT e.actor_role FROM deal_events e JOIN deals d ON d.id = e.deal_id WHERE d.public_id = $1 AND e.type = 'version.confirmed'`,
        [id],
      );
      expect(ev.actor_role).toBe('client_demo');
    },
    TIMEOUT,
  );
});
