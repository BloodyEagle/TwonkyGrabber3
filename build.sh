#!/usr/bin/env bash
# Сборка Docker-образа Twonky Grabber.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-twonky-grabber}"

docker build -t "$IMAGE" "$SCRIPT_DIR"
echo "Образ $IMAGE собран."
