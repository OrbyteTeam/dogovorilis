// Таблица receipts — чек, приложенный исполнителем к сделке (SPEC §8, §5.2 T15).
import type { Queryable } from '../pool.js';
import type { Receipt } from '../../types.js';

const COLS = 'id, deal_id, uploaded_by_user_id, attachment_type, max_token, max_url, file_name, created_at';

type ReceiptRow = {
  id: number;
  deal_id: number;
  uploaded_by_user_id: number;
  attachment_type: 'image' | 'file';
  max_token: string;
  max_url: string | null;
  file_name: string | null;
  created_at: Date;
};

function mapReceipt(r: ReceiptRow): Receipt {
  return {
    id: r.id,
    dealId: r.deal_id,
    uploadedByUserId: r.uploaded_by_user_id,
    attachmentType: r.attachment_type,
    maxToken: r.max_token,
    maxUrl: r.max_url,
    fileName: r.file_name,
    createdAt: r.created_at,
  };
}

export async function create(
  q: Queryable,
  a: {
    dealId: number;
    uploadedByUserId: number;
    attachmentType: 'image' | 'file';
    maxToken: string;
    maxUrl: string | null;
    fileName: string | null;
  },
): Promise<Receipt> {
  const res = await q.query<ReceiptRow>(
    `INSERT INTO receipts (deal_id, uploaded_by_user_id, attachment_type, max_token, max_url, file_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLS}`,
    [a.dealId, a.uploadedByUserId, a.attachmentType, a.maxToken, a.maxUrl, a.fileName],
  );
  return mapReceipt(res.rows[0]!);
}

/** Последний приложенный чек по сделке (схема не запрещает несколько попыток загрузки). */
export async function byDeal(q: Queryable, dealId: number): Promise<Receipt | null> {
  const res = await q.query<ReceiptRow>(
    `SELECT ${COLS} FROM receipts WHERE deal_id = $1 ORDER BY id DESC LIMIT 1`,
    [dealId],
  );
  return res.rows[0] ? mapReceipt(res.rows[0]) : null;
}
