#!/usr/bin/env bash
# Подготовка чистого сервера Ubuntu 24.04 под «Договорились». Запускается ОДИН раз, от root, НА СЕРВЕРЕ.
#
# Запускать ОТВЯЗАННО от SSH-сессии, иначе потеряете вывод:
#
#   scp -i ~/.ssh/dogovorilis_vps deploy/bootstrap-server.sh root@<IP>:/root/
#   ssh -i ~/.ssh/dogovorilis_vps root@<IP> \
#     'setsid nohup bash /root/bootstrap-server.sh > /root/bootstrap.log 2>&1 </dev/null & echo запущено'
#   ssh -i ~/.ssh/dogovorilis_vps root@<IP> 'tail -f /root/bootstrap.log'
#
# Почему так: `ufw --force enable` сбрасывает conntrack и рвёт ТЕКУЩЕЕ SSH-соединение, а `systemctl reload ssh`
# может добить остаток. Проверено 21.09.2026: при запуске через `ssh 'bash -s' < скрипт` шаги выполняются
# до конца, но хвост вывода теряется («Connection reset by peer»), и понять, чем всё кончилось, нельзя.
#
# Скрипт идемпотентен: повторный запуск ничего не ломает и не переустанавливает уже стоящее.
# Код сюда НЕ клонируется: репозиторий приватный, а deploy-ключи GitHub — лишняя сущность в цепочке
# доверия. Файлы приезжают rsync-ом из локальной копии (deploy/deploy.sh) — см. deploy/README.md.
set -euo pipefail

APP_DIR=/opt/dogovorilis
BACKUP_DIR=/opt/backups

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
  echo "Запускайте от root: sudo bash bootstrap-server.sh" >&2
  exit 1
fi

say "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg rsync ufw

say "Docker Engine + compose-plugin (официальная инструкция Docker)"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "Docker уже установлен: $(docker --version)"
fi
docker compose version >/dev/null || {
  echo "compose-plugin не установился" >&2
  exit 1
}

say "Файрвол: 22, 80, 443"
# Порт 443 обязателен: webhook MAX ходит только на 443 (CONTRACTS §1.3), вебхук ЮKassa — на 443/8443 (§2.5).
# 80 нужен Caddy для ACME-проверки Let's Encrypt. Порт Postgres наружу не открывается никогда.
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status verbose | sed 's/^/    /'

say "SSH: только по ключу"
# Timeweb присылает пароль root на почту — при создании сервера через API отключить его нельзя
# (тумблер есть только в панели). Пароль root, доступный из интернета, — это дыра, которую надо закрыть.
#
# Порядок важен: закрываем пароль ТОЛЬКО убедившись, что вход по ключу работает, иначе запрём себя.
# Признак: этот скрипт сейчас выполняется по SSH, и подключение аутентифицировано публичным ключом.
SSHD_DROPIN=/etc/ssh/sshd_config.d/99-dogovorilis.conf
if [[ -z "${SSH_CONNECTION:-}" ]]; then
  echo "    пропускаю: скрипт запущен не по SSH, проверить вход по ключу нечем"
elif [[ ! -s /root/.ssh/authorized_keys ]]; then
  echo "    ПРОПУСКАЮ: /root/.ssh/authorized_keys пуст — отключать пароль нельзя" >&2
else
  mkdir -p /etc/ssh/sshd_config.d
  cat >"$SSHD_DROPIN" <<'SSHD'
# Управляется deploy/bootstrap-server.sh. Вход только по ключу: пароль root от Timeweb приходит
# на почту и подбирается ботами круглосуточно.
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
SSHD
  # Битый конфиг оставил бы сервер без SSH вообще — проверяем до применения и откатываем при ошибке.
  if sshd -t 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    echo "    вход по паролю отключён (ключей в authorized_keys: $(grep -c '^ssh-' /root/.ssh/authorized_keys))"
  else
    rm -f "$SSHD_DROPIN"
    echo "    ОШИБКА: sshd -t отверг конфигурацию, настройки не применены" >&2
  fi
fi

say "Каталоги"
mkdir -p "$APP_DIR" "$BACKUP_DIR"
chmod 700 "$APP_DIR" "$BACKUP_DIR" # в APP_DIR лежит .env с токеном бота и ключами ЮKassa

say "Ежесуточный бэкап базы в $BACKUP_DIR (03:20, хранить 7 дней)"
cat >/etc/cron.d/dogovorilis-backup <<'CRON'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
20 3 * * * root cd /opt/dogovorilis && docker compose exec -T db pg_dump -U "${POSTGRES_USER:-dogovorilis}" "${POSTGRES_DB:-dogovorilis}" | gzip > /opt/backups/dogovorilis-$(date +\%F).sql.gz && find /opt/backups -name 'dogovorilis-*.sql.gz' -mtime +7 -delete
CRON
chmod 0644 /etc/cron.d/dogovorilis-backup

if [[ -f "$APP_DIR/compose.yaml" && -f "$APP_DIR/.env" ]]; then
  say "Код и .env уже на месте — поднимаю прод-профиль"
  cd "$APP_DIR"
  docker compose --profile prod up -d --build
  docker compose ps
else
  say "Готово. Следующий шаг — с рабочей машины:"
  cat <<'NEXT'
    1) положите .env на сервер:   scp -i ~/.ssh/dogovorilis_vps ../.env.server root@<IP>:/opt/dogovorilis/.env
    2) выкатите код и поднимите:  bash deploy/deploy.sh
  Подробности и диагностика — deploy/README.md.
NEXT
fi
