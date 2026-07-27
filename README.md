<p align="center">
  <img src="assets/logo.png" alt="SeatSniper" width="360">
</p>

<p align="center"><b>Discord bot that watches BookMyShow and pings you the moment your show opens.</b></p>

---

## What it does

You tell it a movie, a city, and optionally a theatre or screen format. It polls
BookMyShow on an interval and pings you in Discord when something changes:

- **Bookings open** for a movie that wasn't bookable yet
- **A new date** appears (Friday release, Saturday shows drop later)
- **A new show** is added (a 9:30 PM IMAX that wasn't there this morning)

## Status

Pre-MVP. The provider layer is being built against verified BookMyShow endpoints
(see [Research](#research)).

## Stack

| | |
|---|---|
| Runtime | Bun 1.2 |
| Language | TypeScript |
| Discord | discord.js v14 |
| Storage | `bun:sqlite` (built in, no dependency) |
| Scheduling | in-process interval |

## Layout

```
src/
  core/         watch model · scheduler · change detection
  providers/
    bms/        BookMyShow adapter
  notify/
    discord/    embed builder + send
  bot/          slash commands
  store/        SQLite
assets/         logo
```

Two seams matter. Every provider returns the same normalised `Show[]`, so `core/`
never knows BookMyShow exists — a second ticketing site is a new folder, not a
rewrite. And `core/` emits a typed `AlertEvent` that each channel renders its own
way, so Telegram or email later is one file each.

Change detection is snapshot diffing: store the last-seen `Show[]` per watch,
compare on each poll, emit events for rows that weren't there before. "Bookings
opened", "new date", and "new show" are all the same three lines of logic.

## Setup

```bash
bun install
bun pm trust --all       # node-tls-client's postinstall fetches its Go library
cp .env.example .env     # fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
bun run commands         # register slash commands
bun run dev
```

## Deployment

Runs on the Oracle VPS under pm2:

```bash
cd ~/seatsniper
pm2 start "$HOME/.bun/bin/bun" --name seatsniper --interpreter none --time -- run src/index.ts
pm2 save                 # persist across reboots (pm2 startup already configured)

pm2 logs seatsniper      # follow
pm2 restart seatsniper   # after a deploy
```

Bun auto-loads `.env` from the working directory, so pm2 needs no env wiring.

## Usage

```
/watch link:<paste a BookMyShow link>  date:2026-07-30
/list
/stop id:3
```

The bot validates the link against the live site immediately, so a broken watch
fails at creation instead of silently never firing. When the date opens it DMs you
once and deletes the watch.

## Research

Prior art was read line by line before any code was written. Findings that shaped
the design:

**BookMyShow does expose JSON APIs** for lookup — `deCodeIt/book-my-show-notification`
calls [`/api/explore/v1/discover/regions`](https://github.com/deCodeIt/book-my-show-notification/blob/163589203890aa03d9229a1aab917b5090e17951/BookMyShow.py#L167-L180)
for cities and [`/pwa/api/de/venues?regionCode=…&eventType=MT`](https://github.com/deCodeIt/book-my-show-notification/blob/163589203890aa03d9229a1aab917b5090e17951/BookMyShow.py#L113-L126)
for venues. No browser needed for either.

**Showtimes are harder.** That project scrapes a `var UAPI = JSON.parse("…")` blob
out of an inline `<script>` on the cinema page
([source](https://github.com/deCodeIt/book-my-show-notification/blob/163589203890aa03d9229a1aab917b5090e17951/BookMyShow.py#L257-L316)).
`ayush-cyber01/Bookmyshow_moviealert` doesn't parse at all — it
[counts how often the target date appears in the raw HTML](https://github.com/ayush-cyber01/Bookmyshow_moviealert/blob/main/poller.py#L165-L186)
and calls it open if that date is the most frequent token. Both are guesses about
page structure rather than reads of a contract.

**Failure is silent in both.** A 403, a CAPTCHA, or a region block returns HTTP 200
with the wrong body, matches nothing, and reads as "not open yet" forever. Neither
project can tell "no tickets" apart from "scraping broke". SeatSniper treats an
unparseable response as an error, not as a negative.

**BookMyShow is geo-fenced.** Datacenter IPs outside India get blocked, which is why
the GitHub Actions approach needs a proxy. Affects hosting choice, not code.

| | `Bookmyshow_moviealert` | `book-my-show-notification` |
|---|---|---|
| Detection | date-token frequency in HTML | embedded `UAPI` JSON |
| Alerts | Telegram | desktop / PushBullet |
| Scheduling | external cron → Actions | foreground `while` loop |
| Alerts fire | once, ever | once, then loops forever |
| Multi-watch | no | no |

## Licence

Not yet chosen.
