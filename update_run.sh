#!/usr/bin/env bash
#
# update_run.sh — rapid update & relaunch for a remote server.
# Fetches the latest main, then rebuilds and restarts the stack.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Updating main from git..."
git fetch origin main
git checkout main
git reset --hard origin/main

echo "==> Stopping running containers..."
docker compose down

echo "==> Building and starting containers..."
docker compose up -d --build

echo "==> Done. Container status:"
docker compose ps
