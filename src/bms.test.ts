import { expect, test } from "bun:test";
import {
  parseWatchUrl, parseShows, parseVenues, showsOnDate, parseBookableDates, istToEpoch, prettyDate, PROBE_DATE, BmsError,
  parseFormatChips, matchesFormat,
} from "./bms.ts";

test("prettyDate formats a BMS date as a human-readable day", () => {
  expect(prettyDate("20260730")).toMatch(/Thu[,]? 30 Jul/);
});

test("prettyDate handles dates across month boundaries", () => {
  expect(prettyDate("20251231")).toMatch(/Wed[,]? 31 Dec/);
  expect(prettyDate("20260101")).toMatch(/Thu[,]? 1 Jan/);
});

test("prettyDate does not crash on invalid input", () => {
  expect(prettyDate("notdate")).toMatch(/Invalid/);
});

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

// ---------------------------------------------------------------- format chips

// Trimmed from a real 2026-08-10 Spider-Man: Brand New Day response. ScreenX (and
// other premium formats) are SEPARATE child event codes — their shows never appear
// under the parent event's attributes.
const CHIP_HTML = `
{"type":"chip","title":"2D","cta":{"type":"formatSelector","analytics":{"event_code":"ET00502600","format":"2D","screen_name":"movie_showtimes","uuid":"aaa"},"additionalData":{"eventCode":"ET00502600","eventUrl":"spider-man-brand-new-day","language":"English","refEventCode":"ET00502600","uuid":"bbb"}}},
{"type":"chip","title":"3D SCREEN X","cta":{"type":"formatSelector","analytics":{"event_code":"ET00502684","format":"3D SCREEN X","screen_name":"movie_showtimes","uuid":"ccc"},"additionalData":{"eventCode":"ET00502684","eventUrl":"spider-man-brand-new-day-3d-screen-x","language":"English","refEventCode":"ET00502684","uuid":"ddd"}}},
{"type":"chip","title":"IMAX 3D","cta":{"type":"formatSelector","analytics":{"event_code":"ET00502699","format":"IMAX 3D","screen_name":"movie_showtimes","uuid":"eee"},"additionalData":{"eventCode":"ET00502699","eventUrl":"spider-man-brand-new-day-imax-3d","language":"English","refEventCode":"ET00502699","uuid":"fff"}}}
`;

test("parseFormatChips extracts child event codes from format-selector chips", () => {
  const chips = parseFormatChips(CHIP_HTML);
  expect(chips).toEqual([
    { title: "2D", eventCode: "ET00502600", slug: "spider-man-brand-new-day" },
    { title: "3D SCREEN X", eventCode: "ET00502684", slug: "spider-man-brand-new-day-3d-screen-x" },
    { title: "IMAX 3D", eventCode: "ET00502699", slug: "spider-man-brand-new-day-imax-3d" },
  ]);
});

test("parseFormatChips returns [] for a page with no format selector", () => {
  expect(parseFormatChips("<html><body>no chips here</body></html>")).toEqual([]);
});

// ---------------------------------------------------------------- format matching

test("matchesFormat is case-insensitive: IMAX matches IMAX", () => {
  expect(matchesFormat("IMAX", "IMAX")).toBe(true);
  expect(matchesFormat("imax", "IMAX")).toBe(true);
});

test("matchesFormat substring: IMAX catches IMAX 3D", () => {
  expect(matchesFormat("IMAX 3D", "IMAX")).toBe(true);
});

test("matchesFormat space-insensitive: SCREENX catches 3D SCREEN X", () => {
  expect(matchesFormat("3D SCREEN X", "SCREENX")).toBe(true);
  expect(matchesFormat("3D SCREEN X", "SCREEN X")).toBe(true);
  expect(matchesFormat("3D SCREEN X", "SCREENX,SCREEN X")).toBe(true);
});

test("matchesFormat false when no token matches", () => {
  expect(matchesFormat("ATMOS", "SCREENX")).toBe(false);
  expect(matchesFormat("", "SCREENX")).toBe(false);
  expect(matchesFormat("IMAX", "4DX,SCREENX")).toBe(false);
});

test("matchesFormat multi-token filter needs only one hit", () => {
  expect(matchesFormat("4DX", "SCREENX,4DX")).toBe(true);
});
