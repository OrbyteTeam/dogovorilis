# Runbook: сервер «Договорились»

Всё, что нужно, чтобы развернуть, обновить, починить и откатить решение на VPS.
Рассчитано на то, что читает его человек, который сервер не поднимал.

**Сервер обязан быть доступен непрерывно весь период проверки.** Падение хостинга в эти дни
равно нулю за работоспособность.

---

## 0. Что где лежит

| Что | Где |
|---|---|
| Код и `compose.yaml` | `/opt/dogovorilis` на сервере |
| Секреты (`.env`) | `/opt/dogovorilis/.env` — **только там**, в git не попадает, rsync его не трогает |
| Бэкапы БД | `/opt/backups/dogovorilis-ГГГГ-ММ-ДД.sql.gz`, cron в 03:20, хранятся 7 дней |
| Данные Postgres | docker-том `dogovorilis_pgdata` |
| Сертификаты Let's Encrypt | docker-том `dogovorilis_caddy_data` |
| Приватный ключ SSH | на рабочей машине: `~/.ssh/dogovorilis_vps` |
| Параметры сервера | `../VPS.md` рядом с репозиторием (вне git) |

---

## 1. Первый деплой

Предусловия: сервер Ubuntu 24.04, в панели хостинга добавлен публичный ключ из
`../VPS_SSH_PUBLIC_KEY.txt`, A-запись домена указывает на IP сервера.

```bash
# 1. Подготовить сервер (один раз): Docker, ufw, каталоги, cron бэкапа
ssh -i ~/.ssh/dogovorilis_vps root@<IP> 'bash -s' < deploy/bootstrap-server.sh

# 2. Положить секреты (один раз). Файл готовится локально, см. ../.env.server
scp -i ~/.ssh/dogovorilis_vps ../.env.server root@<IP>:/opt/dogovorilis/.env

# 3. Выкатить код и поднять
bash deploy/deploy.sh
```

Первый запуск дольше обычного: Caddy выпускает сертификат Let's Encrypt. Это десятки секунд.
Если A-запись ещё не разошлась — сертификат не выпустится, и `https://` не ответит. Это нормально,
повторите `bash deploy/deploy.sh` через несколько минут.

### Что проверить сразу после

```bash
curl -fsS  https://<домен>/healthz          # {"ok":true,...}
curl -sS   https://<домен>/readyz           # {"ok":true,"db":true,"bot":true}
curl -fsSI https://<домен>/app/             # HTTP 200, мини-приложение отдаётся
curl -vI   https://<домен>/healthz 2>&1 | grep -i 'issuer\|subject'   # сертификат доверенный
```
И главное — написать боту `/start` в MAX. Если бот молчит, см. §5.

---

## 2. Обновление

```bash
bash deploy/deploy.sh
```
Скрипт синхронизирует файлы (`rsync --delete`), пересобирает образ и поднимает контейнеры.
Миграции применяются сами при старте процесса (`server/src/db/migrate.ts`), отдельной команды нет.

`deploy.sh --check` — только проверки, ничего не меняет.

---

## 3. Логи

```bash
ssh -i ~/.ssh/dogovorilis_vps root@<IP>
cd /opt/dogovorilis
docker compose logs -f app          # приложение (pino JSON)
docker compose logs -f caddy        # HTTPS и сертификаты
docker compose logs --tail=200 db
docker compose ps                   # кто жив
```
Логи в формате JSON; читать глазами удобнее так:
```bash
docker compose logs --tail=200 app | sed 's/^app-1  | //' | jq -r '"\(.level) \(.msg) \(. | del(.level,.msg,.time,.svc))"'
```

---

## 4. Откат

Версия — это тег в git. Откат = выкатить старый тег.

```bash
git checkout v0.1-skeleton     # или нужный тег / коммит
bash deploy/deploy.sh
git checkout -                 # вернуться на рабочую ветку
```
Какой коммит сейчас на сервере:
```bash
ssh -i ~/.ssh/dogovorilis_vps root@<IP> 'cat /opt/dogovorilis/.deployed-commit'
```

**Откат не возвращает схему БД назад.** Миграции пишутся только вперёд; если откат нужен вместе
с данными — восстанавливайте из бэкапа (§6).

---

## 5. Бот молчит — что делать

Идти сверху вниз, не перескакивая.

1. **Процесс жив?** `docker compose ps` и `curl https://<домен>/healthz`.
   Нет — `docker compose logs --tail=100 app`, там будет причина (чаще всего конфиг или БД).
2. **БД и бот готовы?** `curl https://<домен>/readyz` → ждём `{"ok":true,"db":true,"bot":true}`.
   `bot:false` — процесс поднялся, но бот не инициализировался: смотрите лог на `GET /me`.
3. **Подписка на месте?** Самая частая причина молчания: кто-то запустил второй экземпляр
   с тем же токеном в режиме `polling` — SDK при старте polling **удаляет все webhook-подписки**
   (CONTRACTS §1.3). Проверка:
   ```bash
   curl -s "https://platform-api2.max.ru/subscriptions?access_token=<MAX_BOT_TOKEN>"
   ```
   В ответе должен быть наш `https://<домен>/webhooks/max`. Нет — остановите локальный бот
   и перезапустите сервис: `docker compose restart app` (подписка ставится при старте).
4. **Сертификат.** MAX не принимает самоподписанные сертификаты и требует порт 443.
   `curl -vI https://<домен>/healthz` — цепочка должна быть от Let's Encrypt.
   Проблемы с выпуском — `docker compose logs caddy`, чаще всего дело в A-записи или закрытом 80.
5. **MAX отписался сам.** Если бот 8 часов не отвечал на доставку, MAX снимает подписку
   (CONTRACTS §1.3). Лечится перезапуском `app`.
6. **Секрет.** Запрос без заголовка `X-Max-Bot-Api-Secret` получает 404 — это норма.
   Если `MAX_WEBHOOK_SECRET` в `.env` разошёлся с тем, что зарегистрировано у MAX,
   все доставки будут получать 404: перезапустите `app`, он перерегистрирует подписку.

### Платежи не подтверждаются

- `webhook_log` — журнал доставок: `result = ok | ignored:… | error:…`.
  ```bash
  docker compose exec -T db psql -U dogovorilis -d dogovorilis \
    -c "select id, provider, event, result, received_at from webhook_log order by id desc limit 20;"
  ```
- Пусто — уведомления не доходят: проверьте URL в ЛК тестового магазина ЮKassa
  (`https://<домен>/webhooks/yookassa`, события `payment.succeeded` и `payment.canceled`).
- Даже без вебхука оплата подтвердится: планировщик опрашивает провайдера раз в 60 с,
  плюс у клиента есть кнопка «🔄 Проверить оплату». Если не подтверждается и так — смотрите
  в логе `warn` с `provider: yookassa`.

---

## 6. Бэкап и восстановление

Бэкап делает cron (`/etc/cron.d/dogovorilis-backup`) каждый день в 03:20, хранит 7 дней.

Снять прямо сейчас:
```bash
cd /opt/dogovorilis
docker compose exec -T db pg_dump -U dogovorilis dogovorilis | gzip > /opt/backups/manual-$(date +%F-%H%M).sql.gz
```

Восстановить (данные текущей базы будут заменены):
```bash
cd /opt/dogovorilis
docker compose stop app
gunzip -c /opt/backups/dogovorilis-ГГГГ-ММ-ДД.sql.gz | docker compose exec -T db psql -U dogovorilis -d dogovorilis
docker compose start app
```

Забрать бэкап к себе:
```bash
scp -i ~/.ssh/dogovorilis_vps root@<IP>:/opt/backups/dogovorilis-*.sql.gz ./
```

---

## 7. Docker Hub не отвечает

Скачивание базовых образов (`node:22-alpine`, `postgres:16-alpine`, `caddy:2-alpine`) с `registry-1.docker.io`
периодически отваливается по `TLS handshake timeout` — наблюдалось 21.09.2026 с рабочей машины, повторный
`docker pull` проходил. На сервере в Москве может быть так же или хуже.

Что делать:
1. Повторить: `docker pull caddy:2-alpine && docker pull postgres:16-alpine && docker pull node:22-alpine`.
   Чаще всего срабатывает со второго-третьего раза.
2. Если не проходит совсем — прописать зеркало в `/etc/docker/daemon.json` и перезапустить Docker:
   ```json
   { "registry-mirrors": ["https://mirror.gcr.io"] }
   ```
   ```bash
   systemctl restart docker
   ```
3. Крайний случай — перенести образы с рабочей машины:
   ```bash
   docker save node:22-alpine postgres:16-alpine caddy:2-alpine | gzip > images.tgz
   scp -i ~/.ssh/dogovorilis_vps images.tgz root@<IP>:/tmp/
   ssh -i ~/.ssh/dogovorilis_vps root@<IP> 'gunzip -c /tmp/images.tgz | docker load'
   ```

Образы уже скачанные на сервере переживают перезапуск и пересборку, так что проблема разовая —
но встретить её лучше до дня проверки, а не в день проверки.

---

## 8. Чего нельзя делать

- **Запускать второй экземпляр с тем же токеном.** Локальный `docker compose up` с `MAX_MODE=polling`
  убьёт webhook-подписку сервера, и бот в MAX замолчит. Для локальной работы над кодом —
  `MAX_MODE=off`, для локальной проверки в MAX — сначала остановить сервер.
- **Класть `.env`, `VPS.md` или приватный ключ в git.** Проверка — `npm run check:secrets`.
- **Открывать наружу порт Postgres.** `ufw` разрешает только 22, 80, 443.
- **Править файлы прямо на сервере.** Следующий `deploy.sh` с `--delete` их сотрёт. Правьте в git.
