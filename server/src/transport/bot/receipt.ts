// Сборка и отправка квитанции PDF (SPEC §11). Рендер — domain/receipt/pdf.ts; здесь только данные и доставка.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cfg } from '../../config.js';
import { inTx } from '../../db/pool.js';
import * as usersRepo from '../../db/repos/users.js';
import type { MaxGateway } from '../../integrations/max/gateway.js';
import { log } from '../../logger.js';
import * as texts from '../../texts.js';
import { paidTotal, remaining, type DealBundle } from '../../types.js';
import { renderReceiptPdf, receiptFileName, type ReceiptData } from '../../domain/receipt/pdf.js';
import { taxModeOf } from '../../domain/deal/service.js';
import { displayName } from './cards.js';

/** Телефон в квитанции — маской (SPEC §9.5): «+7 ••• ••• 12-34». */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return null;
  const tail = digits.slice(-4);
  return `+${digits[0]} ••• ••• ${tail.slice(0, 2)}-${tail.slice(2)}`;
}

export function buildReceiptData(bundle: DealBundle, now = new Date()): ReceiptData {
  const { deal, version, seller, client } = bundle;
  return {
    publicId: deal.publicId,
    demo: deal.demo,
    generatedAt: now,
    status: deal.status,
    seller: {
      name: bundle.sellerProfile?.displayName || displayName(seller.firstName, seller.lastName),
      maxUserId: seller.maxUserId,
      phoneMasked: seller.phoneVerifiedAt ? maskPhone(seller.phone) : null,
    },
    client: client ? { name: deal.demo ? 'демо-клиент (тот же пользователь)' : displayName(client.firstName, client.lastName), maxUserId: client.maxUserId } : null,
    version: {
      version: version.version,
      title: version.title,
      description: version.description,
      scheduledAt: version.scheduledAt,
      totalKopecks: version.totalKopecks,
      prepaymentKopecks: version.prepaymentKopecks,
      cancelRule: version.cancelRule,
      createdAt: version.createdAt,
    },
    confirmations: { confirmedAt: deal.confirmedAt, doneAt: deal.doneAt, acceptedAt: deal.acceptedAt },
    payments: bundle.payments
      .filter((p) => p.status !== 'canceled' && p.status !== 'expired')
      .map((p) => ({
        kind: p.kind,
        amountKopecks: p.amountKopecks,
        rail: p.rail,
        provider: p.provider,
        providerPaymentId: p.providerPaymentId,
        at: p.succeededAt ?? p.claimedAt,
        succeeded: p.status === 'succeeded',
      })),
    paidKopecks: paidTotal(bundle.payments),
    remainingKopecks: Math.max(0, remaining(version) - paidTotal(bundle.payments.filter((p) => p.kind === 'final'))),
    receipt: { attachedAt: bundle.receipt?.createdAt ?? null, taxMode: taxModeOf(bundle) },
    closing: {
      closedAt: deal.closedAt,
      cancelledAt: deal.cancelledAt,
      cancelledByRole: deal.cancelledByRole,
      cancelReason: deal.cancelReason,
      cancelRefundExpected: deal.cancelRefundExpected,
    },
    timezone: cfg().APP_TIMEZONE,
  };
}

/**
 * Сформировать квитанцию и отправить обеим сторонам вместе с текстом N14.
 * Если исполнитель приложил чек — он уходит тем же токеном вложения (SPEC §6.6).
 * Временный файл удаляется после отправки.
 */
export async function renderAndSendReceipt(max: MaxGateway, bundle: DealBundle): Promise<void> {
  const fileName = receiptFileName(bundle.deal.publicId);
  // Получателю MAX показывает БАЗОВОЕ ИМЯ ФАЙЛА ПО ПУТИ, который мы загрузили (CONTRACTS §1.8) —
  // а не какое-то имя из метаданных. Поэтому временный файл называем ровно так, как должен
  // увидеть пользователь, а уникальность обеспечиваем отдельным каталогом, а не мусором в имени.
  // Проверено вживую 21.09.2026: раньше в чат приходило «dogovorilis-<id>-<таймстамп>.pdf»,
  // потому что имя собиралось из пути, а receiptFileName() уходил только в лог.
  const outDir = await mkdtemp(path.join(tmpdir(), 'dogovorilis-receipt-'));
  const outPath = path.join(outDir, fileName);
  try {
    await renderReceiptPdf(buildReceiptData(bundle), outPath);
    const attachment = await max.uploadFile(outPath);
    const text = texts.N14({ id: bundle.deal.publicId, withReceipt: Boolean(bundle.receipt) });

    const targets = new Set<number>([bundle.deal.sellerUserId]);
    if (bundle.deal.clientUserId) targets.add(bundle.deal.clientUserId);

    for (const userId of targets) {
      const user = await inTx((c) => usersRepo.byId(c, userId));
      if (!user?.dialogChatId) continue;
      // Чек исполнителя пересылаем первым — квитанция ссылается на него («чек — выше»).
      if (bundle.receipt) {
        await max.send({ chatId: user.dialogChatId }, 'Чек от исполнителя:', [
          max.attachmentFromToken(bundle.receipt.attachmentType, bundle.receipt.maxToken),
        ]);
      }
      await max.send({ chatId: user.dialogChatId }, text, [attachment]);
    }
    log.info({ deal: bundle.deal.publicId, file: fileName }, 'квитанция отправлена');
  } catch (e) {
    log.error({ deal: bundle.deal.publicId, err: (e as Error).message }, 'квитанция не сформирована');
    throw e;
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
