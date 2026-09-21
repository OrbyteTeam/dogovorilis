// Проверка staged-diff на секреты. Использование: node scripts/check-secrets.mjs (или git hook pre-commit).
// Разбирает diff по файлам: к разным файлам применимы разные правила.
// Публичные сертификаты Минцифры (certs/*.pem) — это base64 по своей природе, их коммитить НУЖНО
// (см. certs/README.md), поэтому к ним применяется только правило про приватный ключ.
import { execSync } from 'node:child_process';

/** Правила, которые действуют для любого файла. */
const ALWAYS = [
  { name: 'Приватный ключ', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    name: 'Присвоение секрета в env',
    re: /^\+\s*(MAX_BOT_TOKEN|YOOKASSA_SECRET_KEY|YOOKASSA_SHOP_ID|TBANK_TERMINAL_PASSWORD|MAX_WEBHOOK_SECRET|TIMEWEB_TOKEN|GH_TOKEN|GITHUB_TOKEN)\s*=\s*\S+/,
  },
  // Токен API Timeweb Cloud — JWT: три части через точку, первая всегда начинается с eyJ
  // (base64url от `{"`). Ловится в любом файле, включая сертификаты: в .pem JWT делать нечего.
  { name: 'JWT (токен Timeweb и подобные)', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
];

/** Правила для кода и конфигов (не для публичных сертификатов). */
const CODE_ONLY = [
  // Токен MAX: 60+ символов base64url с ОБОИМИ регистрами. Чистый hex (например SHA-256 из документации) не считается.
  { name: 'Токен бота MAX', re: /\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{60,}\b/ },
  { name: 'Секретный ключ ЮKassa', re: /\b(test|live)_[A-Za-z0-9_-]{20,}\b/ },
];

/** Отсеиваем очевидные не-секреты: константы-алфавиты и длинные последовательности по порядку. */
const ALPHABET_MARKERS = ['ABCDEFGHIJ', 'abcdefghij', '0123456789'];
function looksLikeAlphabet(line) {
  return ALPHABET_MARKERS.some((m) => line.includes(m));
}

const EXCLUDE = [':(exclude)package-lock.json'];
const raw = execSync(`git diff --cached --unified=0 -- . ${EXCLUDE.map((e) => `"${e}"`).join(' ')}`, { encoding: 'utf8' });

let file = '';
const hits = [];
for (const line of raw.split('\n')) {
  if (line.startsWith('+++ b/')) {
    file = line.slice(6);
    continue;
  }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;

  const isPublicCert = /^certs\/.*\.(pem|crt)$/.test(file);
  const rules = isPublicCert ? ALWAYS : [...ALWAYS, ...CODE_ONLY];
  for (const rule of rules) {
    if (!rule.re.test(line)) continue;
    if (rule.name === 'Токен бота MAX' && looksLikeAlphabet(line)) continue;
    hits.push(`${file}: ${rule.name}: ${line.slice(0, 100)}`);
  }
}

if (hits.length) {
  console.error('Похоже на секрет в staged-изменениях:\n' + hits.map((h) => '  ' + h).join('\n'));
  process.exit(1);
}
console.log('check-secrets: ok');
