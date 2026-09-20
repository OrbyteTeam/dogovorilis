# certs/

Сюда кладётся `russian_trusted_bundle.pem` — корневой и промежуточный сертификаты Национального УЦ Минцифры
(«Russian Trusted Root CA» + «Russian Trusted Sub CA») в формате PEM, склеенные в один файл.

Зачем: `platform-api2.max.ru` (Bot API) и `securepay.tinkoff.ru` (Т-Банк) предъявляют сертификаты этого УЦ;
Node.js по умолчанию им не доверяет. Docker-образ запускает Node с `NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_bundle.pem`
(см. `Dockerfile`, `docs/CONTRACTS.md` §1.13 и §3.11).

Откуда взять: официальная страница Госуслуг «Сертификаты Минцифры» https://www.gosuslugi.ru/crt — скачать
корневой (`russian_trusted_root_ca_pem.crt`) и выпускающий (`russian_trusted_sub_ca_pem.crt`) сертификаты в PEM
и объединить: `cat russian_trusted_root_ca_pem.crt russian_trusted_sub_ca_pem.crt > certs/russian_trusted_bundle.pem`.

Это публичные сертификаты, их можно коммитить. Приватных ключей в этой папке быть не должно.
Файл `.keep` нужен, чтобы папка существовала в образе, даже если PEM ещё не добавлен.
