#!/usr/bin/env bash
# Выкатка на VPS с рабочей машины. Запускается ИЗ КОРНЯ репозитория:
#
#   bash deploy/deploy.sh            # выкатить и поднять
#   bash deploy/deploy.sh --check    # только проверить доступность уже развёрнутого
#
# Параметры берутся из ../VPS.md (вне репозитория) — там же, где их оставляет тот, кто покупал сервер.
# Формат — строки VPS_*=… в любом месте файла; можно переопределить переменными окружения.
#
# .env НЕ выкатывается: он живёт только на сервере (положить один раз, см. deploy/README.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VPS_FILE="${VPS_FILE:-$REPO_ROOT/../VPS.md}"
APP_DIR=/opt/dogovorilis

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() {
  printf '\033[31m%s\033[0m\n' "$1" >&2
  exit 1
}

# ── параметры ────────────────────────────────────────────────────────────────
if [[ -f "$VPS_FILE" ]]; then
  # Берём только строки вида VPS_KEY=value: так файл остаётся читаемым markdown-ом для человека.
  while IFS= read -r line; do
    [[ $line =~ ^(VPS_[A-Z_]+)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]%\"}"
    value="${value#\"}"
    # Значение из окружения приоритетнее файла.
    [[ -n "${!key:-}" ]] || printf -v "$key" '%s' "$value"
    export "${key?}"
  done <"$VPS_FILE"
else
  echo "Файл $VPS_FILE не найден — беру параметры из окружения." >&2
fi

: "${VPS_HOST:?не задан VPS_HOST (IP или имя сервера) — заполните ../VPS.md}"
: "${VPS_DOMAIN:?не задан VPS_DOMAIN (домен, на который смотрит A-запись)}"
VPS_USER="${VPS_USER:-root}"
VPS_SSH_KEY="${VPS_SSH_KEY:-$HOME/.ssh/dogovorilis_vps}"
VPS_SSH_KEY="${VPS_SSH_KEY/#\~/$HOME}"

[[ -f "$VPS_SSH_KEY" ]] || die "Нет приватного ключа $VPS_SSH_KEY. Создайте: ssh-keygen -t ed25519 -f $VPS_SSH_KEY -C dogovorilis-deploy -N ''"

SSH=(ssh -i "$VPS_SSH_KEY" -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_HOST")
TARGET="$VPS_USER@$VPS_HOST:$APP_DIR/"

# ── проверка доступности (и отдельный режим --check) ─────────────────────────
check() {
  say "Проверки на https://$VPS_DOMAIN"
  local ok=0
  curl -fsS --max-time 15 "https://$VPS_DOMAIN/healthz" && echo || {
    echo "  /healthz недоступен" >&2
    ok=1
  }
  # /readyz отдаёт 503, пока БД или бот не готовы — поэтому смотрим тело, а не только код.
  curl -sS --max-time 15 "https://$VPS_DOMAIN/readyz" && echo || ok=1
  curl -fsS --max-time 15 -o /dev/null -w '  /app/ → HTTP %{http_code}\n' "https://$VPS_DOMAIN/app/" || ok=1
  # Сертификат: curl -f сам падает на недоверенном, но скажем об этом явно.
  curl -fsS --max-time 15 -o /dev/null "https://$VPS_DOMAIN/healthz" && echo "  сертификат доверенный"
  return $ok
}

if [[ "${1:-}" == "--check" ]]; then
  check
  exit $?
fi

# ── выкатка ──────────────────────────────────────────────────────────────────
say "Проверка связи с $VPS_USER@$VPS_HOST"
"${SSH[@]}" true || die "SSH не отвечает. Проверьте IP, что ключ добавлен в панели и что сервер загрузился."
"${SSH[@]}" "command -v docker >/dev/null" || die "На сервере нет Docker — сначала deploy/bootstrap-server.sh"
"${SSH[@]}" "test -f $APP_DIR/.env" || die "На сервере нет $APP_DIR/.env. Положите его один раз:
  scp -i $VPS_SSH_KEY ../.env.server $VPS_USER@$VPS_HOST:$APP_DIR/.env"

say "Синхронизация файлов (rsync)"
# --delete: на сервере остаётся ровно то, что в репозитории, без следов прошлых версий.
# .env исключён намеренно: он там свой, с боевыми значениями, и перезатирать его нельзя.
rsync -az --delete \
  --exclude node_modules --exclude '**/node_modules' \
  --exclude .git --exclude .env --exclude '**/dist' \
  --exclude '*.log' --exclude '.*/' \
  -e "ssh -i $VPS_SSH_KEY -o StrictHostKeyChecking=accept-new" \
  "$REPO_ROOT/" "$TARGET"

say "Сборка и запуск прод-профиля"
"${SSH[@]}" "cd $APP_DIR && docker compose --profile prod up -d --build && docker compose ps"

say "Ждём, пока сервис ответит"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$VPS_DOMAIN/healthz" >/dev/null 2>&1; then break; fi
  # Первый запуск ждёт выпуск сертификата Let's Encrypt — это десятки секунд, а не секунды.
  printf '.'
  sleep 5
done
echo

check || die "Сервис не отвечает. Логи: ${SSH[*]} 'cd $APP_DIR && docker compose logs --tail=100 app caddy'"

say "Готово. Коммит на сервере:"
"${SSH[@]}" "cd $APP_DIR && cat .deployed-commit 2>/dev/null || true"
git -C "$REPO_ROOT" rev-parse HEAD | "${SSH[@]}" "cat > $APP_DIR/.deployed-commit"
git -C "$REPO_ROOT" rev-parse --short HEAD
