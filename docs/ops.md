# Operations & Infrastructure Runbook

Production guide for running, deploying, monitoring, and maintaining SeatSniper on an Oracle Cloud VPS (`x86_64` or Ampere A1 `arm64`) or any Linux/Docker host.

---

## 1. Runtime & Deployment Modes

> **Linux Runtime Pin (`Bun 1.4.2`):** Keep Linux hosts and containers pinned to **Bun `1.4.2`** (`oven/bun:1.4.2` or `bun-v1.4.2`). Bun `1.4.3` and `1.4.4` introduced a Linux regression (`oven-sh/bun#44982`) where native `koffi` FFI calls (`node-tls-client`) followed by garbage collection can freeze the event loop.

### Option A — `systemd --user` on Oracle VPS (Recommended)

Runs under the unprivileged `ubuntu` user with automatic crash recovery, `400M` memory cap, `SIGTERM` poll-drain budget, and persistent log output:

```bash
# 1. Install Bun 1.4.2 + clone + configure .env + register slash commands
curl -fsSL https://raw.githubusercontent.com/Ishannaik/seatsniper/main/install.sh | bash

# 2. Install & enable the systemd user unit (survives logout/reboot via linger)
mkdir -p ~/.config/systemd/user
cp ~/seatsniper/infra/systemd/seatsniper.service ~/.config/systemd/user/seatsniper.service
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now seatsniper.service
```

Common operations:

```bash
systemctl --user status seatsniper.service
systemctl --user restart seatsniper.service
tail -f ~/seatsniper/seatsniper.log
```

### Option B — `pm2` Process Supervisor (`install.sh` Default)

If `pm2` is installed (`npm i -g pm2`) and no `systemd --user` unit is enabled, `install.sh` registers SeatSniper under `pm2` with `--max-memory-restart 350M`:

```bash
pm2 status seatsniper
pm2 restart seatsniper --update-env
pm2 logs seatsniper --lines 50
```

### Option C — Docker Compose / GHCR Multi-Arch Container

[`Dockerfile`](../Dockerfile) and [`docker-compose.yml`](../docker-compose.yml) run as non-root `USER bun` with `init: true` (clean PID 1 `SIGTERM` forwarding), `512m` memory cap, `10m × 5` log rotation, and a poll-cycle `HEALTHCHECK`:

```bash
cp .env.example .env   # set DISCORD_TOKEN and DISCORD_CLIENT_ID
docker compose run --rm seatsniper bun run commands
docker compose up -d --build
docker inspect --format='{{json .State.Health}}' seatsniper
```

Prebuilt multi-arch (`linux/amd64` + `linux/arm64`) release images are published to `ghcr.io/ishannaik/seatsniper:<version>`.

---

## 2. Automated GitHub Actions Deployment (Oracle VPS)

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) deploys `main` pushes (and manual `workflow_dispatch` runs) to the Oracle VPS with serialized concurrency (`cancel-in-progress: false`). If `ORACLE_SSH_HOST` or `ORACLE_SSH_KEY` is unset, the workflow skips cleanly with a Step Summary notice.

### Repository Secrets

| Secret | Required | Default / Notes |
| :--- | :---: | :--- |
| `ORACLE_SSH_HOST` | **Yes** | Oracle VPS public IP, DNS hostname, or Tailscale IP |
| `ORACLE_SSH_KEY` | **Yes** | Dedicated Ed25519 private key (`~/.ssh/authorized_keys` on VPS) |
| `ORACLE_SSH_USER` | No | Defaults to `ubuntu` |
| `ORACLE_SSH_PORT` | No | Defaults to `22` |
| `ORACLE_SSH_KNOWN_HOSTS` | No | Optional pinned `ssh-keyscan` host key line |
| `ORACLE_APP_DIR` | No | Defaults to `/home/ubuntu/seatsniper` |
| `TS_OAUTH_CLIENT_ID` | No | Optional Tailscale OAuth client ID (for tailnet-only SSH) |
| `TS_OAUTH_SECRET` | No | Optional Tailscale OAuth secret (`tag:ci`) |

### One-Time Deploy Key Setup on Oracle VPS

```bash
ssh-keygen -t ed25519 -C "seatsniper-gha-deploy" -f ~/.ssh/seatsniper_deploy -N ""
cat ~/.ssh/seatsniper_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
cat ~/.ssh/seatsniper_deploy   # paste into GitHub Secret ORACLE_SSH_KEY, then rm ~/.ssh/seatsniper_deploy*
```

### What Every Deploy Executes

1. Runs `bun install --frozen-lockfile`, `bun run typecheck`, and `bun test` in GitHub Actions before connecting.
2. Records `PRE_DEPLOY_SHA` and backs up SQLite (`sqlite3 seatsniper.db ".timeout 5000" ".backup 'seatsniper.db.bak'"`).
3. Fast-forwards `/home/ubuntu/seatsniper` to the exact `GITHUB_SHA` and runs `bun install --frozen-lockfile`.
4. Runs `bun run commands` automatically whenever `src/commands.ts` or `src/register.ts` changed (or when `force_register_commands` is checked on `workflow_dispatch`).
5. Restarts the active supervisor (`systemd --user` `seatsniper.service`, `pm2`, or `docker compose`).
6. Waits `12s` and verifies the service stayed `active`/`online` with **zero crash restarts** and `gatewayReady != false` in `last_cycle.json`. On any failure, automatically rolls back to `PRE_DEPLOY_SHA` and restarts the previous known-good revision.

---

## 3. Health, Liveness & Anti-Zombie Monitoring

**Never judge bot health from `systemctl is-active`, `pm2 status = online`, or `docker ps = Up` alone.** A wedged event loop, exhausted disk, or dropped Discord WebSocket shard can leave the OS process alive while zero polls or alerts complete (`discord.js` `client.isReady()` also latches `true` after initial connect; SeatSniper checks live `client.ws.status === Status.Ready`).

### Three Layers of Liveness Verification

1. **Per-Cycle Liveness Snapshot (`last_cycle.json`):**
   At the end of every completed poll cycle (including idle ticks), `src/index.ts` atomically writes `last_cycle.json` alongside `seatsniper.db` (override via `LIVENESS_PATH`):
   ```json
   {"ok":true,"ts":1763452800000,"sec":6,"watches":4,"coalesced":2,"gatewayReady":true}
   ```
   Verify live freshness on the host:
   ```bash
   cat ~/seatsniper/last_cycle.json && stat -c '%y' ~/seatsniper/last_cycle.json
   ```

2. **In-Process Uptime Kuma Push (`UPTIME_KUMA_PUSH_URL`):**
   Set `UPTIME_KUMA_PUSH_URL=https://kuma.example.com/api/push/<TOKEN>` in `.env`. After each poll cycle, SeatSniper pushes `status=up` (or `status=down&msg=gateway_disconnected` if `client.ws.status !== Status.Ready`). Configure the Uptime Kuma Push monitor interval to `POLL_INTERVAL_SEC + 180` seconds (e.g. **`780s`** with `2` retries for the default `600s` poll interval).

3. **Out-of-Process Watchdog (`infra/kuma-heartbeat.sh` & Docker `HEALTHCHECK`):**
   - **Docker:** `Dockerfile` `HEALTHCHECK` inspects `last_cycle.json` every `60s` and marks the container `unhealthy` if `ts`/`mtime` exceeds `max(2.5 × POLL_INTERVAL_SEC, 300s)` or `gatewayReady === false`.
   - **Oracle VPS Cron:** [`infra/kuma-heartbeat.sh`](../infra/kuma-heartbeat.sh) independently checks process existence, `seatsniper.log` freshness, `last_cycle.json` age, and `gatewayReady` so even a hard-frozen runtime is reported `down`:
     ```bash
     chmod +x ~/seatsniper/infra/kuma-heartbeat.sh
     (crontab -l 2>/dev/null; echo "*/5 * * * * \$HOME/seatsniper/infra/kuma-heartbeat.sh") | crontab -
     ```

---

## 4. Log Rotation (Preventing Disk-Full Outages)

Unbounded append logs can fill an Oracle Cloud boot volume (`ENOSPC`) and stall SQLite WAL writes while leaving the daemon PID running. Install [`infra/logrotate/seatsniper`](../infra/logrotate/seatsniper) (`daily`, `maxsize 25M`, `rotate 7`, `compress`, `copytruncate`):

```bash
sudo cp ~/seatsniper/infra/logrotate/seatsniper /etc/logrotate.d/seatsniper
sudo chmod 0644 /etc/logrotate.d/seatsniper
sudo logrotate -d /etc/logrotate.d/seatsniper
```

Docker deployments enforce `10m × 5` JSON log rotation automatically in [`docker-compose.yml`](../docker-compose.yml).

---

## 5. SQLite WAL Operations, Backup & Cleanup

The bot keeps all persistent watch state in one SQLite file set by `DB_PATH` (see [`.env.example`](../.env.example)). A host install defaults to `seatsniper.db` in the working directory; [`docker-compose.yml`](../docker-compose.yml) sets `/data/seatsniper.db` inside the `seatsniper_data` volume. Run any manual SQL or backups below against that file.

SeatSniper opens SQLite (`src/db.ts`) with:
- `PRAGMA journal_mode = WAL`
- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = 5000`
- `PRAGMA synchronous = NORMAL`

On `SIGINT` / `SIGTERM`, SeatSniper stops scheduling ticks, drains any active poll (up to `10s`), closes native TLS/Discord handles, and executes `PRAGMA wal_checkpoint(TRUNCATE)` + `db.close(false)` so `.db-wal` truncates cleanly.

### Safe Online Backup

Never copy `seatsniper.db` with plain `cp` while `.db-wal` has active transactions if `sqlite3` is available—use SQLite's online backup command:

```bash
sqlite3 ~/seatsniper/seatsniper.db ".timeout 5000" ".backup '$HOME/seatsniper/seatsniper.db.bak'"
```

### Clean Orphan `seen_dates` / `seen_venues` Rows

If an older database ran before `PRAGMA foreign_keys = ON`, `/stop` could leave orphan rows in `seen_dates` and `seen_venues`. Run this one-shot cleanup after stopping the bot and backing up `seatsniper.db`:

```sql
DELETE FROM seen_dates WHERE watch_id NOT IN (SELECT id FROM watches);
DELETE FROM seen_venues WHERE watch_id NOT IN (SELECT id FROM watches);
```

---

## 6. Cloudflare / BookMyShow `403` & Rate-Limit Runbook

### BookMyShow `403` (`blocked`)

Cloudflare scores the **TLS ClientHello / HTTP2 fingerprint** (`JA3`/`JA4`), not datacenter IP reputation alone. SeatSniper defaults `BMS_TLS_PROFILE` to `safari_ios_17_0` via `node-tls-client`.

If BookMyShow starts returning `403` challenges (`[watch N] ... blocked`):
1. Rotate `BMS_TLS_PROFILE` in `.env` to another **Safari or Firefox** profile supported by `node-tls-client@2.2.0`:
   - `safari_ios_17_0` *(default)*
   - `safari_ios_18_0`
   - `safari_ios_18_5`
   - `safari_ios_26_0`
   - `firefox_148`
2. **Never** select a `chrome_*` profile—BookMyShow challenges Chrome TLS profiles from datacenter IPs, and `src/bms.ts` rejects unsupported profile families at startup rather than failing silently.
3. Restart SeatSniper (`systemctl --user restart seatsniper.service` or `pm2 restart seatsniper --update-env`).

### `429` / `503` Upstream Throttling

- District `429`/`503` responses log any upstream `(Retry-After: <value>)` header for diagnostics.
- Keep `STAGGER_MS_MIN` / `STAGGER_MS_MAX` at or above the `2000`–`5000` ms defaults (`0/0` risks automated burst signatures) and avoid lowering `POLL_INTERVAL_SEC` below `180` on shared watchlists.
