// Сообщение «Спасибо, ваша оценка N из 5» с кнопкой «Без комментария» (ЗАДАЧА_08 E, SPEC §7.11). Когда клиент
// прислал комментарий, кнопка больше не нужна: её убирают правкой этого сообщения. mid держится в памяти процесса,
// как пауза «Напомнить клиенту» (remind.ts): после перезапуска кнопка останется и ответит «Спасибо, оценка сохранена».
const pending = new Map<string, { mid: string; score: number }>();

const keyOf = (userId: number, dealId: number) => `${userId}:${dealId}`;

export function rememberThanks(userId: number, dealId: number, mid: string, score: number): void {
  pending.set(keyOf(userId, dealId), { mid, score });
}

/** Забрать запомненное сообщение: после комментария или «Без комментария» оно больше не понадобится. */
export function takeThanks(userId: number, dealId: number): { mid: string; score: number } | null {
  const key = keyOf(userId, dealId);
  const found = pending.get(key) ?? null;
  pending.delete(key);
  return found;
}
