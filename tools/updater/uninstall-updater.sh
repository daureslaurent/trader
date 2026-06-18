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
CHECK_SERVICE=/etc/systemd/system/cryptobot-update-check.service
CHECK_PATH_UNIT=/etc/systemd/system/cryptobot-update-check.path
REBOOT_SERVICE=/etc/systemd/system/cryptobot-reboot.service
REBOOT_PATH_UNIT=/etc/systemd/system/cryptobot-reboot.path

echo "==> Disabling and stopping units..."
systemctl disable --now cryptobot-update.path 2>/dev/null || true
systemctl disable --now cryptobot-update-check.path 2>/dev/null || true
systemctl disable --now cryptobot-reboot.path 2>/dev/null || true
systemctl stop cryptobot-update.service 2>/dev/null || true
systemctl stop cryptobot-update-check.service 2>/dev/null || true
systemctl stop cryptobot-reboot.service 2>/dev/null || true

rm -f "$PATH_UNIT" "$SERVICE" "$CHECK_PATH_UNIT" "$CHECK_SERVICE" "$REBOOT_PATH_UNIT" "$REBOOT_SERVICE"

systemctl daemon-reload
systemctl reset-failed cryptobot-update.service 2>/dev/null || true
systemctl reset-failed cryptobot-update-check.service 2>/dev/null || true
systemctl reset-failed cryptobot-reboot.service 2>/dev/null || true

echo "==> Removed $PATH_UNIT / $SERVICE"
echo "==> Removed $CHECK_PATH_UNIT / $CHECK_SERVICE"
echo "==> Removed $REBOOT_PATH_UNIT / $REBOOT_SERVICE"
echo "Done. The watcher is uninstalled; the in-app button will no longer have any effect."
