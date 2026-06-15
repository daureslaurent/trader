#!/usr/bin/env bash
#
# uninstall-updater.sh — remove the host-side self-update watcher (systemd).
#
# Stops and deletes the units installed by install-updater.sh. Leaves the repo
# and the .update/ directory untouched.
#
# Usage:  sudo tools/updater/uninstall-updater.sh
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This removes system units and must run as root. Re-run with: sudo $0" >&2
  exit 1
fi

SERVICE=/etc/systemd/system/cryptobot-update.service
PATH_UNIT=/etc/systemd/system/cryptobot-update.path

echo "==> Disabling and stopping units..."
systemctl disable --now cryptobot-update.path 2>/dev/null || true
systemctl stop cryptobot-update.service 2>/dev/null || true

rm -f "$PATH_UNIT" "$SERVICE"

systemctl daemon-reload
systemctl reset-failed cryptobot-update.service 2>/dev/null || true

echo "==> Removed $PATH_UNIT"
echo "==> Removed $SERVICE"
echo "Done. The watcher is uninstalled; the in-app button will no longer have any effect."
