#!/usr/bin/env bash
# Запуск Twonky Grabber в Docker.
# Скачанные файлы и состояние монтируются из каталогов ./downloads и ./data
# (bind volume) — они остаются на хосте и переживают пересоздание контейнера.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-twonky-grabber}"
PORT="${PORT:-3000}"

mkdir -p "$SCRIPT_DIR/downloads" "$SCRIPT_DIR/data"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Образ $IMAGE не найден — собираю..."
    docker build -t "$IMAGE" "$SCRIPT_DIR"
fi

echo "Запуск $IMAGE на http://localhost:$PORT"
echo "Загрузки: $SCRIPT_DIR/downloads"
echo "Состояние: $SCRIPT_DIR/data"

docker run --rm \
    -p "${PORT}:3000" \
    -v "$SCRIPT_DIR/downloads:/app/server/downloads" \
    -v "$SCRIPT_DIR/data:/app/server/data" \
    "$IMAGE"
