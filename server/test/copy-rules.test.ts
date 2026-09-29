// Правила языка интерфейса (DESIGN_BRIEF §2, чек-лист §9 п. 1, 2, 8): проверяем исходники, а не вызовы функций,
// чтобы не пропустить строку, до которой не дошёл ни один сценарий. Файл разбирается компилятором TypeScript,
// берутся только строки, шаблоны и текст JSX: комментарии для разработчиков правилам интерфейса не подчиняются.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { BTN } from '../src/texts.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Файлы, из которых текст попадает к пользователю: бот, уведомления, подсказки формы, ошибки API. */
const SERVER_FILES = [
  'server/src/texts.ts',
  'server/src/transport/bot/cards.ts',
  'server/src/transport/bot/keyboards.ts',
  'server/src/transport/bot/notify.ts',
  'server/src/domain/templates.ts',
  'server/src/transport/http/schemas.ts',
  'server/src/transport/bot/receipt.ts',
  'server/src/domain/receipt/pdf.ts',
  'server/src/domain/receipt/history.ts',
  'server/src/domain/deal/service.ts',
  'server/src/domain/money.ts',
  'server/src/transport/http/routes/api.ts',
  // Страница возврата с оплаты по ссылке (SPEC §9.2): её видит клиент в браузере.
  'server/src/transport/http/server.ts',
];

type Literal = { file: string; line: number; text: string };

function literals(file: string): Literal[] {
  const source = readFileSync(path.join(REPO, file), 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: Literal[] = [];
  const push = (node: ts.Node, text: string) => {
    if (!text.trim()) return;
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return; // пути модулей не текст интерфейса
    if (isDeveloperText(node)) return; // логи и исключения читают разработчики, а не пользователь
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) push(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) push(node, node.text);
    else if (ts.isJsxText(node)) push(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const DEVELOPER_ERRORS = ['Error', 'ForbiddenError', 'UnauthorizedError'];

/** `log.warn(…)`, `console.x(…)`, `new Error(…)`: текст для разработчика, правила интерфейса к нему не относятся. */
function isDeveloperText(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const target = node.expression.expression;
    return ts.isIdentifier(target) && (target.text === 'log' || target.text === 'console');
  }
  // Сообщения этих исключений пользователь не видит: API и бот подставляют вместо них тексты из texts.ts.
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) return DEVELOPER_ERRORS.includes(node.expression.text);
  return false;
}

function report(found: Literal[]): string {
  return found.map((l) => `${l.file}:${l.line}: ${l.text.slice(0, 120)}`).join('\n');
}

/** Все .ts и .tsx внутри каталога: так новый экран мини-приложения попадает под проверку сам. */
export function filesUnder(dir: string): string[] {
  const abs = path.join(REPO, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const rel = path.join(dir, name);
    if (statSync(path.join(REPO, rel)).isDirectory()) out.push(...filesUnder(rel));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

/** Сервер и всё мини-приложение: новый экран попадает под проверку сам (чек-лист §9 п. 1, п. 8). */
export function checkedFiles(): string[] {
  return [...SERVER_FILES, ...filesUnder('webapp/src')];
}

const FORBIDDEN_CHARS = /[—–·•]/;

describe('разделители (DESIGN_BRIEF §2.1)', () => {
  it.each(checkedFiles())('в текстах %s нет «—», «–», «·», «•»', (file) => {
    const found = literals(file).filter((l) => FORBIDDEN_CHARS.test(l.text));
    expect(report(found)).toBe('');
  });

  it.each(checkedFiles())('в текстах %s нет восклицательных знаков (§2.6)', (file) => {
    const found = literals(file).filter((l) => /[А-Яа-яЁё][^`]*!/.test(l.text));
    expect(report(found)).toBe('');
  });
});

/**
 * Словарь §2.7: слова справа запрещены в интерфейсе. Регулярные выражения со словоформами; граница слова
 * для кириллицы задаётся явно: `\b` в JavaScript её не понимает.
 */
const WORD = (stem: string) => new RegExp(`(?<![а-яё])${stem}`, 'i');
const VOCABULARY: [RegExp, string][] = [
  [WORD('мастер(?![а-яё]*ск)'), 'мастер: пишем «исполнитель»'],
  [WORD('продав[её]ц|продавц'), 'продавец: «исполнитель»'],
  [WORD('специалист'), 'специалист: «исполнитель»'],
  [WORD('заказчик'), 'заказчик: «клиент»'],
  [WORD('покупател'), 'покупатель: «клиент»'],
  [WORD('(?<!на )заказ(?!чик)'), 'заказ: «сделка» («на заказ» как вид работы допустимо)'],
  [WORD('запис[ьейи]'), 'запись: «сделка»'],
  [WORD('визит'), 'визит: «сделка»'],
  [WORD('детал[иья]'), 'детали: «условия»'],
  [WORD('параметр'), 'параметры: «условия»'],
  [WORD('редакци'), 'редакция: «версия»'],
  [WORD('цен[аыуе](?![а-яё])'), 'цена: «сумма»'],
  [WORD('стоимост'), 'стоимость: «сумма»'],
  [WORD('итого'), 'итого: «сумма», «оплачено»'],
  [WORD('аванс'), 'аванс: «предоплата»'],
  [WORD('депозит'), 'депозит: «предоплата»'],
  [WORD('залог'), 'залог: «предоплата»'],
  [WORD('доплат'), 'доплата: «остаток»'],
  [WORD('финальн[а-яё]* плат'), 'финальный платёж: «остаток»'],
  [WORD('штраф'), 'штраф: «правило отмены»'],
  [WORD('политик'), 'политика: «правило отмены»'],
  [WORD('эквайринг'), 'эквайринг: «ссылка на оплату»'],
  [WORD('инвойс'), 'инвойс: «ссылка на оплату»'],
  [WORD('сч[её]т(?![а-яё])'), 'счёт: «ссылка на оплату»'],
  [WORD('данные для оплаты'), 'данные для оплаты: «реквизиты»'],
  [WORD('фискальн[а-яё]* чек'), 'фискальный чек: «чек»'],
  [WORD('акт(?![а-яё])'), 'акт: «квитанция»'],
  [WORD('отч[её]т(?![а-яё])'), 'отчёт: «квитанция»'],
  [WORD('уведомлени'), 'уведомление: только в документации, в интерфейсе «сообщение» или «напоминание»'],
  [WORD('пуш(?![а-яё])'), 'пуш: «напоминание»'],
  [WORD('тестов[а-яё]* сделк'), 'тестовая сделка: «демо-сделка»'],
  [WORD('шаблон'), 'шаблон: «пример», «услуга»'],
  [WORD('песочниц'), 'песочница: «тест»'],
  [/sandbox/i, 'sandbox: «тест»'],
  [WORD('мои сделки'), '«Мои» убрано из названий'],
  [WORD('успешно'), 'тон §2.6: без «успешно»'],
  [WORD('пожалуйста'), 'тон §2.6: без «пожалуйста»'],
  [WORD('пользовател'), 'пользователь: «клиент» или «исполнитель»'],
  [/(?<![А-ЯЁа-яё])СБП(?![А-ЯЁа-яё])/, 'СБП: «перевод по реквизитам» (кроме подсказки «через «+» в чате»)'],
  [WORD('не волнуйтесь'), 'тон §2.6'],
];

/** «Договорённость»: только название продукта и одна фраза в /start (S1). */
const AGREEMENT = WORD('договор[её]нност');
const AGREEMENT_ALLOWED = [
  'карточка договорённости прямо в чате MAX',
  // Подвал квитанции дословно по DESIGN_BRIEF §8 п. 8.
  'Квитанция фиксирует договорённость',
];

/** Фразы, которые бриф задаёт дословно, хотя в них есть слово из словаря. */
const VOCABULARY_ALLOWED = [
  // Строка демо-квитанции по DESIGN_BRIEF §8 п. 1.
  'Демонстрационная сделка: обе стороны один пользователь',
];

describe('словарь (DESIGN_BRIEF §2.7)', () => {
  it.each(checkedFiles())('в текстах %s нет запрещённых слов', (file) => {
    const problems: string[] = [];
    for (const l of literals(file)) {
      if (VOCABULARY_ALLOWED.some((ok) => l.text.includes(ok))) continue;
      for (const [re, why] of VOCABULARY) {
        if (re.test(l.text)) problems.push(`${l.file}:${l.line}: ${why}: ${l.text.slice(0, 100)}`);
      }
      if (AGREEMENT.test(l.text) && !AGREEMENT_ALLOWED.some((ok) => l.text.includes(ok))) {
        problems.push(`${l.file}:${l.line}: «договорённость» вне /start: ${l.text.slice(0, 100)}`);
      }
    }
    expect(problems.join('\n')).toBe('');
  });
});

/** Колонка «После» таблицы DESIGN_BRIEF §2.8, дословно. Коды callback живут отдельно и не менялись. */
const BUTTONS_AFTER: Record<keyof typeof BTN, string> = {
  newDeal: 'Новая сделка',
  myDeals: 'Сделки',
  settings: 'Настройки',
  help: 'Как это работает',
  tryIt: '🧪 Попробовать',
  tryDemo: '🧪 Демо: пройти одному',
  exampleDeal: 'Пример: позвать клиента',
  menu: 'Меню',
  sendToMax: 'Отправить клиенту',
  copyLink: 'Скопировать ссылку',
  editTerms: 'Изменить условия',
  openAsClient: '🧪 Открыть как клиент',
  cancelDeal: 'Отменить сделку',
  remindClient: 'Напомнить клиенту',
  keepAsIs: 'Оставить как есть',
  confirm: 'Подтверждаю',
  requestChanges: 'Предложить изменения',
  decline: 'Отказаться',
  declineYes: 'Отказаться от сделки',
  payByLink: 'Оплатить по ссылке',
  payByTransfer: 'Перевести по реквизитам',
  transferDone: 'Я перевёл(а)',
  transferReceived: 'Получил(а)',
  transferNotReceived: 'Не вижу перевода',
  transferCancel: 'Другой способ оплаты',
  goToPayment: 'Оплатить',
  checkPayment: 'Проверить оплату',
  emulatePayment: '🧪 Эмулировать оплату',
  newLink: 'Новая ссылка',
  done: 'Выполнено',
  accept: 'Принимаю',
  remarks: 'Есть замечания',
  fixed: 'Исправлено',
  attachReceipt: 'Приложить чек',
  closeWithoutReceipt: 'Закрыть без чека',
  closeWithoutReceiptYes: 'Закрыть без чека',
  cancelYes: 'Отменить сделку',
  noReason: 'Без причины',
  receiptPdf: 'Квитанция PDF',
  repeat: 'Повторить сделку',
  refundSent: 'Вернул(а) предоплату',
  refundReceived: 'Возврат получил(а)',
  open: 'Открыть сделку',
  schedule: 'Расписание',
  back: 'Назад',
  keepDeal: 'Оставить сделку',
  // ЗАДАЧА_08 D, E: кнопок не было в таблице §2.8, подписи по тем же правилам
  otherTime: 'Другое время',
  writeText: 'Написать текстом',
  proposeOther: 'Предложить другое время',
  noComment: 'Без комментария',
};

describe('подписи кнопок (DESIGN_BRIEF §2.8)', () => {
  it('все ключи BTN совпадают с колонкой «После»', () => {
    expect(BTN).toEqual(BUTTONS_AFTER);
  });

  it('эмодзи только у 🧪: демо и тест', () => {
    for (const [key, label] of Object.entries(BTN)) {
      const withoutTest = label.replace('🧪 ', '');
      expect(/\p{Extended_Pictographic}/u.test(withoutTest), key).toBe(false);
    }
  });

  it('первая буква прописная, остальное как в тексте', () => {
    for (const [key, label] of Object.entries(BTN)) {
      const first = label.replace('🧪 ', '')[0];
      expect(first, key).toBe(first.toUpperCase());
    }
  });
});
