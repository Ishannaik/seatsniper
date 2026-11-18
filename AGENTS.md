# AGENTS.md — SeatSniper

You are one of potentially several agents working on this repository. Read this contract before touching any file. `scripts/quality.ts`, `scripts/deadcode.ts`, Biome, and `.githooks/pre-commit` will reject drifted or sloppy work. Closest `AGENTS.md` wins; the operator's prompt overrides all. [`CLAUDE.md`](CLAUDE.md) holds commands, architecture, hard constraints, and TDD ground rules. This file governs execution: roles, file lanes, tool boundaries, environment variables, and the live module map.

SeatSniper watches public BookMyShow and District pages and DMs Discord users when tickets open. It is strictly read-only — never add login, seat-holding, cart, or checkout code.

Two checkouts:

| tree | role |
|---|---|
| `Projects/SeatSniper/` (this tree) | Local working copy & test tree |
| `/home/ubuntu/seatsniper` (Oracle VPS, SSH host `oracle`) | Production (`seatsniper.service` user unit or `pm2` `seatsniper`). Live DB `/home/ubuntu/seatsniper/seatsniper.db` |

Never run `bun src/index.ts` locally with production `.env` while Oracle is live — duplicate Discord gateway clients and concurrent pollers fight over rate limits and double-DM users.

## Agent Roles

| role | when | tools | must not |
|---|---|---|---|
| **Main / Coordinator** | Decompose tasks, define cross-module contracts, integrate & ship | all | Dump unverified multi-slice diffs without running `bun run check` |
| **scout** | Inspect unknown code, parser payloads, GitHub issues, or Oracle status | read, grep, glob, read-only `gh` / SSH | Edit files, commit, restart prod, or touch `.env` |
| **core** | Bot runtime, poll loop, interaction routing, SQLite schema/queries | `src/index.ts`, `src/db.ts`, `src/register.ts`, owned `*.test.ts` | Edit provider parsers or `package.json` without lane assignment |
| **providers** | BookMyShow TLS/HTML parser, District SSR/Flight parsers, cycle cache | `src/providers.ts`, `src/read-cycle.ts`, `src/bms.ts`, `src/district*.ts`, `src/movie-model.ts`, `src/provider-error.ts`, owned `*.test.ts` | Swallow `BmsError` into `[]`, use Chrome TLS profiles, or make live network calls in `*.test.ts` |
| **ux** | Slash schemas, autocomplete, filters, Discord embeds & buttons | `src/commands.ts`, `src/filters.ts`, `src/time-filter.ts`, `src/booking-preferences.ts`, `src/messages.ts`, owned `*.test.ts` | Leak raw venue codes, break `dm()` channel fallback with Components V2, or scatter copy outside `src/messages.ts` |
| **ops / cicd** | GitHub Actions, Docker, `install.sh`, Oracle `infra/*`, quality gates | `.github/**`, `Dockerfile`, `docker-compose.yml`, `install.sh`, `infra/**`, `scripts/**`, `docs/ops.md` | Bump Linux Bun onto `1.4.3`/`1.4.4` (`oven-sh/bun#44982` Koffi+GC freeze) or echo secrets in workflows |
| **verifier** | Post-wave audit of tests, types, bundles, workflows, and doc sync | read, grep, `bun run check`, `bun build` | Silently rewrite author slices instead of reporting exact `file:line` defects |

Pick the narrowest role that fits. Parallelize independent slices only when file ownership is disjoint and shared TypeScript interfaces (`Show`, `Target`, `FormatChip`, `WatchListRow`, button `customId`s) are fixed up front.

## Subagent Coordination

1. **Exclusive file lanes.** Two agents never edit the same file concurrently. Declare exact file lists in every subagent brief (`src/index.ts`, `src/db.ts`, `src/messages.ts`, `src/bms.ts`, and `package.json` each have a single owner per wave).
2. **Contracts up front.** When slice A produces options or columns consumed by slice B, make newly added fields optional (`watchId?`, `posterUrl?`, `totalOpenDates?`) during parallel edits so `tsc --noEmit` stays green across sibling slices.
3. **Scoped mid-flight checks.** Task agents run only their own test files (`bun test src/bms.test.ts src/providers.test.ts`) while siblings are editing. The coordinator or `verifier` runs full `bun run check` once the wave settles.
4. **Database safety.** Always isolate test SQLite databases inside `os.tmpdir()` and call `closeDb()` in cleanup so Windows file locks (`EBUSY`) and root `test-*.db*` clutter never occur.
5. **Oracle SSH.** Scouts may inspect read-only logs/status when asked. Production restarts, `.env` changes, and branch pushes require explicit operator instruction.

## Tool Execution Boundaries

**Always**

- Write a failing unit test first (`src/*.test.ts`) before changing runtime or parser behavior.
- Keep unit tests 100% offline using `src/fixtures/` or injected transport mocks.
- Route BookMyShow HTTP exclusively through `src/bms.ts` (`node-tls-client` Safari/Firefox allowlist) and District HTTP through `fetch` with `AbortSignal.timeout`.
- Cancel unread `fetch` response bodies (`await response.body?.cancel().catch(() => {})`) on non-OK District HTTP responses and Uptime Kuma pushes.
- Wrap multi-step SQLite writes in `db.transaction(...).immediate()` and commit watch deletion / `seen_*` ledgers **only after** `dm()` succeeds.
- Check `client.ws.status === Status.Ready` for Discord gateway health (never `client.isReady()`).
- Run `bun run agents:sync` whenever adding, renaming, or deleting a non-test `src/*.ts` module.

**Never**

- Commit `.env`, `seatsniper.db*`, Discord tokens, SSH keys, or Uptime Kuma push URLs.
- Use `git commit --no-verify`, force-push `main`, or add `biome-ignore` without an inline `why:` comment.
- Raise `LEGACY_FILE_CEILINGS` in `scripts/quality.ts` to cram more code into `index.ts` or `messages.ts` — extract a clean `<400`-line module instead.
- Install `knip` into `package.json` while `picomatch` `CVE-2026-112366` remains unpatched (`@nebzdev/bun-security-scanner` aborts `bun install`; use `bun run deadcode` / `scripts/deadcode.ts`).
- Use `db.close(true)` on `bun:sqlite` (`oven-sh/bun#29494` throws `SQLITE_BUSY` on cached `db.query()` statements; use `closeDb()`).
- Hand-edit rows inside `<!-- AGENTS-MODULES:START -->` … `<!-- AGENTS-MODULES:END -->` without running `bun run agents:sync -- --check` to verify parity.

## Verify Before You Ship (Coordinator / Verifier, Copy-Paste)

```bash
bun run typecheck
bun run lint
bun run quality
bun run deadcode
bun test
```

*(Shortcut: `bun run check` runs all five in order. For container/entrypoint changes, also run `bun build src/index.ts --outdir "$TMPDIR/ss-build" --target bun` and `bash -n install.sh`.)*

## Environment

Loaded automatically by Bun from `.env` in `cwd` locally, and via `EnvironmentFile=/home/ubuntu/seatsniper/.env` (or `pm2` cwd) on Oracle VPS.

| name | used by | notes |
|---|---|---|
| `DISCORD_TOKEN` | `src/index.ts`, `src/register.ts` | **Required.** Discord bot token (never log or commit) |
| `DISCORD_CLIENT_ID` | `src/register.ts` | **Required for registration.** Discord Application ID |
| `DISCORD_GUILD_ID` | `src/register.ts` | Optional. Instant single-guild command sync; omit for global (~1h propagation, required for DM/user-install scopes) |
| `POLL_INTERVAL_SEC` | `src/index.ts` | Optional, default `600`. Seconds between poll cycles (keep `>= 120–300` for safe cadence) |
| `STAGGER_MS_MIN` | `src/stagger.ts` | Optional, default `2000`. Minimum random pause (ms) between watches in one cycle |
| `STAGGER_MS_MAX` | `src/stagger.ts` | Optional, default `5000`. Maximum random pause (ms) between watches in one cycle |
| `DB_PATH` | `src/db.ts`, `src/index.ts` | Optional, default `seatsniper.db` (`/data/seatsniper.db` in Docker). SQLite WAL path |
| `LIVENESS_PATH` | `src/index.ts` | Optional, default `<dirname(DB_PATH)>/last_cycle.json`. Atomic poll-cycle heartbeat JSON for Docker/systemd/Kuma |
| `BMS_TLS_PROFILE` | `src/bms.ts` | Optional, default `safari_ios_17_0`. Safari/Firefox `node-tls-client` identifier only; Chrome profiles fail fast at startup |
| `UPTIME_KUMA_PUSH_URL` | `src/index.ts`, `infra/kuma-heartbeat.sh` | Optional. Uptime Kuma Push monitor URL pinged after each completed poll |

## Where Things Live

<!-- AGENTS-MODULES:START -->
| module | job |
|---|---|
| `bms.ts` | BookMyShow client (`node-tls-client` Safari/Firefox TLS, 24h rotation), URL parser, `showDateCode` check, and `formatSelector` child chips |
| `commands.ts` | Unified Discord slash-command builders (`/watch`, `/list`, `/stop`, `/help`) and option autocomplete |
| `db.ts` | `bun:sqlite` WAL store (`watches`, `seen_dates`, `seen_venues`), `.immediate()` transactions, migrations, and `MAX_WATCHES_PER_USER` |
| `district-common.ts` | (see module) |
| `district-events.ts` | District live-event client: Next.js Flight stream parser gating on active `general_sale` + `BOOK_TICKETS` |
| `district.ts` | District movie client: `__NEXT_DATA__` SSR parser across all `languageFormatGroups` and seat/price categories |
| `filters.ts` | Format (`IMAX`, `PXL`, `4DX`, `ScreenX`, …), theatre/venue, and weekday normalisation, matching, and summary text |
| `index.ts` | Discord gateway client, slash & Stop-button interaction handlers, coalesced poll loop, DM/fallback delivery, and liveness telemetry |
| `messages.ts` | Discord Embeds, `<t:epoch:t>` / `<t:epoch:R>` timestamps, booking link buttons, and interactive Stop button rows |
| `movie-model.ts` | Shared `Show`, `Target`, `TicketCategory`, and `FormatChip` contracts plus `showsOnDate` |
| `poller.ts` | (see module) |
| `provider-error.ts` | Typed `BmsError` (`network`, `blocked`, `unparseable`, `bad_url`, `not_found`) |
| `providers.ts` | BookMyShow + District URL router (`parseWatchUrl`), unified showtime/date API, and per-cycle cached wrappers |
| `read-cycle.ts` | `ReadCycle` per-poll promise coalescer with rejected-promise eviction |
| `register.ts` | CLI slash-command publisher (`bun run commands`) for guild or global Discord scopes |
| `stagger.ts` | Anti-burst inter-watch sleep bounds (`STAGGER_MS_MIN` / `STAGGER_MS_MAX`) |
| `time-filter.ts` | IST wall-clock `after:`/`before:` window parser, natural IST date resolver (`today`, `tomorrow`, weekdays), and show epoch conversion |
<!-- AGENTS-MODULES:END -->

This table is checked by `scripts/quality.ts` (`R7`) and regenerated by `bun run agents:sync` (`scripts/gen-agents-modules.ts`). Supporting tooling & operations directories outside `src/`:

| path | job |
|---|---|
| `scripts/quality.ts` | Architecture & drift gate (`R2` file caps, `R3` circular imports, `R7` `AGENTS.md` sync, `R8` repo hygiene) |
| `scripts/deadcode.ts` | Zero-dependency AST orphan-module, broken-import, and unused-dependency gate |
| `scripts/gen-agents-modules.ts` | Idempotent `AGENTS.md` `src/*.ts` module-table generator & `--check` verifier |
| `integration.ts` | Manual live BookMyShow verification script (never run in CI) |
| `infra/` | Oracle VPS `systemd` user unit, `logrotate` config, and external Uptime Kuma heartbeat script |

## When You Are Unsure

Read [`CLAUDE.md`](CLAUDE.md), then [`docs/architecture.md`](docs/architecture.md) and [`docs/ops.md`](docs/ops.md). Match the surrounding 2-space TypeScript style (`src/bms.ts`). Consistency and explicit failure modes beat clever abstractions.
