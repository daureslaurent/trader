#!/usr/bin/env bash
#
# install-updater.sh — install the host-side self-update watcher (systemd).
#
# The backend runs in a container and cannot tear down + rebuild its own stack.
# Instead, the "Update app" button drops a trigger file at <repo>/.update/trigger
# (bind-mounted into the backend). This installs a systemd `.path` unit that
# watches that file and runs update_run.sh on the host when it appears — so the
# update survives `docker compose down`. No Docker socket is exposed to the app.
#
# Usage:  sudo tools/updater/install-updater.sh
#
set -euo pipefail

# --- resolve repo root (parent of tools/) and the unprivileged owner ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "This installs system units and must run as root. Re-run with: sudo $0" >&2
  exit 1
fi

# The service must run as the human who owns the repo (so docker, git, and file
# perms behave the same as a manual run) — not root. Prefer the sudo invoker.
RUN_USER="${SUDO_USER:-$(stat -c '%U' "$REPO_DIR")}"
if [[ -z "$RUN_USER" || "$RUN_USER" == "root" ]]; then
  RUN_USER="$(stat -c '%U' "$REPO_DIR")"
fi

UPDATE_SCRIPT="$REPO_DIR/update_run.sh"
CHECK_SCRIPT="$REPO_DIR/check_run.sh"
REBOOT_SCRIPT="$REPO_DIR/reboot_run.sh"
TRIGGER_DIR="$REPO_DIR/.update"
TRIGGER_FILE="$TRIGGER_DIR/trigger"
CHECK_TRIGGER_FILE="$TRIGGER_DIR/check"
REBOOT_TRIGGER_FILE="$TRIGGER_DIR/reboot"
LOG_FILE="$TRIGGER_DIR/update.log"

if [[ ! -x "$UPDATE_SCRIPT" ]]; then
  echo "update_run.sh not found or not executable at $UPDATE_SCRIPT" >&2
  exit 1
fi

if [[ ! -f "$REBOOT_SCRIPT" ]]; then
  echo "reboot_run.sh not found at $REBOOT_SCRIPT" >&2
  exit 1
fi
# The reboot script ships in the repo; make sure it's executable on the host.
chmod +x "$REBOOT_SCRIPT" 2>/dev/null || true

if [[ ! -f "$CHECK_SCRIPT" ]]; then
  echo "check_run.sh not found at $CHECK_SCRIPT" >&2
  exit 1
fi
# The check script ships in the repo; make sure it's executable on the host.
chmod +x "$CHECK_SCRIPT" 2>/dev/null || true

echo "==> Repo:        $REPO_DIR"
echo "==> Run user:    $RUN_USER"
echo "==> Trigger:     $TRIGGER_FILE"

# The trigger dir is bind-mounted into the backend, so it must exist and be
# writable by the container user before docker starts. Create it now, owned by
# the run user.
install -d -o "$RUN_USER" -g "$RUN_USER" "$TRIGGER_DIR"

# Warn (don't fail) if the run user can't reach docker — the update would fail at
# run time otherwise, and this is the most common misconfiguration.
if ! id -nG "$RUN_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "WARNING: user '$RUN_USER' is not in the 'docker' group; update_run.sh may fail." >&2
  echo "         Fix with: sudo usermod -aG docker $RUN_USER  (then re-login)" >&2
fi

SERVICE=/etc/systemd/system/cryptobot-update.service
PATH_UNIT=/etc/systemd/system/cryptobot-update.path

# --- the oneshot service that performs the update -----------------------------
# ExecStartPre removes the trigger first so the .path unit re-arms and a failed
# run can't loop. The update itself runs on the host, independent of Docker.
cat > "$SERVICE" <<EOF
[Unit]
Description=cryptoBot self-update (git pull + docker compose rebuild/restart)
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$REPO_DIR
ExecStartPre=/bin/rm -f $TRIGGER_FILE
ExecStart=/usr/bin/env bash $UPDATE_SCRIPT
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE
TimeoutStartSec=1800
EOF

# --- the path unit that watches for the trigger -------------------------------
# PathExists is level-triggered: the service starts whenever the file is present,
# and re-arms once the service removes it.
cat > "$PATH_UNIT" <<EOF
[Unit]
Description=Watch for cryptoBot update trigger

[Path]
PathExists=$TRIGGER_FILE
Unit=cryptobot-update.service

[Install]
WantedBy=multi-user.target
EOF

echo "==> Wrote $SERVICE"
echo "==> Wrote $PATH_UNIT"

CHECK_SERVICE=/etc/systemd/system/cryptobot-update-check.service
CHECK_PATH_UNIT=/etc/systemd/system/cryptobot-update-check.path

# --- the oneshot service that runs a read-only update check -------------------
# check_run.sh only does `git fetch` + writes .update/status.json — it never
# rebuilds anything. ExecStartPre removes the trigger so the .path unit re-arms.
cat > "$CHECK_SERVICE" <<EOF
[Unit]
Description=cryptoBot update check (git fetch + write status.json)

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$REPO_DIR
ExecStartPre=/bin/rm -f $CHECK_TRIGGER_FILE
ExecStart=/usr/bin/env bash $CHECK_SCRIPT
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE
TimeoutStartSec=120
EOF

# --- the path unit that watches for the check trigger -------------------------
cat > "$CHECK_PATH_UNIT" <<EOF
[Unit]
Description=Watch for cryptoBot update-check trigger

[Path]
PathExists=$CHECK_TRIGGER_FILE
Unit=cryptobot-update-check.service

[Install]
WantedBy=multi-user.target
EOF

echo "==> Wrote $CHECK_SERVICE"
echo "==> Wrote $CHECK_PATH_UNIT"

REBOOT_SERVICE=/etc/systemd/system/cryptobot-reboot.service
REBOOT_PATH_UNIT=/etc/systemd/system/cryptobot-reboot.path

# --- the oneshot service that restarts the stack -----------------------------
# reboot_run.sh only runs `docker compose restart` — it never pulls or rebuilds.
# ExecStartPre removes the trigger so the .path unit re-arms after each restart.
cat > "$REBOOT_SERVICE" <<EOF
[Unit]
Description=cryptoBot stack restart (docker compose restart)
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$REPO_DIR
ExecStartPre=/bin/rm -f $REBOOT_TRIGGER_FILE
ExecStart=/usr/bin/env bash $REBOOT_SCRIPT
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE
TimeoutStartSec=600
EOF

# --- the path unit that watches for the reboot trigger ------------------------
cat > "$REBOOT_PATH_UNIT" <<EOF
[Unit]
Description=Watch for cryptoBot reboot trigger

[Path]
PathExists=$REBOOT_TRIGGER_FILE
Unit=cryptobot-reboot.service

[Install]
WantedBy=multi-user.target
EOF

echo "==> Wrote $REBOOT_SERVICE"
echo "==> Wrote $REBOOT_PATH_UNIT"

systemctl daemon-reload
systemctl enable --now cryptobot-update.path
systemctl enable --now cryptobot-update-check.path
systemctl enable --now cryptobot-reboot.path

echo "==> Installed and watching. Status:"
systemctl --no-pager status cryptobot-update.path || true
systemctl --no-pager status cryptobot-update-check.path || true
systemctl --no-pager status cryptobot-reboot.path || true
echo
echo "Done. Enable the toggle in Settings → System; the app then checks for"
echo "updates periodically and 'Update app' (on the System page) applies them."
echo "Update logs: $LOG_FILE   (or: journalctl -u cryptobot-update.service)"
