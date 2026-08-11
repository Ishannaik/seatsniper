import { expect, test } from "bun:test";
import * as tls from "node-tls-client";
import {
  parseWatchUrl, parseShows, parseVenues, showsOnDate, parseBookableDates, istToEpoch, PROBE_DATE, BmsError, prettyDate,
  DEFAULT_TLS_PROFILE, resolveTlsProfile, resolveClientIdentifier,
} from "./bms.ts";

// Trimmed from a real 2026-07-27 response for The Odyssey (ET00480917, Mumbai).
// Two shows on the 28th, one on the 27th — the exact shape BMS returns when it
// substitutes the nearest bookable date for one that isn't open.
const REAL = `
"showtimesSections":[{"data":[{"type":"venue-card","additionalData":{"venueCode":"PVRJ","venueName":"PVR: Juhu"},
"showtimes":[{"title":"06:40 AM","screenAttr":"IMAX",
"additionalData":{"sessionId":"14022","availStatus":"3","cutOffDateTime":"202607280655","cutOffDateTimeEpoch":"1785201900","showDateCode":"20260728","showDateTime":"202607280640","showTimeCode":"0640","showTime":"06:40 AM","attributes":"IMAX"},
"additionalData":{"sessionId":"14023","availStatus":"1","cutOffDateTime":"202607281010","cutOffDateTimeEpoch":"1785201901","showDateCode":"20260728","showDateTime":"202607280955","showTimeCode":"0955","showTime":"09:55 AM","attributes":"IMAX"},
"additionalData":{"sessionId":"13919","availStatus":"3","cutOffDateTime":"202607271400","cutOffDateTimeEpoch":"1785141000","showDateCode":"20260727","showDateTime":"202607271345","showTimeCode":"1345","showTime":"01:45 PM","attributes":"IMAX"}]}]}]`;

const VENUE_HTML = `
"data":[{"type":"venue-card","additionalData":{"venueCode":"MCIW","venueName":"Miraj Cinemas: IMAX, Wadala"},
"showtimes":[{"title":"04:30 PM","screenAttr":"IMAX",
"additionalData":{"sessionId":"19229","availStatus":"3","cutOffDateTime":"202607300500","cutOffDateTimeEpoch":"1","showDateCode":"20260730","showDateTime":"202607300430","showTimeCode":"0430","showTime":"04:30 PM","attributes":"IMAX"}}]},
{"type":"venue-card","additionalData":{"venueCode":"IMOB","venueName":"INOX Megaplex: Sky City Mall, Borivali"},
"showtimes":[{"title":"04:45 PM","screenAttr":"IMAX",
"additionalData":{"sessionId":"19230","availStatus":"3","cutOffDateTime":"202607300515","cutOffDateTimeEpoch":"1","showDateCode":"20260730","showDateTime":"202607300445","showTimeCode":"0445","showTime":"04:45 PM","attributes":"IMAX"}}]}]
`;

test("parseWatchUrl pulls city, slug, event code and date", () => {
  const r = parseWatchUrl(
    "https://in.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917/20260727",
  );
  expect(r).toEqual({ city: "mumbai", slug: "the-odyssey", eventCode: "ET00480917", date: "20260727" });
});

test("parseWatchUrl works without a trailing date", () => {
  const r = parseWatchUrl("https://in.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917");
  expect(r.eventCode).toBe("ET00480917");
  expect(r.date).toBeUndefined();
});

test("parseWatchUrl rejects a link with no event code instead of guessing", () => {
  expect(() => parseWatchUrl("https://in.bookmyshow.com/explore/movies-mumbai")).toThrow(BmsError);
});

// --- URL edge cases -------------------------------------------------------
const BASE = "in.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917/20260727";

test.each([
  ["https scheme", `https://${BASE}`],
  ["http scheme", `http://${BASE}`],
  ["no scheme", BASE],
  ["www subdomain", "https://www.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917/20260727"],
  ["mobile subdomain", "https://m.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917/20260727"],
  ["trailing slash", `https://${BASE}/`],
  ["utm query string", `https://${BASE}?utm_source=share&utm_medium=copy`],
  ["fragment", `https://${BASE}#showtimes`],
  ["discord <> wrapping", `<https://${BASE}>`],
  ["surrounding whitespace", `   https://${BASE}   `],
  ["uppercase event code", `https://${BASE}`.replace("ET00480917", "et00480917")],
])("parseWatchUrl handles %s", (_label, url) => {
  const r = parseWatchUrl(url);
  expect(r.eventCode).toBe("ET00480917");
  expect(r.city).toBe("mumbai");
});

test("a query string is never mistaken for the date", () => {
  expect(parseWatchUrl(`https://${BASE}?ref=20991231`).date).toBe("20260727");
});

// City changes which theatres exist (mumbai 51 shows, delhi 25, pune 10 for the
// same event and date), so guessing it would silently watch the wrong city.
test("parseWatchUrl refuses to guess the city", () => {
  expect(() =>
    parseWatchUrl("https://in.bookmyshow.com/buytickets/some-cinema/ET00480917/20260727"),
  ).toThrow(/city/i);
});

test("parseWatchUrl keeps the city the user actually gave", () => {
  expect(parseWatchUrl(`https://${BASE}`.replace("/mumbai/", "/pune/")).city).toBe("pune");
});

test("parseWatchUrl rejects a non-BookMyShow host", () => {
  expect(() => parseWatchUrl("https://evil.example.com/movies/mumbai/x/buytickets/ET00480917/20260727"))
    .toThrow(/bookmyshow/i);
});

// Slug is verified irrelevant to BMS, so a wrong one must not be an error.
test("a wrong slug is accepted, because BookMyShow ignores it", () => {
  const r = parseWatchUrl(`https://${BASE}`.replace("the-odyssey", "nonsense-slug"));
  expect(r.eventCode).toBe("ET00480917");
  expect(r.city).toBe("mumbai");
});

test("parseShows extracts every show with its real date", () => {
  const shows = parseShows(REAL);
  expect(shows).toHaveLength(3);
  expect(shows[0]).toEqual({
    sessionId: "14022", availStatus: "3", showDateCode: "20260728",
    showTime: "06:40 AM", attributes: "IMAX",
    epoch: istToEpoch("202607280640"),
    venueCode: "PVRJ", venueName: "PVR: Juhu",
  });
});

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

// Legacy flat showtimesSections tree — sessions present but no venue-cards means
// the page reshaped; must throw, not return [] or silently drop venue data.
const FLAT_SHOWTIMES = `
"showtimesSections":[{"showtimes":[{"title":"06:40 AM","screenAttr":"IMAX",
"additionalData":{"sessionId":"14022","availStatus":"3","cutOffDateTime":"202607280655","cutOffDateTimeEpoch":"1785201900","showDateCode":"20260728","showDateTime":"202607280640","showTimeCode":"0640","showTime":"06:40 AM","attributes":"IMAX"}}]}]`;

test("parseShows throws unparseable when showtimesSections has sessions but no venue-cards", () => {
  try {
    parseShows(FLAT_SHOWTIMES);
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(BmsError);
    expect((e as BmsError).kind).toBe("unparseable");
  }
});

// Discord renders <t:epoch:t> in the reader's own timezone, so the epoch has to be
// the real instant — 06:40 IST, not 06:40 UTC.
test("istToEpoch treats the wall clock as IST (UTC+5:30)", () => {
  const e = istToEpoch("202607280640");
  expect(new Date(e * 1000).toISOString()).toBe("2026-07-28T01:10:00.000Z");
});

test("every parsed show carries an epoch matching its date and time", () => {
  for (const s of parseShows(REAL)) {
    const iso = new Date(s.epoch * 1000).toISOString();
    expect(iso.startsWith("20")).toBe(true);
    expect(Number.isFinite(s.epoch)).toBe(true);
  }
});

test("bookable dates exclude the probe date BMS echoes back", () => {
  const html = `"dateCode":"20260728" "dateCode":"20260729" "dateCode":"${PROBE_DATE}"`;
  expect(parseBookableDates(html)).toEqual(["20260728", "20260729"]);
});

test("bookable dates are deduped and sorted", () => {
  const html = `"dateCode":"20260803" "dateCode":"20260728" "dateCode":"20260728"`;
  expect(parseBookableDates(html)).toEqual(["20260728", "20260803"]);
});

test("sessionId is stable across parses, so alerts can't repeat", () => {
  expect(parseShows(REAL).map((s) => s.sessionId)).toEqual(parseShows(REAL).map((s) => s.sessionId));
});

// The whole point of the project. BMS returns a 200 full of real shows for the
// WRONG date when the requested one isn't open. Counting shows, or matching
// "book tickets", reports a false positive here. Comparing showDateCode does not.
test("a date with no shows reads as unavailable even though the page is full of shows", () => {
  const shows = parseShows(REAL);
  expect(shows.length).toBeGreaterThan(0);
  expect(showsOnDate(shows, "20260730")).toHaveLength(0);
});

test("a date with shows reads as available", () => {
  expect(showsOnDate(parseShows(REAL), "20260728")).toHaveLength(2);
});

// --- TLS profile selection --------------------------------------------------
//
// The default is a measured value, not a preference: a Safari profile gets 200
// from a datacenter IP where Chrome profiles are challenged. These pin that the
// override cannot weaken it silently. No TLS session is opened — ClientIdentifier
// is a plain lookup table, so the resolution path is testable without network.

test("the TLS profile defaults to the pinned Safari one when unset", () => {
  expect(resolveTlsProfile({})).toBe(DEFAULT_TLS_PROFILE);
  expect(DEFAULT_TLS_PROFILE).toBe("safari_ios_18_0");
});

test("BMS_TLS_PROFILE overrides the default", () => {
  expect(resolveTlsProfile({ BMS_TLS_PROFILE: "safari_ios_17_0" })).toBe("safari_ios_17_0");
  expect(resolveTlsProfile({ BMS_TLS_PROFILE: "firefox_120" })).toBe("firefox_120");
});

test("a blank BMS_TLS_PROFILE falls back to the default rather than an empty name", () => {
  // An operator who comments the value out but leaves the key, or leaves
  // trailing whitespace, gets the default — not a lookup for "".
  expect(resolveTlsProfile({ BMS_TLS_PROFILE: "" })).toBe(DEFAULT_TLS_PROFILE);
  expect(resolveTlsProfile({ BMS_TLS_PROFILE: "   " })).toBe(DEFAULT_TLS_PROFILE);
  expect(resolveTlsProfile({ BMS_TLS_PROFILE: "  safari_ios_17_0  " })).toBe("safari_ios_17_0");
});

test("the default profile resolves to a real client identifier", () => {
  expect(resolveClientIdentifier(DEFAULT_TLS_PROFILE)).toBeTruthy();
});

test("every profile named in the docs is a real client identifier", () => {
  // Guards against documenting a profile that node-tls-client does not ship,
  // which would only surface as a startup crash on an operator's VPS.
  for (const profile of ["safari_ios_17_0", "safari_ios_18_0", "safari_16_0", "firefox_120"]) {
    expect(resolveClientIdentifier(profile)).toBeTruthy();
  }
});

test("an unknown profile fails loudly instead of falling back", () => {
  // The dangerous failure mode is a silent fallback: to the default (hiding the
  // typo) or to whatever the library picks (which could be Chrome). It must throw.
  try {
    resolveClientIdentifier("safari_ios_18_o"); // letter o, not zero
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(BmsError);
    expect((e as BmsError).kind).toBe("unparseable");
    expect((e as BmsError).message).toContain("BMS_TLS_PROFILE");
  }
});

test("an empty profile name is rejected, not treated as 'use anything'", () => {
  expect(() => resolveClientIdentifier("")).toThrow(BmsError);
});

test("a Chrome profile is rejected even though node-tls-client ships it", () => {
  // The library knowing the name is not the bar: BookMyShow serves Chrome
  // fingerprints Cloudflare challenges, so a bot started on one polls forever
  // and never notifies. Failing at startup is the only visible failure.
  const { ClientIdentifier } = tls as any;
  expect(ClientIdentifier.chrome_120).toBeTruthy(); // the library really does have it

  try {
    resolveClientIdentifier("chrome_120");
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(BmsError);
    expect((e as BmsError).kind).toBe("unparseable");
    expect((e as BmsError).message).toContain("BMS_TLS_PROFILE");
  }
});

test("every Chrome-family profile the library ships is rejected", () => {
  const { ClientIdentifier } = tls as any;
  const chromeKeys = Object.keys(ClientIdentifier).filter((k) => k.startsWith("chrome"));
  expect(chromeKeys.length).toBeGreaterThan(0);
  for (const key of chromeKeys) {
    expect(() => resolveClientIdentifier(key)).toThrow(BmsError);
  }
});

test("an unsupported profile is rejected on padding too, not just exact spelling", () => {
  expect(() => resolveClientIdentifier("  chrome_120  ")).toThrow(BmsError);
});

// --- prettyDate -------------------------------------------------------------
//
// The BMS date code is what every DM the bot sends is stamped with, so a
// regression here is visible to users on every alert. These pin the exact
// strings, not just "it returned something".

test("prettyDate renders a BMS date code as a human date", () => {
  expect(prettyDate("20260730")).toBe("Thu, 30 Jul");
  expect(prettyDate("20260728")).toBe("Tue, 28 Jul");
  expect(prettyDate("20261231")).toBe("Thu, 31 Dec");
});

test("prettyDate does not zero-pad a single-digit day", () => {
  // "5 Jan", not "05 Jan" — the day is formatted as numeric.
  expect(prettyDate("20260105")).toBe("Mon, 5 Jan");
  expect(prettyDate("20260803")).toBe("Mon, 3 Aug");
});

test("prettyDate handles a leap day", () => {
  expect(prettyDate("20240229")).toBe("Thu, 29 Feb");
});

test("prettyDate is stable across timezones", () => {
  // prettyDate builds the date in local time and formats it in local time, so
  // the day component cannot drift. The naive alternative — parsing
  // "2026-07-30" as a date-only string — is read as UTC midnight and lands on
  // the 29th anywhere behind UTC.
  const naive = (iso: string) =>
    new Date(iso).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

  const before = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Niue"]) {
      process.env.TZ = tz;
      expect(prettyDate("20260730")).toBe("Thu, 30 Jul");
    }
    // Control, so this test cannot quietly pass because the TZ switch is inert:
    // the naive form really does drift in the westmost zone above (UTC-11).
    process.env.TZ = "Pacific/Niue";
    expect(naive("2026-07-30")).toBe("Wed, 29 Jul");
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

// Characterization: these record what prettyDate does with input it does not
// promise to handle, so the behaviour is visible rather than surprising. Both
// are currently unreachable — index.ts routes an empty date to the
// subscription flow and messages.ts guards `w.date === ""` — so this documents
// a landmine for future callers, it does not report a live bug.

test("prettyDate on a non-numeric string is an explicit Invalid Date", () => {
  expect(prettyDate("notadate")).toBe("Invalid Date");
});

test("prettyDate fails silently on the empty subscription date", () => {
  // Number("") is 0, so this becomes new Date(0, -1, 0) — a real 1899 date
  // that formats without complaint. Never pass a subscription's date here.
  expect(prettyDate("")).toBe("Thu, 30 Nov");
});

test("prettyDate rolls an out-of-range month over instead of rejecting it", () => {
  // Month 13 of 2026 becomes January 2027; the Date constructor normalises.
  expect(prettyDate("20261301")).toBe("Fri, 1 Jan");
});
