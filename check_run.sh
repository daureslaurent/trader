#!/usr/bin/env bash
#
# check_run.sh — read-only update check for the host watcher.
#
# The backend can't run git (it's in a container), so it drops a `.update/check`
# trigger; a systemd .path unit runs this script on the host. We fetch origin/main,
# compare it to the deployed checkout (HEAD), and write the result to
# .update/status.json — which is bind-mounted into the backend and read back to
# drive the "update available" pin and the commits-ahead modal.
#
# Author/subject are base64-encoded so arbitrary commit text can never break the
# JSON; the backend decodes them. On any failure we still write a valid status.json
# carrying an "error" field, so the watcher never loops on a bad run.
set -uo pipefail

cd "$(dirname "$0")"

STATUS=".update/status.json"
TMP=".update/status.json.$$.tmp"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p .update

write_error() {
  printf '{"checkedAt":"%s","currentSha":"","currentShortSha":"","remoteSha":"","remoteShortSha":"","branch":"main","behindBy":0,"commits":[],"error":"%s"}\n' \
    "$NOW" "$1" > "$TMP"
  mv -f "$TMP" "$STATUS"
}

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  write_error "not a git repository"
  exit 0
fi

if ! git fetch --quiet origin main 2>/dev/null; then
  write_error "git fetch origin main failed"
  exit 0
fi

CUR="$(git rev-parse HEAD 2>/dev/null)"
CURS="$(git rev-parse --short HEAD 2>/dev/null)"
REM="$(git rev-parse origin/main 2>/dev/null)"
REMS="$(git rev-parse --short origin/main 2>/dev/null)"
COUNT="$(git rev-list --count HEAD..origin/main 2>/dev/null)"
[[ "$COUNT" =~ ^[0-9]+$ ]] || COUNT=0

# Build the commits-ahead JSON array. Fields are separated by US (0x1f) and records
# by RS (0x1e); author + subject are base64-encoded (no -w wrapping) to avoid any
# JSON-escaping concerns. shas/dates are inherently JSON-safe.
commits_json=""
if [[ "$COUNT" -gt 0 ]]; then
  while IFS=$'\x1f' read -r -d $'\x1e' H SH DATE AUTH SUBJ; do
    # git separates records with a newline; strip the one that leaks into the sha.
    H="${H#$'\n'}"
    [[ -z "$H" ]] && continue
    a="$(printf '%s' "$AUTH" | base64 | tr -d '\n')"
    s="$(printf '%s' "$SUBJ" | base64 | tr -d '\n')"
    item="{\"sha\":\"$H\",\"shortSha\":\"$SH\",\"date\":\"$DATE\",\"authorB64\":\"$a\",\"subjectB64\":\"$s\"}"
    commits_json="${commits_json:+$commits_json,}$item"
  done < <(git log HEAD..origin/main --pretty=format:'%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1e')
fi

printf '{"checkedAt":"%s","currentSha":"%s","currentShortSha":"%s","remoteSha":"%s","remoteShortSha":"%s","branch":"main","behindBy":%s,"commits":[%s]}\n' \
  "$NOW" "$CUR" "$CURS" "$REM" "$REMS" "$COUNT" "$commits_json" > "$TMP"
mv -f "$TMP" "$STATUS"

echo "==> Update check done: $COUNT commit(s) ahead ($CURS -> $REMS)"
