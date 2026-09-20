# syntax=docker/dockerfile:1

# --- Стадия 1: сборка Angular-клиента ---
FROM node:20-alpine AS client-build
WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build -- --output-path dist/browser

# --- Стадия 2: сборка Express-сервера ---
FROM node:20-alpine AS server-build
WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/ ./
RUN npm run build

# --- Стадия 3: рантайм-образ ---
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DOWNLOAD_DIR=/app/server/downloads \
    STATE_FILE=/app/server/data/state.json \
    STATIC_ROOT=/app/client/dist

WORKDIR /app/server

COPY --from=server-build /app/server/package.json /app/server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server-build /app/server/dist ./dist
COPY --from=client-build /app/client/dist /app/client/dist

RUN mkdir -p /app/server/downloads /app/server/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
