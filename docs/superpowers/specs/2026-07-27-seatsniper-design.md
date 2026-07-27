# SeatSniper — Design Spec

**Date:** 2026-07-27
**Status:** Approved, pending provider spike
**Repo:** https://github.com/Ishannaik/seatsniper (private)

---

## 1. Objective

A Discord bot that watches BookMyShow and alerts the moment a specific show becomes
bookable.

The goal is not "notify me when tickets open." It is **never miss the exact show you
want** — a specific movie, at a specific theatre, in a specific format, on a specific
date.

This spec covers the MVP only. Section 16 lists what comes later and which module each
addition lands in.

---

## 2. Scope

### In scope (MVP)

| Capability | Detail |
|---|---|
| Watch creation | `/watch add` with movie + city, optional theatre / screen type / date |
| Watch management | `/watch list`, `/watch remove` |
| Booking-open alert | Fire when a watch goes from zero bookable shows to some |
| New-date alert | Fire when a date not previously seen becomes bookable |
| New-show alert | Fire when a showtime is added to an already-bookable date |
| Failure alert | Fire when the provider breaks, so silence is never ambiguous |
| Persistence | SQLite, survives restart |
| Multiple watches | Many per user, many per guild |

### Explicitly out of scope (MVP)

Seat-level availability · seat-row/position preferences · price-change alerts ·
Telegram / email / web push · web dashboard · multi-tenant billing · user accounts ·
any provider other than BookMyShow.

Each is a later module (section 16), not a rewrite. None of them is load-bearing for
"tell me when I can book."

### Non-goals, permanently

SeatSniper does **not** buy tickets, hold seats, or automate checkout. It observes and
notifies. This keeps it on the right side of BookMyShow's terms and avoids the entire
category of payment/credential handling.

---

## 3. Prior art — what the research established

Two existing projects were read line by line before any code was written.

### 3.1 BookMyShow exposes real JSON APIs (partially)

`deCodeIt/book-my-show-notification` calls two undocumented but stable-looking JSON
endpoints:

| Purpose | Endpoint |
|---|---|
| Cities / regions | `GET https://in.bookmyshow.com/api/explore/v1/discover/regions` |
| Venues in a city | `GET https://in.bookmyshow.com/pwa/api/de/venues?regionCode={code}&eventType=MT` |

Source: [regions](https://github.com/deCodeIt/book-my-show-notification/blob/163589203890aa03d9229a1aab917b5090e17951/BookMyShow.py#L167-L180) ·
[venues](https://github.com/deCodeIt/book-my-show-notification/blob/163589203890aa03d9229a1aab917b5090e17951/BookMyShow.py#L113-L126)

`eventType=MT` means Movie Ticket. Both return plain JSON, no browser required.
**This answers the brief's Q1 and Q4 for lookup: yes, and no browser needed.**

### 3.2 Showtimes are the unsolved part

Neither project reads a documented contract for showtimes.

- `book-my-show-notification` regex-extracts an inline blob:
  `var UAPI = JSON.parse("…")` from a `<script>` tag on the cinema page, then parses it
  with strict pydantic models
  ([source](https://github.com/deCodeIt/book-my-show-notification/blob/163589203890aa03d9229a1aab917b5090e17951/BookMyShow.py#L257-L316)).
- `ayush-cyber01/Bookmyshow_moviealert` does not parse at all. It runs
  `re.findall(r"20\d{6}")` over the raw HTML and declares tickets open if the target
  date is the single most frequent token and appears ≥10 times
  ([source](https://github.com/ayush-cyber01/Bookmyshow_moviealert/blob/main/poller.py#L165-L186)).

The second approach matches any 8-digit run starting with `20` — asset hashes, analytics
IDs, bundle chunks. A CDN filename change can flip the result. It is a heuristic
presented as a fact.

**Consequence for us:** the showtimes fetch strategy is the one genuinely open question.
Section 14 defines the spike that closes it. The provider interface (section 6) is shaped
so any of the three possible answers — clean JSON endpoint, embedded JSON blob, or
bot-walled requiring a browser — plugs in behind the same function signature without
touching anything downstream.

### 3.3 Both projects fail silently — the defect we exist to not have

A 403, a CAPTCHA interstitial, a Cloudflare page, or a geo-block all return **HTTP 200
with the wrong body**. That body matches no pattern, so both projects conclude "not open
yet" and keep going. Forever. The GitHub Actions run stays green while nothing is being
monitored.

Neither project can distinguish *"there are no tickets"* from *"my scraper is broken."*

This is the single most important thing to get right. See section 9.

### 3.4 Other structural weaknesses observed

| Weakness | Where | Our answer |
|---|---|---|
| Alerts fire once ever, then permanently silent | `Bookmyshow_moviealert` state flag | Per-show dedup ledger, not a global boolean (§8) |
| State stored as a git commit on `main` | `Bookmyshow_moviealert` workflow | SQLite |
| One watch per deployment | both | Many watches, one process (§5) |
| Presence in listing = "available" | `book-my-show-notification` | Track sold-out separately; presence ≠ bookable (§7) |
| No retries, or retries that catch the wrong exception | both | Typed errors + backoff (§9) |
| Requires interactive stdin | `book-my-show-notification` | Slash commands |
| Fixed 60s interval, no jitter, single IP | both | Jittered interval + request coalescing (§10) |

### 3.5 Geo-fencing

BookMyShow serves India and blocks datacenter IPs. US-based CI runners get a flat 403.
This constrains **hosting**, not code — see section 13.

---

## 4. Architecture

```
src/
  core/
    watch.ts        Watch model, validation
    diff.ts         Snapshot diffing → AlertEvent[]
    scheduler.ts    Poll loop, jitter, coalescing
    errors.ts       Typed provider errors
  providers/
    types.ts        Provider interface + normalised Show
    bms/
      client.ts     HTTP, headers, retry
      cities.ts     /discover/regions
      venues.ts     /pwa/api/de/venues
      shows.ts      showtimes (spike-gated)
      parse.ts      response → Show[]
  notify/
    types.ts        AlertEvent
    discord/
      embeds.ts     AlertEvent → Discord embed
      send.ts       channel dispatch
  bot/
    client.ts       discord.js client
    register.ts     slash command registration
    commands/
      watch.ts      add / list / remove
  store/
    db.ts           bun:sqlite, schema, migrations
    watches.ts      queries
  index.ts          wire-up + start
```

### The two seams

**Seam 1 — `providers/`.** Every provider returns the same normalised `Show[]`. `core/`
never imports anything from `providers/bms/`. Adding a second ticketing site is a new
folder implementing one interface.

**Seam 2 — `notify/`.** `core/` emits a typed `AlertEvent` and knows nothing about
Discord. Adding Telegram later is `notify/telegram/` plus one line in the dispatch map.

If either seam requires edits in `core/` to add a provider or a channel, the seam is
wrong.

### Data flow

```
scheduler tick
  → for each due watch: provider.fetchShows(target)      [coalesced by URL]
  → normalise to Show[]
  → diff against store/snapshots
  → AlertEvent[]
  → notify dispatch → Discord embed
  → record shows as seen, mark watch healthy
```

---

## 5. Data model

`bun:sqlite`, one file `seatsniper.db`. Built into the Bun runtime — no native module, no
compile toolchain.

```sql
CREATE TABLE watches (
  id            INTEGER PRIMARY KEY,
  user_id       TEXT    NOT NULL,        -- Discord user, who gets pinged
  channel_id    TEXT    NOT NULL,        -- where alerts land
  guild_id      TEXT,                    -- NULL for DMs
  provider      TEXT    NOT NULL DEFAULT 'bms',
  movie_query   TEXT    NOT NULL,        -- what the user typed
  movie_code    TEXT,                    -- resolved provider code, e.g. ET00502600
  city_code     TEXT    NOT NULL,        -- e.g. MUMBAI
  venue_code    TEXT,                    -- NULL = any theatre in city
  screen_type   TEXT,                    -- NULL = any; else IMAX / 4DX / 2D …
  date_from     TEXT,                    -- YYYY-MM-DD, NULL = any
  date_to       TEXT,
  time_band     TEXT,                    -- NULL | morning | afternoon | evening | night
  active        INTEGER NOT NULL DEFAULT 1,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  last_ok_at    INTEGER,                 -- unix seconds
  last_error    TEXT,
  created_at    INTEGER NOT NULL
);

-- Doubles as snapshot AND alert-dedup ledger. A show present here has been
-- seen and already alerted on; anything absent is new by definition.
CREATE TABLE seen_shows (
  watch_id      INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  show_id       TEXT    NOT NULL,
  show_date     TEXT    NOT NULL,        -- denormalised so new-date diff is one query
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (watch_id, show_id)
);

CREATE TABLE alerts (
  id         INTEGER PRIMARY KEY,
  watch_id   INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,           -- bookings_open | new_date | new_show | provider_failing
  payload    TEXT    NOT NULL,           -- JSON, for /history later
  sent_at    INTEGER NOT NULL
);

CREATE INDEX idx_watches_active ON watches(active, last_ok_at);
CREATE INDEX idx_seen_date      ON seen_shows(watch_id, show_date);
```

**Why `seen_shows` instead of a JSON snapshot blob:** one table serves as both the
previous-state snapshot and the dedup ledger. Diffing becomes a set difference, and
"have we already alerted on this show?" is answered by the same primary key. It also
fixes `Bookmyshow_moviealert`'s fire-once-ever bug structurally — there is no global
boolean to get stuck.

---

## 6. Provider interface

```ts
// providers/types.ts

export type CityRef  = { code: string; name: string };
export type VenueRef = { code: string; name: string; cityCode: string };
export type MovieRef = { code: string; title: string };

export type Show = {
  id:          string;          // stable across polls: `${provider}|${venueCode}|${sessionId}`
  movieCode:   string;
  movieTitle:  string;
  venueCode:   string;
  venueName:   string;
  screenType:  string | null;   // IMAX | 4DX | 2D | ICE | null if provider omits it
  date:        string;          // YYYY-MM-DD
  time:        string;          // HH:mm, 24h, venue-local
  bookingUrl:  string;
  soldOut:     boolean | null;  // null = provider does not say
  priceMin:    number | null;
  priceMax:    number | null;
};

export type WatchTarget = {
  movieCode?:  string;
  movieQuery:  string;
  cityCode:    string;
  venueCode?:  string;
  screenType?: string;
  dateFrom?:   string;
  dateTo?:     string;
};

export interface Provider {
  readonly id: string;
  listCities(): Promise<CityRef[]>;
  listVenues(cityCode: string): Promise<VenueRef[]>;
  searchMovies(query: string, cityCode: string): Promise<MovieRef[]>;

  /** Returns every currently-bookable show matching the target.
   *  MUST throw ProviderError on any response it cannot confidently parse.
   *  MUST NOT return [] to mean "something went wrong". */
  fetchShows(target: WatchTarget): Promise<Show[]>;
}
```

That doc comment on `fetchShows` is the contract that separates this project from the
prior art. An empty array means *verified zero shows*. Anything else throws.

**`Show.id` stability matters.** If the id changes between polls for the same physical
show, every poll re-alerts. It must derive from provider-issued identifiers (session /
showtime code + venue code), never from array index or from mutable fields like price.
The spike must confirm a stable session identifier exists; if none does, the fallback
composite is `venueCode|date|time|screenType`, which is stable but merges two genuinely
distinct shows only in the impossible case of identical venue, date, time and format.

---

## 7. Change detection

```ts
// core/diff.ts
function diff(watch: Watch, fresh: Show[], seen: SeenShow[]): AlertEvent[]
```

Algorithm:

1. `freshIds = new Set(fresh.map(s => s.id))`, `seenIds = new Set(seen.map(s => s.show_id))`
2. `newShows = fresh.filter(s => !seenIds.has(s.id))`
3. If `newShows` is empty → no events. Done.
4. If `seen` was empty and `fresh` is non-empty → **one `bookings_open` event** carrying
   all shows. (First time this watch ever saw anything bookable.)
5. Otherwise, partition `newShows` by date:
   - dates absent from `seen` → **`new_date` event** per date
   - dates already in `seen` → **`new_show` event** carrying those shows
6. Insert all `newShows` into `seen_shows`.

Disappearing shows are recorded but **not** alerted in MVP — a show vanishing usually
means sold out, and "it's gone" is not actionable. The row stays in `seen_shows` so it
does not re-alert if it returns. (Re-alert on return is the seat-availability feature,
section 16.)

Filtering (`screenType`, `timeBand`, date range) is applied to `fresh` **before** diffing,
in `core/`, not in the provider. The provider returns everything it found; core decides
what this watch cares about. That keeps request coalescing (§10) possible — two watches
on the same theatre share one fetch and filter differently.

### Worked example

```
Poll 1: fresh = []                          seen = {}         → no events, watch healthy
Poll 2: fresh = [A(Fri), B(Fri)]            seen = {}         → bookings_open [A, B]
Poll 3: fresh = [A, B]                      seen = {A, B}     → no events
Poll 4: fresh = [A, B, C(Sat)]              seen = {A, B}     → new_date Sat [C]
Poll 5: fresh = [A, B, C, D(Sat 21:30)]     seen = {A,B,C}    → new_show [D]
Poll 6: fresh = [A, C, D]  (B sold out)     seen = {A,B,C,D}  → no events
Poll 7: provider throws                     seen unchanged    → fail_count++, no false negative
```

Poll 7 is the case both competitors get wrong: they would treat it as `fresh = []` and
silently conclude nothing is available.

---

## 8. Alert events and rendering

```ts
// notify/types.ts
export type AlertEvent =
  | { kind: 'bookings_open';   watch: Watch; shows: Show[] }
  | { kind: 'new_date';        watch: Watch; date: string; shows: Show[] }
  | { kind: 'new_show';        watch: Watch; shows: Show[] }
  | { kind: 'provider_failing'; watch: Watch; error: string; consecutiveFailures: number };
```

Discord rendering (`notify/discord/embeds.ts`) — one embed per event, brand red
`#E01B24` from the logo, mention the watch owner outside the embed so the ping actually
fires:

```
@ishan
┌─────────────────────────────────────┐
│ 🎯 BOOKINGS OPEN                    │
│ Avatar: Fire and Ash                │
│                                     │
│ 📍 PVR Phoenix, Lower Parel         │
│ 🎬 IMAX 2D                          │
│ 📅 Sat 2 Aug                        │
│ 🕘 18:30 · 21:45 · 23:00            │
│                                     │
│ [Book now →]                        │
└─────────────────────────────────────┘
```

Shows are grouped by venue + date, times listed inline. A `provider_failing` embed is
visually distinct (grey, ⚠️) and says plainly: *"I can't read BookMyShow right now — this
is a SeatSniper problem, not a 'no tickets' answer."*

Rate limiting: at most one message per watch per poll cycle. Multiple events for the same
watch in one cycle are batched into a single message with multiple embeds (Discord allows
10 per message).

---

## 9. Error handling — the core differentiator

```ts
// core/errors.ts
export class ProviderError extends Error {
  constructor(
    readonly kind: 'network' | 'blocked' | 'unparseable' | 'not_found' | 'rate_limited',
    message: string,
    readonly context?: { url?: string; status?: number; bodySample?: string },
  ) { super(message); }
}
```

**Rules, non-negotiable:**

1. `fetchShows` never returns `[]` to signal a problem. Ambiguity is the bug.
2. Any response that does not parse into the expected shape throws `unparseable`, with a
   truncated body sample attached for debugging.
3. A response that parses but is obviously not the intended page — no venue block, a
   CAPTCHA marker, a "region unavailable" string — throws `blocked`.
4. HTTP status is checked. 403/429 throw before any parsing is attempted.
5. **Never** a silent fallback to a looser parse. If the primary parse fails, that is a
   real signal that BookMyShow changed; it must surface, not get papered over.

**Escalation:**

| Consecutive failures | Behaviour |
|---|---|
| 1–2 | Retry next cycle with exponential backoff. Log only. |
| 3 | Post one `provider_failing` alert to the watch's channel. |
| 4–9 | Keep polling at reduced frequency. Stay silent (already warned). |
| 10 | Mark watch `active = 0`, post a final "paused, use `/watch resume`" message. |

`fail_count` resets to 0 on any successful fetch. Success also updates `last_ok_at`, so
`/watch list` can show real freshness rather than the last attempt.

---

## 10. Polling strategy

- **One in-process loop**, `setInterval`, tick every 30 s. Each tick selects watches whose
  `last_ok_at` is older than their interval.
- **Base interval 5 min**, with **±20% jitter** per watch. Jitter avoids a synchronised
  burst of requests every 5 minutes from one IP — the pattern that most obviously reads as
  a bot.
- **Adaptive**: a watch whose target date is within 48 h polls at 2 min. A watch whose
  target is >30 days out polls at 30 min. Same total watches, far fewer requests.
- **Request coalescing** (brief Q9): within a tick, all fetches are keyed by their resolved
  URL in a `Map<string, Promise<Show[]>>`. Ten users watching PVR Phoenix on the same date
  produce **one** HTTP request. The map is created fresh each tick, so it is a
  within-cycle cache with no staleness risk.
- **Backoff on failure**, per section 9.

Answering brief Q10: cost is minimised by coalescing (fewer requests than watches),
adaptive intervals (requests concentrated where they matter), and running one small
always-on process rather than per-watch jobs.

---

## 11. Slash commands

| Command | Options | Behaviour |
|---|---|---|
| `/watch add` | `movie` (autocomplete), `city` (autocomplete), `theatre?` (autocomplete, filtered by city), `screen?`, `date?`, `time?` | Resolves codes via provider, creates watch, confirms with a summary embed |
| `/watch list` | — | Table of the caller's watches: movie, city, theatre, status, last checked |
| `/watch remove` | `id` (autocomplete from caller's watches) | Deletes watch and its `seen_shows` |
| `/watch pause` / `/watch resume` | `id` | Toggle `active` |

Autocomplete is what makes this feel like a product rather than a script — the user never
types a `city_code` or an `ET00502600`. Discord gives 3 s to respond to an autocomplete
interaction, so city and venue lists are fetched once at startup and cached in memory;
they change rarely.

Commands are registered to a single guild in dev (instant) and globally in prod
(~1 h propagation). Controlled by `DISCORD_GUILD_ID` presence.

---

## 12. Configuration

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token |
| `DISCORD_CLIENT_ID` | yes | For command registration |
| `DISCORD_GUILD_ID` | no | Dev-mode instant command registration |
| `POLL_INTERVAL_SEC` | no | Base interval, default 300 |
| `DB_PATH` | no | Default `./seatsniper.db` |
| `HTTP_PROXY` | no | Only needed if hosting outside India |

`.env` is gitignored; `.env.example` documents the shape. Validated at startup — the
process refuses to boot with a missing required variable rather than failing at first use.

---

## 13. Deployment

**Constraint:** BookMyShow geo-fences to India and blocks datacenter IPs. This rules out
the obvious free options — Vercel, US-region Fly.io, GitHub Actions runners — unless a
proxy is added, which costs money and adds a failure mode.

**MVP plan:** run the process on an always-on machine with an Indian residential or
India-region IP. In order of preference:

1. **Local machine / home server** — free, correct IP, fine for a single user. Start here.
2. **Oracle Cloud Free Tier ARM instance, Mumbai region** — genuinely free, always-on,
   Indian IP. The upgrade path when it needs to outlive a laptop.
3. Any India-region VPS (~₹350/month) if free tiers prove unreliable.

Bun compiles to a single executable (`bun build --compile`), so deployment is: copy one
binary plus `.env` plus the `.db` file. No runtime install.

**Cost at MVP scale: ₹0.** No managed database, no queue, no proxy service.

---

## 14. The spike — the one open question

Everything above is settled except *how showtimes are actually fetched*. Before writing
`providers/bms/shows.ts`:

1. Open a BookMyShow cinema showtimes page in Chrome DevTools from an Indian connection.
2. Read the Network tab. Determine which of these is true:
   - **(a)** A clean JSON endpoint returns showtimes → best case, use it directly.
   - **(b)** Data is server-rendered into an inline script (`UAPI`, `__NEXT_DATA__`, or
     similar) → parse that, and pin the extraction to a named key rather than a loose regex.
   - **(c)** Rendered client-side behind bot protection → the only case that justifies a
     headless browser, which changes the hosting story.
3. Verify the two lookup endpoints from §3.1 still respond in 2026 — that code is from 2023.
4. Confirm a **stable per-show identifier** exists in the response (see §6).
5. Capture one real response body and commit it as a test fixture.

**Deliverable:** a short findings note appended to this spec, plus the fixture. Only then
does provider code get written.

Timebox: one session. If (c) turns out to be true, that is a design change worth
discussing before proceeding, not something to absorb silently.

---

## 15. Testing

`bun test`. Not extensive — targeted at the parts where a bug is silent.

| Test | Why |
|---|---|
| `diff.test.ts` — the 7-poll sequence in §7 as assertions | Diff logic is where a bug means either spam or silence, and neither is visible in logs |
| `parse.test.ts` — real captured BMS response → expected `Show[]` | Golden fixture; catches BookMyShow changing shape |
| `parse.test.ts` — CAPTCHA page / 403 body / empty HTML → **throws** | Directly tests the §9 contract. This is the test the competitors don't have |
| `showId.test.ts` — same show across two fetches → same id | Prevents the re-alert-every-poll failure |

No mocking framework, no fixtures directory ceremony. Captured responses live next to the
tests as `.json` / `.html` files.

---

## 16. Roadmap

Each item names the module it lands in. Nothing here requires changing `core/`.

**Next after MVP**
- `notify/telegram/` — second channel, proves seam 2 (one file)
- `/watch history` — read from the `alerts` table, already being written
- Seat availability — `providers/bms/seats.ts` + a `seat_snapshot` table; re-alert on
  return is the diff rule §7 deliberately deferred

**Later**
- Seat preferences (last two rows, centre block) — filter in `core/`, needs seat maps first
- Price-change alerts — `Show.priceMin/Max` are already in the model, unused in MVP
- `providers/district/` — second provider, proves seam 1
- Web dashboard — separate app reading the same SQLite, or Postgres if it outgrows it
- Web push / PWA — `notify/webpush/`

**Explicitly not planned:** automated booking, seat holding, credential storage.

---

## 17. Open risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| BookMyShow changes page structure | High, eventually | Loud failure (§9) means we find out in minutes, not weeks. Golden-file test catches it in CI |
| Bot detection blocks polling | Medium | Jitter, coalescing, realistic headers, modest interval. If it escalates, that is a real reconsideration point |
| Spike outcome (c) — browser required | Unknown until spiked | Changes hosting and cost; flagged for discussion, not absorbed |
| Show id instability causes alert spam | Medium | Dedicated test (§15); composite fallback (§6) |
| SQLite contention | Very low at this scale | Single process, single writer. Revisit only if a dashboard adds a second writer |
