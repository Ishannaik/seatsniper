<p align="center">
  <img src="assets/logo.png" alt="SeatSniper" width="320">
</p>

<h1 align="center">SeatSniper</h1>

<p align="center">
  <b>Watch any BookMyShow page. Get a Discord DM the second tickets go on sale.</b><br>
  Self-host in one command. Bun + TypeScript + SQLite. No API keys, no credit card, no browser.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/Ishannaik/seatsniper"></a>
  <a href=".github/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Ishannaik/seatsniper/ci.yml"></a>
  <img alt="Runtime: Bun 1.2" src="https://img.shields.io/badge/runtime-Bun%201.2-black">
  <img alt="Language: TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6">
  <img alt="discord.js v14" src="https://img.shields.io/badge/discord.js-v14-5865F2">
  <img alt="Storage: SQLite" src="https://img.shields.io/badge/storage-SQLite-003B57">
  <a href="https://github.com/Ishannaik/seatsniper/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/Ishannaik/seatsniper"></a>
</p>

<p align="center">
  <img alt="The DM SeatSniper sends" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MjAiIGhlaWdodD0iMjQ2IiB2aWV3Qm94PSIwIDAgNjIwIDI0NiIgZm9udC1mYW1pbHk9Ii1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgJ1NlZ29lIFVJJywgSGVsdmV0aWNhLCBBcmlhbCwgc2Fucy1zZXJpZiI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJiZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMCIgeTI9IjEiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzMyMzMzOCIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzJiMmQzMSIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHg9IjAiIHk9IjAiIHdpZHRoPSI2MjAiIGhlaWdodD0iMjQ2IiByeD0iMTAiIGZpbGw9InVybCgjYmcpIi8+PHJlY3QgeD0iMCIgeT0iMjAiIHdpZHRoPSI0IiBoZWlnaHQ9IjIwMCIgZmlsbD0iI0VERDQyNSIvPjxyZWN0IHg9IjIwIiB5PSIyNCIgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiByeD0iNSIgZmlsbD0iI0VERDQyNSIvPjx0ZXh0IHg9IjMxIiB5PSI0MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1zaXplPSIxMiIgZmlsbD0iI2ZmZmZmZiIgZm9udC13ZWlnaHQ9IjcwMCI+U1M8L3RleHQ+PHRleHQgeD0iNTAiIHk9IjQwIiBmb250LXNpemU9IjEyIiBmaWxsPSIjYjVjMWMwIj5TZWF0U25pcGVyPC90ZXh0Pjx0ZXh0IHg9IjYwMCIgeT0iNDAiIHRleHQtYW5jaG9yPSJlbmQiIGZvbnQtc2l6ZT0iMTIiIGZpbGw9IiNiNWMxYzAiPkRNIC4ganVzdCBub3c8L3RleHQ+PHRleHQgeD0iMjAiIHk9Ijc2IiBmb250LXNpemU9IjE3IiBmaWxsPSIjZjJmM2Y1IiBmb250LXdlaWdodD0iNzAwIj7wn42mIFRpY2tldHMgYXJlIGxpdmUhPC90ZXh0Pjx0ZXh0IHg9IjIwIiB5PSIxMDQiIGZvbnQtc2l6ZT0iMTMiIGZpbGw9IiNkYmRlZTEiPlRoZSBPZHlzc2V5IC4gNEsgM0QgSU1BWCAuIE11bWJhaTwvdGV4dD48dGV4dCB4PSIyMCIgeT0iMTIyIiBmb250LXNpemU9IjEzIiBmaWxsPSIjZGJkZWUxIj5Cb29raW5ncyBqdXN0IG9wZW5lZC4gU2F0dXJkYXkgaXMgb24gc2FsZS48L3RleHQ+PHRleHQgeD0iMjAiIHk9IjE2MCIgZm9udC1zaXplPSIxMSIgZmlsbD0iI2I1YzFjMCIgZm9udC13ZWlnaHQ9IjYwMCI+R0FURTwvdGV4dD48dGV4dCB4PSIyMCIgeT0iMTc4IiBmb250LXNpemU9IjEzIiBmaWxsPSIjZjJmM2Y1Ij5TYXQsIDIgQXVnIDIwMjY8L3RleHQ+PHRleHQgeD0iMjEwIiB5PSIxNjAiIGZvbnQtc2l6ZT0iMTEiIGZpbGw9IiNiNWMxYzAiIGZvbnQtd2VpZ2h0PSI2MDAiPkNJVFk8L3RleHQ+PHRleHQgeD0iMjEwIiB5PSIxNzgiIGZvbnQtc2l6ZT0iMTMiIGZpbGw9IiNmMmYzZjUiPk11bWJhaTwvdGV4dD48dGV4dCB4PSIyMCIgeT0iMjEwIiBmb250LXNpemU9IjExIiBmaWxsPSIjYjVjMWMwIiBmb250LXdlaWdodD0iNjAwIj5DSU5FTUFTPC90ZXh0Pjx0ZXh0IHg9IjIwIiB5PSIyMjgiIGZvbnQtc2l6ZT0iMTMiIGZpbGw9IiNmMmYzZjUiPlBWUiBJY29uLCBJbm94IE1lZ2FwbGV4PC90ZXh0Pjwvc3ZnPg==">
</p>

<p align="center">
  <code>curl -fsSL https://raw.githubusercontent.com/Ishannaik/seatsniper/main/install.sh | bash</code>
</p>

---

## TL;DR

You tell it a BookMyShow link and a date. It polls the site, and the moment that
date is bookable you get one DM. Say `date:any` instead and it pings you every
time a *new* date unlocks or a *new* cinema starts showing the movie. Trim the
noise with filters: `format:IMAX,4DX` only pings for those screens, and
`days:fri,sat` only on those weekdays.

Works for movies, concerts, plays, any event BookMyShow lists in India.

It observes and notifies. It never buys tickets, holds seats, or fills carts.

## Table of contents

- [🎯 Features](#features)
- [🚀 Quick start](#quick-start)
- [🐳 Run with Docker](#run-with-docker)
- [📦 Manual setup](#manual-setup)
- [🎮 Commands](#commands)
- [🧠 How it works](#how-it-works)
- [⚙️ Configuration](#configuration)
- [🗺️ Project layout](#project-layout)
- [🧗 BookMyShow quirks](#bookmyshow-quirks)
- [🤝 Contributing](#contributing)

## 🎯 Features

| | |
| --- | --- |
| 📅 **Watch one date** | One DM the moment that date opens. The watch then deletes itself. No spam. |
| 🎬 **Subscribe to a movie** | `date:any` = a DM every time a new date unlocks or a new cinema appears. |
| 🎥 **Format + day filters** | Only ping for the screens you care about: `format:IMAX,4DX` matches by name, `days:fri,sat` by weekday. |
| ✅ **Validates at creation** | The link is checked against the live site when you save it, so a broken watch fails immediately, not silently. |
| ⚡ **One request per movie** | 50 watches on the same movie cost the same as 1. Coalesced polling keeps BookMyShow happy. |
| 📱 **User-install commands** | Works in DMs and servers, installs straight to your account. |
| 💾 **SQLite, zero config** | No database server, no Docker required. One file. |

## 🚀 Quick start

One command on Linux or macOS. It installs Bun, clones the repo, prompts for
your Discord credentials, registers the slash commands, and starts the bot under
pm2:

```bash
curl -fsSL https://raw.githubusercontent.com/Ishannaik/seatsniper/main/install.sh | bash
```

Non-interactive, for CI or a box with no terminal:

```bash
DISCORD_TOKEN=... DISCORD_CLIENT_ID=... bash <(curl -fsSL https://raw.githubusercontent.com/Ishannaik/seatsniper/main/install.sh)
```

Then:

1. Invite the bot with the URL the installer prints.
2. In Discord, run `/watch` and paste a BookMyShow link.
3. Wait. The DM arrives when tickets go live.

## 🐳 Run with Docker

```bash
git clone https://github.com/Ishannaik/seatsniper.git && cd seatsniper
cp .env.example .env                  # fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
docker compose run --rm seatsniper bun run commands   # register slash commands
docker compose up -d
```

The database lives in a named volume, so the bot survives container restarts.

## 📦 Manual setup

```bash
bun install               # installs via bun.sh
cp .env.example .env      # DISCORD_TOKEN, DISCORD_CLIENT_ID
bun run commands          # register slash commands
bun run start             # or: bun run dev for watch mode
```

<details>
<summary><b>Behind pm2</b></summary>

```bash
pm2 start "$HOME/.bun/bin/bun" --name seatsniper --interpreter none --time -- run src/index.ts
pm2 save
```

Bun auto-loads `.env` from the working directory.
</details>

## 🎮 Commands

| Command | What it does |
| --- | --- |
| `/watch link:<url> date:YYYY-MM-DD` | DM once when that date opens, then delete the watch |
| `/watch link:<url> date:any` | Subscribe. DM when a new date or cinema appears |
| `/watch link:<url> format:IMAX,4DX days:fri,sat` | Optional filters on any watch. Ping only for these formats or weekdays |
| `/list` | Show your active watches |
| `/stop id:<n>` | Stop watch `n` from `/list` |
| `/help` | How the bot works |

Each user can hold up to 5 watches.

## 🧠 How it works

1. **Save.** `/watch` parses the link, then hits BookMyShow once to confirm the
   movie exists. Bad links fail here, not days later.
2. **Poll.** Every `POLL_INTERVAL_SEC` (default 600 s) the bot checks each
   watch. Watches on the same movie share one request.
3. **Detect.** Availability comes from the `showDateCode` on each show.
   BookMyShow silently serves the nearest bookable date when the one you asked
   for is closed, so the URL, the HTTP status, and the page header all lie. The
   per-show field does not.
4. **Notify.** A dated watch DMs you once, then removes itself. A subscription
   compares today's dates and cinemas against what it has seen before and DMs
   the difference.

Failure is never silence. A blocked or unparseable response throws and logs;
after 3 consecutive failures the bot tells you, so a dead poller cannot sit
quietly forever.

## ⚙️ Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | yes | | Bot token from the Discord developer portal |
| `DISCORD_CLIENT_ID` | yes | | Application ID from the same page |
| `DISCORD_GUILD_ID` | no | | Register commands in one guild instantly instead of waiting ~1 h for global |
| `POLL_INTERVAL_SEC` | no | `600` | Seconds between poll cycles |
| `DB_PATH` | no | `seatsniper.db` | SQLite file location |
| `UPTIME_KUMA_PUSH_URL` | no | | Uptime Kuma push URL; the bot pings it after each poll |

## 🗺️ Project layout

```
src/
  index.ts      bot, poll loop, slash handlers
  bms.ts        BookMyShow client, URL parsing, availability
  db.ts         SQLite: watches, seen dates, seen venues
  messages.ts   Discord copy and embeds
  register.ts   slash command registration
assets/          logo
docs/            design specs and measured findings
```

## 🧗 BookMyShow quirks

- **Geo-fenced.** Datacenter IPs outside India can be blocked. A home server in
  India is the safest host. The bot speaks Safari's TLS fingerprint via
  `node-tls-client`, which passes BookMyShow's Cloudflare checks.
- **No heuristics.** Availability is a field comparison, not a scrape-and-guess.
  The measured findings behind this live in
  [`docs/superpowers/specs/2026-07-27-bms-access-findings.md`](docs/superpowers/specs/2026-07-27-bms-access-findings.md).

## 🤝 Contributing

Bug reports, feature ideas, and PRs are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md), which covers the setup and the hard
constraints the bot was built around. Report security issues privately, see
[SECURITY.md](SECURITY.md).

## 📄 License

MIT, see [LICENSE](LICENSE).

---

⭐ **If SeatSniper saved you a ticket, star the repo so the next person finds
it.**

<p align="center">
  <sub>Observes and notifies only. Never buys tickets. Made for the Friday 9 AM rush.</sub>
</p>
