#!/usr/bin/env bash
#
# reboot_run.sh — restart the running stack (no git pull / rebuild).
#
# Triggered by the host watcher when the in-app "Reboot" button drops the
# .update/reboot trigger file. Unlike update_run.sh it neither fetches from git
# nor rebuilds images — it just restarts the existing containers. Runs on the
# host (via systemd) so it survives the backend container going down.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Restarting containers..."
docker compose restart

echo "==> Done. Container status:"
docker compose ps
