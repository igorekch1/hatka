FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/radar.db \
    TZ=Europe/Kyiv

RUN apk add --no-cache tzdata

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts

VOLUME ["/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
