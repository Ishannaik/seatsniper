# New Cinema Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On movie subscriptions (`date:any`), DM when a new cinema starts listing the movie in that city — via venue-set diff on buytickets SSR HTML.

**Architecture:** Widen BMS parsing to read `venue-card` blocks (`venueCode` + `venueName` + nested sessions). Add a `seen_venues` ledger mirroring `seen_dates`. Seed silently on subscribe and on first post-upgrade poll; alert only on later additions. Reuse the probe-date fetch so coalescing stays one request per movie/city.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, discord.js embeds in `messages.ts`, existing Safari TLS path in `bms.ts` (do not add the JSON showtimes API).

## Global Constraints

- Never Chrome TLS profiles; never custom headers on `node-tls-client` sessions.
- Errors are not empty results — missing venue-cards when the page otherwise looks like a showtimes page → throw `BmsError`, don't treat as “no new cinemas”.
- Record `seen_venues` / `seen_dates` only after successful DM delivery.
- No MX4D / format filters; no favourite-cinema shortlist; dated one-shot watches unchanged.
- Voice: terse, factual (`messages.ts` MESSAGE PLAN). LIVE green for alerts only.

## File map

| File | Role |
|---|---|
| `src/bms.ts` | Parse venue-cards; attach venue to shows; return venues from probe fetch + cache |
| `src/bms.test.ts` | Fixtures + parser / venue-set tests |
| `src/db.ts` | `seen_venues` table + helpers + silent-seed predicate |
| `src/messages.ts` | `newCinemas`, combined alert, armed-copy tweak, list wording |
| `src/index.ts` | Seed on subscribe; diff + DM in `checkSubscription` |

**Spec:** `docs/superpowers/specs/2026-07-29-new-cinema-alerts-design.md`

---

### Task 1: Parse venue-cards into shows + venue list

**Files:**
- Modify: `src/bms.ts` (`Show` type, `parseShows`, add `parseVenues` / venue extraction)
- Modify: `src/bms.test.ts`

**Interfaces:**
- Produces:
  - `Show` gains `venueCode: string` and `venueName: string` (empty string only if genuinely absent — prefer always filled from venue-card parse)
  - `parseVenues(html: string): { code: string; name: string }[]` — unique by `code`, stable order first-seen
  - `parseShows(html)` must populate venue fields from parent venue-card

- [ ] **Step 1: Write the failing tests**

Add a fixture that mirrors the live shape (trimmed):

```ts
const VENUE_HTML = `
"data":[{"type":"venue-card","additionalData":{"venueCode":"MCIW","venueName":"Miraj Cinemas: IMAX, Wadala"},
"showtimes":[{"title":"04:30 PM","screenAttr":"IMAX",
"additionalData":{"sessionId":"19229","availStatus":"3","cutOffDateTime":"202607300500","cutOffDateTimeEpoch":"1","showDateCode":"20260730","showDateTime":"202607300430","showTimeCode":"0430","showTime":"04:30 PM","attributes":"IMAX"}}]},
{"type":"venue-card","additionalData":{"venueCode":"IMOB","venueName":"INOX Megaplex: Sky City Mall, Borivali"},
"showtimes":[{"title":"04:45 PM","screenAttr":"IMAX",
"additionalData":{"sessionId":"19230","availStatus":"3","cutOffDateTime":"202607300515","cutOffDateTimeEpoch":"1","showDateCode":"20260730","showDateTime":"202607300445","showTimeCode":"0445","showTime":"04:45 PM","attributes":"IMAX"}}]}]
`;
```

Tests:

```ts
test("parseShows lifts venueCode/venueName from venue-card parent", () => {
  const shows = parseShows(VENUE_HTML);
  expect(shows).toHaveLength(2);
  expect(shows[0]).toMatchObject({
    sessionId: "19229", venueCode: "MCIW", venueName: "Miraj Cinemas: IMAX, Wadala",
    showDateCode: "20260730", attributes: "IMAX",
  });
  expect(shows[1]).toMatchObject({ sessionId: "19230", venueCode: "IMOB" });
});

test("parseVenues returns unique codes with names", () => {
  expect(parseVenues(VENUE_HTML)).toEqual([
    { code: "MCIW", name: "Miraj Cinemas: IMAX, Wadala" },
    { code: "IMOB", name: "INOX Megaplex: Sky City Mall, Borivali" },
  ]);
});
```

Update the existing `REAL` / `parseShows extracts every show` expectation to include `venueCode` / `venueName` (empty strings if that fixture has no venue-cards — or extend `REAL` with a venue-card wrapper so fields are real).

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun test src/bms.test.ts
```

Expected: new tests fail (no `venueCode` on `Show` / no `parseVenues`).

- [ ] **Step 3: Implement parser**

In `src/bms.ts`:

1. Extend `Show`:
```ts
export type Show = {
  sessionId: string;
  availStatus: string;
  showDateCode: string;
  showTime: string;
  attributes: string;
  epoch: number;
  venueCode: string;
  venueName: string;
};
```

2. Replace / extend `parseShows` to walk venue-card blocks:
   - Find each `"type":"venue-card"` slice until the next venue-card (same approach as the 2026-07-29 probe).
   - Read `venueCode` / `venueName` from that slice.
   - Run the existing `additionalData` session regex **inside the slice**, attaching parent venue to each show.
   - If HTML contains `showtimesSections` but **zero** venue-cards and at least one sessionId elsewhere, throw `BmsError("unparseable", …)` — page reshaped. If neither sessions nor venue-cards, return `[]` (real empty page).

3. Add:
```ts
export function parseVenues(html: string): { code: string; name: string }[] {
  const out: { code: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const s of parseShows(html)) {
    if (!s.venueCode || seen.has(s.venueCode)) continue;
    seen.add(s.venueCode);
    out.push({ code: s.venueCode, name: s.venueName });
  }
  return out;
}
```

Keep `showsOnDate` unchanged (filters on `showDateCode` only).

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test src/bms.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/bms.ts src/bms.test.ts
git commit -m "Parse BMS venue-card blocks into shows with venueCode/name"
```

---

### Task 2: `seen_venues` ledger + silent-seed rule

**Files:**
- Modify: `src/db.ts`
- Create: `src/db.test.ts` (new — Bun test against a temp DB file)

**Interfaces:**
- Consumes: existing `Watch` / `addWatch` patterns
- Produces:
  - `seenVenues(watchId: number): string[]`
  - `recordSeenVenues(watchId: number, codes: string[]): void`
  - `shouldSilentSeedVenues(watchId: number): boolean` — true when `seen_venues` is empty **and** the watch already has at least one `seen_dates` row (pre-upgrade subscription)

- [ ] **Step 1: Write failing tests**

```ts
import { expect, test, beforeEach, afterEach } from "bun:test";
// Point DB_PATH at a temp file before importing db, or export a test helper.
// Prefer: set process.env.DB_PATH = `test-${Date.now()}.db` then dynamic import.

test("recordSeenVenues then seenVenues round-trips", () => {
  // addWatch → id, recordSeenVenues(id, ["MCIW","IMOB"]), expect seenVenues sorted or insertion order
});

test("shouldSilentSeedVenues is true when dates exist but venues empty", () => {
  // addWatch subscription, recordSeenDates(id, ["20260730"]), expect shouldSilentSeedVenues(id) === true
});

test("shouldSilentSeedVenues is false after venues recorded", () => {
  // recordSeenVenues then expect false
});

test("shouldSilentSeedVenues is false for brand-new sub with no dates yet", () => {
  // addWatch only → false (subscribe path seeds explicitly; empty means "nothing listed" not upgrade)
});
```

**Clarify brand-new:** Spec migration only. Brand-new subscribe always calls `recordSeenVenues` explicitly. `shouldSilentSeedVenues` is **only** for poll path on upgraded DBs: empty venues + non-empty dates ⇒ seed silently.

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test src/db.test.ts
```

- [ ] **Step 3: Implement in `db.ts`**

Add table next to `seen_dates`:

```sql
CREATE TABLE IF NOT EXISTS seen_venues (
  watch_id    INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  venue_code  TEXT    NOT NULL,
  PRIMARY KEY (watch_id, venue_code)
);
```

Implement helpers mirroring `seenDates` / `recordSeenDates`.

```ts
export function shouldSilentSeedVenues(watchId: number): boolean {
  const venues = seenVenues(watchId);
  if (venues.length) return false;
  return seenDates(watchId).length > 0;
}
```

Note: `bun:sqlite` module state is process-wide — for tests, set `DB_PATH` **before** first import, or refactor to `openDb(path)` if needed. Prefer env `DB_PATH` set in `beforeAll` with a unique tempfile and `import` after, matching how production uses `process.env.DB_PATH`.

- [ ] **Step 4: Run — expect PASS**

```bash
bun test src/db.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "Add seen_venues ledger for cinema subscription diffs"
```

---

### Task 3: Probe fetch returns venues (coalesced)

**Files:**
- Modify: `src/bms.ts` (`fetchBookableDates`, `bookableDatesCached` return type)
- Modify: `src/bms.test.ts` (unit-level: `parseVenues` already covered; optional assert `fetchBookableDates` typing only)
- Modify: any callers that destructure `{ title, dates }` — update in this task’s compile fix, wire behaviour in Task 5

**Interfaces:**
- Produces:
```ts
fetchBookableDates(t): Promise<{ title: string; dates: string[]; venues: { code: string; name: string }[] }>
bookableDatesCached(t): Promise<{ title: string; dates: string[]; venues: { code: string; name: string }[] }>
```

- [ ] **Step 1: Update return types and implementation**

```ts
export async function fetchBookableDates(
  t: Omit<Target, "date">,
): Promise<{ title: string; dates: string[]; venues: { code: string; name: string }[] }> {
  const { title, html } = await fetchPage({ ...t, date: PROBE_DATE });
  return { title, dates: parseBookableDates(html), venues: parseVenues(html) };
}
```

Update the cycle map type to match.

- [ ] **Step 2: Fix TypeScript call sites that only need dates**

In `src/index.ts`, temporary `const { dates } = await bookableDatesCached(...)` still works. `subscribeToMovie` currently uses `fetchBookableDates` — leave venue seeding for Task 5, but ensure it compiles (`venues` unused OK).

- [ ] **Step 3: Run unit tests**

```bash
bun test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/bms.ts src/index.ts
git commit -m "Return venue list from bookable-dates probe fetch"
```

---

### Task 4: Discord messages for new cinemas

**Files:**
- Modify: `src/messages.ts`
- Create: `src/messages.test.ts` (light — assert title/description contain cinema names; or skip if no prior message tests — prefer one test constructing embeds and checking `.data.title` / field values)

**Interfaces:**
- Produces:
```ts
newCinemas(opts: {
  title: string;
  city: string;
  venues: { code: string; name: string }[];
  url: string;
}): { embeds: EmbedBuilder[]; components: ActionRowBuilder[] }

subscriptionAlert(opts: {
  title: string;
  city: string;
  dates: string[];           // may be empty
  venues: { code: string; name: string }[]; // may be empty
  url: string;
}): …  // combined when both non-empty; delegates to newDates / newCinemas when only one
```

- Update `armedForMovie` description to mention new cinemas as well as dates (one sentence).
- Update `watchList` subscription line from `every new date` → `every new date or cinema`.

- [ ] **Step 1: Implement `newCinemas`**

```ts
export function newCinemas(opts: {
  title: string; city: string; venues: { code: string; name: string }[]; url: string;
}) {
  const list = opts.venues.slice(0, 8)
    .map((v) => `**${v.name}** (\`${v.code}\`)`)
    .join("\n");
  const extra = opts.venues.length - Math.min(opts.venues.length, 8);
  const embed = sig(new EmbedBuilder(), "Alert")
    .setColor(LIVE)
    .setTitle(`${opts.title} — ${opts.venues.length === 1 ? "new cinema" : `${opts.venues.length} new cinemas`}`)
    .setURL(opts.url)
    .setDescription(
      `Now listing in ${titleCase(opts.city)}:\n${list}` +
        (extra > 0 ? `\n_+${extra} more_` : "") +
        "\n\nI'll keep watching for more.",
    )
    .setTimestamp();
  return { embeds: [embed], components: [bookButton(opts.url)] };
}
```

- [ ] **Step 2: Implement `subscriptionAlert`**

```ts
export function subscriptionAlert(opts: {
  title: string; city: string; dates: string[];
  venues: { code: string; name: string }[]; url: string;
}) {
  if (opts.dates.length && opts.venues.length) {
    const embed = sig(new EmbedBuilder(), "Alert")
      .setColor(LIVE)
      .setTitle(`${opts.title} — new dates & cinemas`)
      .setURL(opts.url)
      .setDescription(`Updates in ${titleCase(opts.city)}.`)
      .addFields(
        { name: "New dates", value: opts.dates.map(prettyDate).join(" · ") },
        {
          name: "New cinemas",
          value: opts.venues.slice(0, 8).map((v) => `**${v.name}** (\`${v.code}\`)`).join("\n"),
        },
      )
      .setTimestamp();
    return { embeds: [embed], components: [bookButton(opts.url)] };
  }
  if (opts.dates.length) return newDates(opts);
  return newCinemas(opts);
}
```

- [ ] **Step 3: Tweak `armedForMovie` + `watchList` copy** as above.

- [ ] **Step 4: Run tests**

```bash
bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/messages.ts src/messages.test.ts
git commit -m "Add Discord embeds for new-cinema subscription alerts"
```

---

### Task 5: Wire subscribe + poll

**Files:**
- Modify: `src/index.ts` (`subscribeToMovie`, `checkSubscription`)

**Interfaces:**
- Consumes: `fetchBookableDates` / `bookableDatesCached` venues, `recordSeenVenues`, `seenVenues`, `shouldSilentSeedVenues`, `subscriptionAlert`

- [ ] **Step 1: Seed venues in `subscribeToMovie`**

After successful `addWatch` and `recordSeenDates(id, dates)`:

```ts
recordSeenVenues(id, venues.map((v) => v.code));
```

Destructure `venues` from `fetchBookableDates`. Pass through to `armedForMovie` only if you extend that helper; otherwise copy tweak alone is enough.

- [ ] **Step 2: Extend `checkSubscription`**

```ts
async function checkSubscription(w: Watch) {
  let dates: string[];
  let venues: { code: string; name: string }[];
  try {
    ({ dates, venues } = await bookableDatesCached({
      city: w.city, slug: w.slug, eventCode: w.event_code,
    }));
  } catch (e) {
    markFail(w.id, (e as Error).message);
    if (w.fail_count + 1 === 3) await dm(w, failEmbed(w, e as Error));
    return;
  }
  markOk(w.id);

  if (shouldSilentSeedVenues(w.id)) {
    recordSeenVenues(w.id, venues.map((v) => v.code));
    // still process dates below as today
  }

  const knownDates = new Set(seenDates(w.id));
  const freshDates = dates.filter((d) => !knownDates.has(d));

  const knownVenues = new Set(seenVenues(w.id));
  const freshVenues = shouldSilentSeedVenues(w.id)
    ? [] // already seeded above; never alert on upgrade snapshot
    : venues.filter((v) => !knownVenues.has(v.code));

  // Re-read: after silent seed, shouldSilentSeedVenues becomes false.
  // Implement silent seed FIRST, then compute freshVenues with empty skip:

  // Better structure:
  // 1. if shouldSilentSeedVenues → recordSeenVenues(all); freshVenues = []
  // 2. else freshVenues = venues.filter(code not in seen)
  // 3. freshDates as today
  // 4. if !freshDates.length && !freshVenues.length return
  // 5. dm(subscriptionAlert(...)); on success recordSeenDates + recordSeenVenues

  const url = showtimesUrl({
    city: w.city, slug: w.slug, eventCode: w.event_code,
    date: freshDates[0] ?? dates[0] ?? PROBE_DATE,
  });
  // Import PROBE_DATE only if needed; prefer dates[0] or todayIST()-like open date.
}
```

Use this exact control flow:

```ts
markOk(w.id);

let freshVenues: { code: string; name: string }[];
if (shouldSilentSeedVenues(w.id)) {
  recordSeenVenues(w.id, venues.map((v) => v.code));
  freshVenues = [];
} else {
  const known = new Set(seenVenues(w.id));
  freshVenues = venues.filter((v) => !known.has(v.code));
}

const knownDates = new Set(seenDates(w.id));
const freshDates = dates.filter((d) => !knownDates.has(d));
if (!freshDates.length && !freshVenues.length) return;

const url = showtimesUrl({
  city: w.city,
  slug: w.slug,
  eventCode: w.event_code,
  date: freshDates[0] ?? dates[0] ?? "20991231",
});

if (await dm(w, msg.subscriptionAlert({
  title: w.title, city: w.city, dates: freshDates, venues: freshVenues, url,
}))) {
  if (freshDates.length) recordSeenDates(w.id, freshDates);
  if (freshVenues.length) recordSeenVenues(w.id, freshVenues.map((v) => v.code));
} else {
  console.error(`[watch ${w.id}] undelivered, will retry`);
}
```

- [ ] **Step 3: Run full unit suite**

```bash
bun test
```

Expected: PASS.

- [ ] **Step 4: Manual smoke (optional on Windows residential)**

```bash
bun -e "import { parseVenues } from './src/bms.ts'; const html = await (await fetch('https://in.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917/20991231')).text(); console.log(parseVenues(html).slice(0,5));"
```

Expected: list including codes like `MCIW` / `IMOB` if that movie still lists.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "Alert subscriptions when new cinemas appear for a movie"
```

---

### Task 6: Spec self-check + docs touch

**Files:**
- Modify: `README.md` (one sentence under Usage: subscriptions also ping for new cinemas)
- Leave design spec as-is unless implementation drifted

- [ ] **Step 1: Update README Usage** to mention new-cinema alerts on `date:any`.
- [ ] **Step 2: Run `bun test` once more.**
- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document new-cinema alerts on movie subscriptions"
```

---

## Plan self-review

| Spec requirement | Task |
|---|---|
| Parse venueCode/Name from SSR venue-card | Task 1 |
| seen_venues ledger | Task 2 |
| Seed on subscribe | Task 5 |
| Silent seed for pre-upgrade subs | Task 2 + 5 |
| Diff + DM on subscription poll | Task 5 |
| Combined / cinema-only embeds | Task 4 |
| Coalesce via probe fetch | Task 3 |
| No format filters / dated watches unchanged | Global + Task 5 scope |
| Loud failure if reshaped | Task 1 unparseable rule |
| Record after delivery only | Task 5 |

No TBD placeholders. Types consistent: `venues: { code; name }[]` everywhere; DB stores codes only.
