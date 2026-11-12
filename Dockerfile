# Node 22 (Debian slim). Нативные сборки зависимостей не нужны — см. --ignore-scripts ниже
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/radar.db \
    TZ=Europe/Kyiv

COPY package.json package-lock.json ./
# --ignore-scripts: не собирать нативные bufferutil/utf-8-validate (ускорители WebSocket,
# gramjs в Node ходит по TCP и без них работает; сборке нужен python и компилятор)
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

COPY src ./src
COPY scripts ./scripts

VOLUME ["/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
