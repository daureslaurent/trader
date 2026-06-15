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

## Install (on the host, once)

```bash
sudo tools/updater/install-updater.sh
```

This resolves the repo path automatically, installs the units to run as the
repo's owner (must be in the `docker` group), creates `./.update`, and enables
the watcher. Then turn on **Settings → System → Enable app updates**.

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
  `journalctl -u cryptobot-update.service`.
- Trigger a manual update for testing: `touch ./.update/trigger`.
