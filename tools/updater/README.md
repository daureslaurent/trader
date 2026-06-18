# tools/updater — host self-update watcher

Lets the **Settings → System → "Update app"** button update the whole stack
(git pull + `docker compose down/up --build`) even though the backend runs inside
a container that the update tears down and rebuilds.

## How it works

```
Browser ──POST /api/host/update──▶ backend ──writes──▶ <repo>/.update/trigger
                                                              │ (bind mount)
                                                              ▼
                                              systemd cryptobot-update.path
                                                              │ file appeared
                                                              ▼
                                              cryptobot-update.service
                                                  rm trigger → update_run.sh
```

The backend **never** runs docker or git and the Docker socket is **not** mounted
into it — it only drops a trigger file into the bind-mounted `./.update`
directory. A host-side systemd `.path` unit watches that file and runs
`update_run.sh` on the host, so the update survives `docker compose down`.

The frontend shows an "Updating…" overlay that polls the API and reloads the page
once the rebuilt stack is back up.

## Update *checking* (the sidebar pin)

A second, read-only path tells the app **whether** an update exists, so the
**System** page can show a pin and list the commits ahead:

```
backend (hourly / "Check now") ──writes──▶ <repo>/.update/check   (trigger)
                                                   │ (bind mount)
                                                   ▼
                                   systemd cryptobot-update-check.path
                                                   │ file appeared
                                                   ▼
                                   cryptobot-update-check.service
                                       rm check → check_run.sh
                                                   │
                              git fetch origin main + compare HEAD..origin/main
                                                   ▼
                                  writes <repo>/.update/status.json ──▶ backend reads it
```

`check_run.sh` never rebuilds anything; it only fetches and writes `status.json`
(current/remote sha, how many commits ahead, and each commit's author/subject,
base64-encoded so arbitrary commit text can't break the JSON). The backend reads
it back to drive the pin, the commits-ahead modal, a Telegram notification, and a
live toast. The check interval is set in **Settings → System** (default 1 hour).

## Rebooting (restart without updating)

The **System** page also has a **Reboot** button that restarts the running stack
*without* pulling or rebuilding:

```
Browser ──POST /api/host/reboot──▶ backend ──writes──▶ <repo>/.update/reboot
                                                              │ (bind mount)
                                                              ▼
                                              systemd cryptobot-reboot.path
                                                              │ file appeared
                                                              ▼
                                              cryptobot-reboot.service
                                                  rm reboot → reboot_run.sh
                                                              │
                                                  docker compose restart
```

`reboot_run.sh` only runs `docker compose restart` — it keeps the current code
and images. Same trust boundary as updates: gated by the `update_enabled` setting
and the host bridge. The frontend shows the same "back online" overlay and reloads
once the stack returns.

## Install (on the host, once)

```bash
sudo tools/updater/install-updater.sh
```

This resolves the repo path automatically, installs **both** unit pairs (update +
update-check) to run as the repo's owner (must be in the `docker` group), creates
`./.update`, and enables the watchers. Then turn on **Settings → System → Enable
app updates**. (Existing installs must re-run this to get the update-check units.)

## Uninstall

```bash
sudo tools/updater/uninstall-updater.sh
```

## Notes / troubleshooting

- The `update_enabled` setting (off by default) gates the API endpoint, so the
  button does nothing unless explicitly enabled.
- `docker-compose.yml` bind-mounts `./.update` into the backend. If that mount is
  missing the backend reports the bridge as "not ready" and the button is
  disabled with a hint.
- Update output is appended to `./.update/update.log` and also visible via
  `journalctl -u cryptobot-update.service` (or `…-update-check.service`).
- Trigger a manual update for testing: `touch ./.update/trigger`.
- Trigger a manual check for testing: `touch ./.update/check` → inspect
  `./.update/status.json`.
- Trigger a manual reboot for testing: `touch ./.update/reboot`.
