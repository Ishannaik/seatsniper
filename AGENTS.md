# SeatSniper

Discord bot that watches BookMyShow and DMs you when a date opens (or when a new date unlocks on a subscription). Observes and notifies only — never buys tickets, holds seats, or automates checkout.

## Stack

- Bun 1.2 + TypeScript
- discord.js v14
- `bun:sqlite` (no DB dependency)
- `node-tls-client` (Safari TLS fingerprint for BookMyShow)

## Commands

```bash
bun install
bun pm trust --all          # required: node-tls-client postinstall fetches its Go lib
cp .env.example .env        # DISCORD_TOKEN, DISCORD_CLIENT_ID; optional DISCORD_GUILD_ID
bun run commands            # register slash commands (guild = instant, else ~1h)
bun run dev                 # watch mode
bun test                    # bun test
bun run start               # production entry
```

Deployed on Oracle VPS under pm2 (`bun run src/index.ts`). Bun auto-loads `.env` from cwd.

## Layout (as shipped)

```
src/
  index.ts      bot + poll loop + slash handlers
  bms.ts        BookMyShow client, URL parse, availability
  bms.test.ts
  db.ts         SQLite watches + seen_dates + seen_venues
  messages.ts   Discord copy / embeds
  register.ts   slash command registration
docs/superpowers/specs/   design + measured BMS findings
```

README still sketches a modular `core/` / `providers/` layout — that is the *design* target, not the current tree. Do not invent folders that are not there.

## Hard constraints (measured, do not regress)

Full write-up: `docs/superpowers/specs/2026-07-27-bms-access-findings.md`.

1. **TLS profile is Safari.** `node-tls-client` with `safari_ios_18_0`. Never Chrome profiles — they get Cloudflare challenges. Never add custom headers on top of the profile; mismatched fingerprints cause 403s.
2. **Availability is a field comparison.** BookMyShow silently substitutes the nearest bookable date when the requested date is closed. URL / HTTP status / `currentDateCode` all lie. Only `showDateCode` on each show is trustworthy. No keyword or date-token-frequency heuristics.
3. **Errors are not empty results.** Unparseable / blocked / network failures throw `BmsError`. Never swallow them into `[]` — that is how prior art stayed silently dead forever.
4. **Validate watches at creation.** Hit live BMS when `/watch` is saved so a bad link fails immediately instead of never firing.
5. **Coalesce polls.** Multiple watches on the same movie share one request per cycle.

## Product behaviour

- `/watch link:… date:YYYY-MM-DD` — one-shot; DM once when that date opens, then delete the watch.
- `/watch link:… date:any` (or no date on the link) — subscription; ping when a *new* date unlocks or a *new cinema* appears (`seen_dates` / `seen_venues` ledgers).
- `/list`, `/stop`, `/help`
- Cap: 5 watches per user (`MAX_WATCHES_PER_USER`).


## Non-goals

Seat selection, checkout automation, other providers, Telegram/email, web dashboard, multi-tenant billing. Later additions should land as new modules without rewriting the poll/notify core.
