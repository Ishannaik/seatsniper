# Contributing to SeatSniper

Bug reports, feature ideas, and pull requests are welcome. The bot is small
on purpose. Before you open a PR, read the constraints below, because they
were measured against the live BookMyShow site and are easy to regress.

## Setup

```bash
bun install
cp .env.example .env       # DISCORD_TOKEN, DISCORD_CLIENT_ID
bun run commands           # register slash commands
bun run dev                # watch mode
bun test
```

`bun run commands` with `DISCORD_GUILD_ID` set registers instantly in one
guild; without it, registration goes global and takes about an hour.

## Hard constraints (do not regress)

The full write-up is in
[`docs/superpowers/specs/2026-07-27-bms-access-findings.md`](docs/superpowers/specs/2026-07-27-bms-access-findings.md).

1. **TLS profile is Safari.** The poller uses `node-tls-client` with
   `safari_ios_18_0`. Chrome profiles get Cloudflare challenges, and custom
   headers on top of the profile cause 403s. Do not add either.
2. **Availability is a field comparison.** When the requested date is closed,
   BookMyShow silently substitutes the nearest bookable date. The URL, the
   HTTP status, and `currentDateCode` all lie. Only the `showDateCode` on each
   show is trustworthy. No keyword or date-token-frequency heuristics.
3. **Errors are not empty results.** Unparseable, blocked, or failed requests
   throw `BmsError`. Never swallow them into `[]`; that is how prior scraping
   projects stayed silently dead forever.
4. **Validate watches at creation.** `/watch` hits the live site before saving,
   so a bad link fails immediately instead of never firing.
5. **Coalesce polls.** Watches on the same movie share one request per cycle.
6. **No headless browser as the poller.** Showtimes are server-rendered HTML;
   the Safari TLS profile already returns 200 in about 50 ms. If Cloudflare
   hardens, rotate the TLS profile first, then consider a browser spike. Do not
   assume a browser works until it returns parseable showtimes from a server.

## Sending a PR

- Keep the change to one thing. If a PR touches more than one feature, split
  it.
- Run `bun test` before opening the PR. The CI workflow runs the same tests.
- For anything that changes how BookMyShow is read, add or update a unit test
  in `src/bms.test.ts` and explain the observed behavior you are coding
  against.
- Copy for Discord messages lives in `src/messages.ts`. Keep new messages in
  the same voice.

## Testing

`bun test` runs the unit suite. `integration.ts` is a live suite that makes
real requests to production BookMyShow; it is not part of CI and needs network
reachability to the site, so it can only be run from a machine the site does
not block.

## Releases

Releases follow the workflow in [`docs/releasing.md`](docs/releasing.md) and
the changelog in [`CHANGELOG.md`](CHANGELOG.md).
