# Один образ: сервер (бот + API + планировщик) и собранное мини-приложение.
# Сборка ≤ 5 минут без учёта скачивания базовых образов (регламент). Замер — README §«Запуск».
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY webapp/package.json webapp/
RUN npm ci --no-audit --no-fund
COPY . .
# Ник бота попадает в бандл мини-приложения при сборке: без MAX Bridge (обычный браузер) спросить его
# у API нечем, а экран W0 должен давать ссылку на бота. Значение — из compose (MAX_BOT_USERNAME).
ARG VITE_BOT_USERNAME=""
ENV VITE_BOT_USERNAME=$VITE_BOT_USERNAME
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Корневой сертификат Минцифры нужен для platform-api2.max.ru и securepay.tinkoff.ru (docs/CONTRACTS.md §1.13, §3.11).
# Файл кладётся в certs/ (см. certs/README.md); если его нет — переменная просто указывает на пустой файл.
ENV NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_bundle.pem
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/migrations ./server/migrations
# Логотип для шапки квитанции PDF (DESIGN_BRIEF §7, §8); без него квитанция собирается, но без логотипа.
COPY --from=build /app/server/assets ./server/assets
COPY --from=build /app/webapp/dist ./webapp/dist
COPY --from=build /app/certs ./certs
EXPOSE 8080
USER node
CMD ["node", "server/dist/index.js"]
