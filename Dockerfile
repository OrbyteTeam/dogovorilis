# Один образ: сервер (бот + API + планировщик) и собранное мини-приложение.
# Сборка ≤ 5 минут без учёта скачивания базовых образов (регламент). Замер — README §«Запуск».
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY webapp/package.json webapp/
RUN npm ci --no-audit --no-fund
COPY . .
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
COPY --from=build /app/webapp/dist ./webapp/dist
COPY --from=build /app/certs ./certs
EXPOSE 8080
USER node
CMD ["node", "server/dist/index.js"]
