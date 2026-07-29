# New Cinema Alerts — Design Spec

**Date:** 2026-07-29
**Status:** Approved for planning (approach 1 verified live)
**Repo:** SeatSniper

---

## 1. Objective

On a movie **subscription** (`/watch … date:any`), SeatSniper already DMs when a
**new date** unlocks. This feature adds the sibling signal: DM when a **new cinema**
starts listing that movie in the watched city.

No format filters (MX4D / IMAX / etc.). No “watch this one cinema only” mode yet.
Those are later cuts.

---

## 2. Scope

### In

| Capability | Detail |
|---|---|
| Parse venues from buytickets SSR HTML | Each show carries `venueCode` + `venueName` |
| Venue ledger on subscriptions | Like `seen_dates`, but for `venueCode` |
| New-cinema DM | List newly appeared cinemas by name (+ code) |
| Seed on subscribe | Baseline venues = currently listed; no spam of existing ones |
| Coalesce-friendly | Reuse existing poll / TLS / buytickets path |

### Out (this cut)

- Format / screen filters (MX4D, IMAX, …)
- Prefer a shortlist of favourite cinemas (`IMOB`, `MCIW`, …)
- Seat-layout URL as watch input
- Changing dated one-shot watches (`/watch` with a fixed date)
- Calling `/api/movies-data/v4/showtimes-by-event/…` (unproven on Safari TLS)

---

## 3. Verified page shape (2026-07-29)

Live fetch of
`/movies/mumbai/the-odyssey/buytickets/ET00480917/20991231`
(residential Bun `fetch`, HTTP 200, `__INITIAL_STATE__` present):

- `"type":"venue-card"` blocks carry:

```json
"additionalData": {
  "venueCode": "MCIW",
  "venueName": "Miraj Cinemas: IMAX, Wadala",
  …
}
```

- Nested under each card: showtimes with the existing `additionalData.sessionId`,
  `showDateCode`, `showTime`, `attributes`, etc.
- Measured: **9** unique venues (including `IMOB`, `MCIW`), **3** shows each.
- The flat `showtimesSections` tree used by today’s `parseShows` has **no**
  `venueCode` / `venueName`. Parsing must walk **venue-card** blocks (or an
  equivalent nesting that keeps venue → shows together).

Seat-layout URLs like
`/movies/mumbai/seat-layout/ET…/IMOB/19229/20260730` encode
`venueCode` / `sessionId` / date — useful for later filters, not required here.

---

## 4. Detection

Same buytickets poll. Widen parsing so each `Show` includes:

```ts
venueCode: string; // "MCIW"
venueName: string; // "Miraj Cinemas: IMAX, Wadala"
```

On each subscription poll:

1. Fetch bookable dates (existing coalesced probe) **and** the venue set for the
   movie/city (see §5 for request strategy).
2. `freshVenues = currentVenueCodes − seen_venues`.
3. If non-empty and DM succeeds → `recordSeenVenues` those codes.
4. First subscribe call seeds `seen_venues` with whatever is listed **now** and
   does **not** alert.

Stable identity is **`venueCode`**, not display name (names can be edited; codes
are what seat-layout URLs use).

---

## 5. Request strategy

Subscriptions today only call `bookableDatesCached` (probe date). That page
**does** include venue-cards for whatever bookable dates BMS injects — verified
on the probe URL. So one probe fetch can yield both:

- bookable date set (existing `parseBookableDates`)
- venue set (new `parseVenues` / shows-with-venue)

**Rule:** derive venues from the **same HTML** as the bookable-dates probe when
possible, so N subscriptions on one movie still coalesce to one request.

If the probe page has zero venue-cards while dates are non-empty (unexpected),
treat as `unparseable` / loud failure — never as “no new cinemas”. Empty venues
with empty dates is fine (nothing listed yet).

Dated one-shot watches keep current behaviour; they may ignore venue fields.

---

## 6. Storage

New table, mirror of `seen_dates`:

```sql
CREATE TABLE IF NOT EXISTS seen_venues (
  watch_id    INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  venue_code  TEXT    NOT NULL,
  PRIMARY KEY (watch_id, venue_code)
);
```

API (parallel to dates):

- `seenVenues(watchId): string[]`
- `recordSeenVenues(watchId, codes: string[]): void`

No schema change on `watches`. Subscriptions remain `date = ''`.

---

## 7. Bot / poll behaviour

### Subscribe (`subscribeToMovie`)

After `addWatch` + `recordSeenDates(id, dates)`:

- Parse venues from the same probe response (or one follow-up if the fetch
  helper is split — prefer one).
- `recordSeenVenues(id, venueCodes)`.
- Armed reply copy may mention that new cinemas will also be announced
  (one short line; don’t redesign the whole embed).

### Poll (`checkSubscription`)

After computing fresh dates (existing path):

- Compute fresh venues the same cycle.
- Prefer **one DM** if both dates and venues are new (combined embed), else
  separate DMs only if that stays clearer — **default: combined when both
  fire in the same poll**, else the existing date embed or a cinema-only embed.
- Record ledgers only after successful delivery (same undelivered-retry rule as
  dates).

### Dated watches

Unchanged. No cinema ledger.

---

## 8. Discord copy

Voice stays terse (see `messages.ts` plan).

**Cinema-only alert (LIVE green):**

- Title: `{movie} — new cinema`
- Body: city + list of `venueName` lines (cap ~8, then “+N more”)
- Button: Book now → buytickets URL for city/event (probe or first open date)

**Combined with new dates:** one embed, two fields (`New dates`, `New cinemas`).

Do not put venue codes in the title; optional `` `MCIW` `` suffix on each line is
fine for power users.

---

## 9. Edge cases

| Case | Behaviour |
|---|---|
| Cinema drops then returns | Code left `seen_venues` → no re-alert (same as dates) |
| Venue renamed, same code | No alert (correct) |
| Venue code recycled to a different cinema | Extremely unlikely; accept |
| DM closed | Channel fallback + only then mark seen (existing `dm()` contract) |
| Parse finds sessions but no venue-cards | Loud `BmsError` — page reshaped |
| Existing subscriptions before deploy | Next successful poll seeds missing `seen_venues` without alerting if the ledger is empty **and** this is the first run after upgrade — see migration note |

**Migration:** If `seen_venues` is empty for an old subscription that already has
`seen_dates`, treat the first post-upgrade venue snapshot as a **silent seed**
(not an alert). Otherwise every existing sub would spam every current cinema once.

---

## 10. Testing

- Unit: fixture HTML with 2 `venue-card`s → parse yields codes/names and nested
  sessions; venue set helper returns unique codes.
- Unit: diff logic — seed, then one new code → fresh = that code.
- Unit: migration silent-seed when `seen_venues` empty but watch is old.
- Keep existing `parseShows` tests green; either extend the fixture to
  venue-cards or add a parallel parser used by both shows and venues.

---

## 11. Non-goals reminder

SeatSniper still does not buy tickets, hold seats, or hit seat-layout / checkout
APIs. New-cinema alerts are observe-and-notify only.

---

## 12. Prior art used

- Venue-set diff: [iamgroot42 gist](https://gist.github.com/iamgroot42/85c1707f142dbca6758a325407cb0113) (name-based; we use codes)
- Show-key diff with `venueCode`: [aviiciii/bms-ticket-notifier](https://github.com/aviiciii/bms-ticket-notifier)
- SeatSniper measured SSR: this doc §3 + `2026-07-27-bms-access-findings.md`
