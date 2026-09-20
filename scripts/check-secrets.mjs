// Проверка staged-diff на секреты. Использование: node scripts/check-secrets.mjs (или git hook pre-commit).
// Ищет токен MAX (длинная base64url-строка), ключи ЮKassa (test_/live_), пароли терминалов, приватные ключи.
import { execSync } from 'node:child_process';

const patterns = [
  // Токен MAX: 60+ символов base64url с ОБЕИМИ регистрами (чистый hex, например SHA-256 из документации, не считается)
  { name: 'MAX bot token', re: /\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{60,}\b/ },
  { name: 'YooKassa secret', re: /\b(test|live)_[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Private key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Env assignment with value', re: /^\+\s*(MAX_BOT_TOKEN|YOOKASSA_SECRET_KEY|TBANK_TERMINAL_PASSWORD|MAX_WEBHOOK_SECRET)\s*=\s*\S+/m },
];

const diff = execSync('git diff --cached --unified=0 -- . ":(exclude)package-lock.json"', { encoding: 'utf8' });
const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
const hits = [];
for (const line of added) {
  for (const p of patterns) {
    if (p.re.test(line)) hits.push(`${p.name}: ${line.slice(0, 120)}`);
  }
}
if (hits.length) {
  console.error('Похоже на секрет в staged-изменениях:\n' + hits.map((h) => '  ' + h).join('\n'));
  process.exit(1);
}
console.log('check-secrets: ok');
