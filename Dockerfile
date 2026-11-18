# Pin oven/bun:1.4.2 on Linux: Bun 1.4.3/1.4.4 regressed with a Koffi FFI + GC
# event-loop deadlock on Linux (oven-sh/bun#44982), affecting node-tls-client.
FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && \
    (bun pm trust --all 2>/dev/null || true)

FROM oven/bun:1.4.2 AS runtime
LABEL org.opencontainers.image.source="https://github.com/Ishannaik/seatsniper" \
      org.opencontainers.image.description="Discord bot watching BookMyShow & District showtimes (Bun + SQLite)" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
RUN mkdir -p /data && chown -R bun:bun /data /app

COPY --chown=bun:bun --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun src ./src

ENV NODE_ENV=production \
    DB_PATH=/data/seatsniper.db \
    LIVENESS_PATH=/data/last_cycle.json

VOLUME ["/data"]
USER bun

# Verifies actual poll-cycle completion + Discord gateway liveness via last_cycle.json
# rather than checking PID existence alone (stale threshold = max(2.5 * POLL_INTERVAL_SEC, 300s)).
HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD ["bun", "-e", "import { existsSync, readFileSync, statSync } from 'node:fs'; import { dirname, join } from 'node:path'; const p = process.env.LIVENESS_PATH ?? join(dirname(process.env.DB_PATH ?? '/data/seatsniper.db'), 'last_cycle.json'); const maxAgeMs = Math.max((Number(process.env.POLL_INTERVAL_SEC) || 600) * 2.5, 300) * 1000; if (!existsSync(p)) process.exit(1); const st = statSync(p); if (Date.now() - st.mtimeMs > maxAgeMs) process.exit(1); const d = JSON.parse(readFileSync(p, 'utf8')); const tsMs = typeof d.ts === 'number' ? (d.ts > 1e11 ? d.ts : d.ts * 1000) : st.mtimeMs; if (Date.now() - tsMs > maxAgeMs || d.gatewayReady === false || d.ok === false) process.exit(1);"]

CMD ["bun", "run", "src/index.ts"]
