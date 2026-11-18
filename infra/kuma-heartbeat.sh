#!/usr/bin/env bash
# SeatSniper out-of-process Uptime Kuma push monitor (Oracle VPS cron / systemd timer).
# Verifies four signals before reporting UP (preventing silent zombie outages):
#   1. SeatSniper process / container is running
#   2. last_cycle.json mtime is within max(2.5 * POLL_INTERVAL_SEC, 900) seconds
#   3. last_cycle.json reports gatewayReady != false and ok != false
#   4. Daemon log file (when present and watches > 0) is not stale
#
# Crontab example (every 5 minutes):
#   */5 * * * * $HOME/seatsniper/infra/kuma-heartbeat.sh

set -euo pipefail

APP_DIR="${SEATSNIPER_DIR:-$HOME/seatsniper}"
ENV_FILE="${SEATSNIPER_ENV_FILE:-$APP_DIR/.env}"
LOG="${SEATSNIPER_LOG:-$APP_DIR/seatsniper.log}"

read_env_var() {
  local key="$1"
  if [[ -f "$ENV_FILE" ]]; then
    grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r"' || true
  fi
}

PUSH="${UPTIME_KUMA_PUSH_URL:-$(read_env_var UPTIME_KUMA_PUSH_URL)}"
if [[ -z "$PUSH" ]]; then
  echo "UPTIME_KUMA_PUSH_URL is not set in environment or $ENV_FILE" >&2
  exit 1
fi

RAW_POLL="${POLL_INTERVAL_SEC:-$(read_env_var POLL_INTERVAL_SEC)}"
POLL_SEC="${RAW_POLL:-600}"
if [[ ! "$POLL_SEC" =~ ^[0-9]+$ ]] || (( POLL_SEC < 60 )); then
  POLL_SEC=600
fi

# 2.5x poll interval (minimum 900s) avoids false flaps during multi-watch stagger scans.
STALE=$(( (POLL_SEC * 5) / 2 ))
if (( STALE < 900 )); then
  STALE=900
fi

RAW_DB="${DB_PATH:-$(read_env_var DB_PATH)}"
if [[ -n "$RAW_DB" ]]; then
  [[ "$RAW_DB" == /* ]] || RAW_DB="$APP_DIR/$RAW_DB"
  DEFAULT_CYCLE="$(dirname "$RAW_DB")/last_cycle.json"
else
  DEFAULT_CYCLE="$APP_DIR/last_cycle.json"
fi
CYCLE="${LIVENESS_PATH:-$(read_env_var LIVENESS_PATH)}"
CYCLE="${CYCLE:-$DEFAULT_CYCLE}"

sep="?"
[[ "$PUSH" == *\?* ]] && sep="&"

down() {
  curl -fsS -m 10 "${PUSH}${sep}status=down&msg=$1" >/dev/null || true
  exit 0
}

up() {
  curl -fsS -m 10 "${PUSH}${sep}status=up&msg=$1&ping=" >/dev/null || true
  exit 0
}

process_alive() {
  if pgrep -f '[b]un.*src/index\.ts' >/dev/null 2>&1; then
    return 0
  fi
  if command -v docker >/dev/null 2>&1 && [[ "$(docker inspect -f '{{.State.Running}}' seatsniper 2>/dev/null || echo false)" == "true" ]]; then
    return 0
  fi
  return 1
}

if ! process_alive; then
  down "process_not_running"
fi

now="$(date +%s)"

if [[ ! -f "$CYCLE" ]]; then
  down "last_cycle_missing"
fi

cycle_mtime="$(stat -c %Y "$CYCLE" 2>/dev/null || stat -f %m "$CYCLE")"
cycle_age=$(( now - cycle_mtime ))
if (( cycle_age > STALE )); then
  down "last_cycle_stale_${cycle_age}s"
fi

export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
if command -v bun >/dev/null 2>&1; then
  parsed="$(bun -e '
    import { readFileSync } from "node:fs";
    const d = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const watches = Number.isFinite(Number(d.watches)) ? Number(d.watches) : 0;
    if (d.gatewayReady === false) console.log(`gateway_disconnected:${watches}`);
    else if (d.ok === false) console.log(`cycle_unhealthy:${watches}`);
    else console.log(`ok:${watches}`);
  ' "$CYCLE" 2>/dev/null || echo "cycle_unreadable:0")"
elif command -v python3 >/dev/null 2>&1; then
  parsed="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
w = int(d.get("watches") or 0)
if d.get("gatewayReady") is False: print(f"gateway_disconnected:{w}")
elif d.get("ok") is False: print(f"cycle_unhealthy:{w}")
else: print(f"ok:{w}")
' "$CYCLE" 2>/dev/null || echo "cycle_unreadable:0")"
else
  w="$(grep -Eo '"watches"[[:space:]]*:[[:space:]]*[0-9]+' "$CYCLE" | grep -Eo '[0-9]+' | head -n 1 || echo 0)"
  if grep -Eq '"gatewayReady"[[:space:]]*:[[:space:]]*false' "$CYCLE"; then
    parsed="gateway_disconnected:${w:-0}"
  elif grep -Eq '"ok"[[:space:]]*:[[:space:]]*false' "$CYCLE"; then
    parsed="cycle_unhealthy:${w:-0}"
  else
    parsed="ok:${w:-0}"
  fi
fi

verdict="${parsed%%:*}"
watches="${parsed##*:}"
if [[ ! "$watches" =~ ^[0-9]+$ ]]; then
  watches=0
fi

if [[ "$verdict" != "ok" ]]; then
  down "$verdict"
fi

# Idle ticks (watches == 0) update last_cycle.json silently without logging to stdout;
# only enforce log mtime freshness when active watches exist.
if (( watches > 0 )) && [[ -f "$LOG" ]]; then
  log_mtime="$(stat -c %Y "$LOG" 2>/dev/null || stat -f %m "$LOG")"
  log_age=$(( now - log_mtime ))
  if (( log_age > STALE )); then
    down "seatsniper_log_stale_${log_age}s"
  fi
fi

up "ok"
