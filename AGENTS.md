# AGENTS.md

## Cursor Cloud specific instructions

SeatSniper is a single headless service: a Discord bot (Bun + TypeScript, `discord.js`
v14) that polls BookMyShow and DMs users when a show date opens. There is no web UI —
all evidence comes from terminal output/logs. Standard commands live in `package.json`
(`dev`, `start`, `commands`, `test`) and setup steps are in `README.md`.

Non-obvious things worth knowing:

- **Runtime is Bun, not Node.** `bun` is installed and symlinked at `/usr/local/bin/bun`,
  so it resolves in any shell. The update script (`bun install`) refreshes dependencies.
- **`node-tls-client` downloads a ~16MB Go `.so` at runtime on the first `initBms()` call**,
  not at install time. So a fresh `bun install` won't have it; the first bot start (or any
  code path that calls `initBms()`) fetches it from a GitHub release. This needs outbound
  network but is unrelated to BookMyShow.
- **Live BookMyShow is geo-fenced to India and is unreachable from this VM** (returns
  HTTP 301/403). `src/bms.ts` correctly treats this as a `blocked` error rather than
  "no shows". Because of this, the live integration suite (`integration.ts`) and any test
  that hits the real site will NOT pass here. Only the pure unit tests (`bun test`, i.e.
  `src/bms.test.ts`) run offline.
- **Running the bot needs real Discord credentials.** Copy `.env.example` to `.env` and set
  `DISCORD_TOKEN` + `DISCORD_CLIENT_ID` (and optionally `DISCORD_GUILD_ID` for instant slash
  command registration). Without a valid token, `bun run dev` boots fully and then fails at
  the Discord gateway with `TokenInvalid` — that's expected, not a setup bug.
- **Register slash commands with `bun run commands` before first use** (guild-scoped is
  instant; global takes ~1h to propagate).
- **SQLite is `bun:sqlite`** (built into the runtime, no native build). The DB file defaults
  to `./seatsniper.db` and is created on demand; override with `DB_PATH`. WAL mode leaves
  `*.db-wal`/`*.db-shm` sidecar files — do not commit them.
- **Lint/typecheck:** there is no separate lint script; `bunx tsc --noEmit` is the type check
  (the repo is `strict`).
