import { expect, test } from "bun:test";
import * as tls from "node-tls-client";
import {
  DEFAULT_TLS_PROFILE,
  PROBE_DATE,
  parseBookableDates,
  parseFormatChips,
  parseMoviePoster,
  parseShows,
  parseVenues,
  parseWatchUrl,
  resolveClientIdentifier,
  resolveTlsProfile,
} from "./bms.ts";
import { showsOnDate } from "./movie-model.ts";
import { BmsError } from "./provider-error.ts";

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
  expect(
    parseWatchUrl(
      "https://in.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917/20260727",
    ),
  ).toEqual({
    city: "mumbai",
    slug: "the-odyssey",
    eventCode: "ET00480917",
    date: "20260727",
  });
});

test("parseWatchUrl works without a trailing date", () => {
  const r = parseWatchUrl(
    "https://in.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917",
  );
  expect(r.eventCode).toBe("ET00480917");
  expect(r.date).toBeUndefined();
});

test("parseWatchUrl rejects a link with no event code instead of guessing", () => {
  expect(() => parseWatchUrl("https://in.bookmyshow.com/explore/movies-mumbai")).toThrow(BmsError);
});

const BASE = "in.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917/20260727";

test.each([
  ["https scheme", `https://${BASE}`],
  ["http scheme", `http://${BASE}`],
  ["no scheme", BASE],
  [
    "www subdomain",
    "https://www.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917/20260727",
  ],
  [
    "mobile subdomain",
    "https://m.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917/20260727",
  ],
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

test("parseWatchUrl refuses to guess the city", () => {
  expect(() =>
    parseWatchUrl("https://in.bookmyshow.com/buytickets/some-cinema/ET00480917/20260727"),
  ).toThrow(/city/i);
});

test("parseWatchUrl keeps the city the user actually gave", () => {
  expect(parseWatchUrl(`https://${BASE}`.replace("/mumbai/", "/pune/")).city).toBe("pune");
});

test("parseWatchUrl rejects a non-BookMyShow host", () => {
  expect(() =>
    parseWatchUrl("https://evil.example.com/movies/mumbai/x/buytickets/ET00480917/20260727"),
  ).toThrow(/bookmyshow/i);
});

test("a wrong slug is accepted, because BookMyShow ignores it", () => {
  const r = parseWatchUrl(`https://${BASE}`.replace("the-odyssey", "nonsense-slug"));
  expect(r.eventCode).toBe("ET00480917");
  expect(r.city).toBe("mumbai");
});

test("parseWatchUrl handles pre-sale synopsis URLs (/{city}/movies/{slug}/{ET}) without confusing slug for city", () => {
  expect(parseWatchUrl("https://in.bookmyshow.com/mumbai/movies/the-odyssey/ET00480917")).toEqual({
    city: "mumbai",
    slug: "the-odyssey",
    eventCode: "ET00480917",
    date: undefined,
  });
  expect(
    parseWatchUrl(
      "https://in.bookmyshow.com/national-capital-region-ncr/movies/pushpa-2-the-rule/ET00356724",
    ),
  ).toEqual({
    city: "national-capital-region-ncr",
    slug: "pushpa-2-the-rule",
    eventCode: "ET00356724",
    date: undefined,
  });
  expect(() => parseWatchUrl("https://in.bookmyshow.com/movies/the-odyssey/ET00480917")).toThrow(
    /city/i,
  );
});

test("parseWatchUrl strips mobile share-sheet text and explains opaque shortlinks", () => {
  expect(
    parseWatchUrl(
      "Watch The Odyssey on BookMyShow! https://in.bookmyshow.com/mumbai/movies/the-odyssey/ET00480917.",
    ),
  ).toMatchObject({ city: "mumbai", slug: "the-odyssey", eventCode: "ET00480917" });

  for (const shortUrl of ["https://bmsurl.co/abc123", "https://bookmyshow.onelink.me/abc/def"]) {
    expect(() => parseWatchUrl(shortUrl)).toThrow(/Short share links/i);
  }
});

test("parseShows extracts every show with its real date and IST epoch", () => {
  const shows = parseShows(REAL);
  expect(shows).toHaveLength(3);
  // 2026-07-28 06:40 IST === 2026-07-28T01:10:00Z === 1785201000
  expect(shows[0]).toEqual({
    sessionId: "14022",
    availStatus: "3",
    showDateCode: "20260728",
    showTime: "06:40 AM",
    attributes: "IMAX",
    epoch: 1785201000,
    venueCode: "PVRJ",
    venueName: "PVR: Juhu",
  });
});

test("parseShows lifts venueCode/venueName from venue-card parent", () => {
  const shows = parseShows(VENUE_HTML);
  expect(shows).toHaveLength(2);
  expect(shows[0]).toMatchObject({
    sessionId: "19229",
    venueCode: "MCIW",
    venueName: "Miraj Cinemas: IMAX, Wadala",
    showDateCode: "20260730",
    attributes: "IMAX",
  });
  expect(shows[1]).toMatchObject({ sessionId: "19230", venueCode: "IMOB" });
});

test("parseVenues returns unique codes with names", () => {
  expect(parseVenues(VENUE_HTML)).toEqual([
    { code: "MCIW", name: "Miraj Cinemas: IMAX, Wadala" },
    { code: "IMOB", name: "INOX Megaplex: Sky City Mall, Borivali" },
  ]);
});

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

test("bookable dates exclude the probe date BMS echoes back", () => {
  const html = `"dateCode":"20260728" "dateCode":"20260729" "dateCode":"${PROBE_DATE}"`;
  expect(parseBookableDates(html)).toEqual(["20260728", "20260729"]);
});

test("bookable dates are deduped and sorted", () => {
  const html = `"dateCode":"20260803" "dateCode":"20260728" "dateCode":"20260728"`;
  expect(parseBookableDates(html)).toEqual(["20260728", "20260803"]);
});

const COMING_SOON =
  `"additionalData":{"dateCode":"20261117","eventCode":"ET00439706","defaultSortId":"relevance"},` +
  `"topStickyWidgets":[{"type":"horizontal-block-list","data":[{"type":"vertical-text-list","id":"20261117","styleId":"date-disabled"}]}]`;

test("a page-default date with no shows is not bookable (coming-soon page)", () => {
  expect(parseBookableDates(COMING_SOON)).toEqual([]);
});

test("a page-default date that has shows stays bookable", () => {
  const html =
    `"additionalData":{"dateCode":"20261117","eventCode":"ET00516631","defaultSortId":"relevance"} ` +
    `"cta":{"type":"dateSelector","additionalData":{"dateCode":"20261117","uuid":"a"}} ` +
    `"cta":{"type":"dateSelector","additionalData":{"dateCode":"20261118","uuid":"b"}} ` +
    `"cta":{"type":"dateSelector","additionalData":{"dateCode":"20261119","uuid":"c"}} "showDateCode":"20261117"`;
  expect(parseBookableDates(html)).toEqual(["20261117", "20261118", "20261119"]);
});

test("a date with no shows reads as unavailable even though the page is full of shows", () => {
  const shows = parseShows(REAL);
  expect(shows.length).toBeGreaterThan(0);
  expect(showsOnDate(shows, "20260730")).toHaveLength(0);
  expect(showsOnDate(shows, "20260728")).toHaveLength(2);
});

test("the TLS profile defaults to the pinned Safari one when unset or blank", () => {
  expect(DEFAULT_TLS_PROFILE).toBe("safari_ios_17_0");
  expect(resolveTlsProfile({})).toBe("safari_ios_17_0");
  expect(resolveTlsProfile({ BMS_TLS_PROFILE: "" })).toBe("safari_ios_17_0");
  expect(resolveTlsProfile({ BMS_TLS_PROFILE: "   " })).toBe("safari_ios_17_0");
  expect(resolveTlsProfile({ BMS_TLS_PROFILE: "  safari_ios_17_0  " })).toBe("safari_ios_17_0");
  expect(resolveTlsProfile({ BMS_TLS_PROFILE: "firefox_120" })).toBe("firefox_120");
});

test("every profile named in the docs resolves to a real client identifier", () => {
  for (const profile of ["safari_ios_17_0", "safari_ios_18_0", "safari_16_0", "firefox_120"]) {
    expect(resolveClientIdentifier(profile)).toBeTruthy();
  }
});

test("unknown or empty TLS profile names fail loudly instead of falling back", () => {
  expect(() => resolveClientIdentifier("")).toThrow(BmsError);
  try {
    resolveClientIdentifier("safari_ios_18_o");
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(BmsError);
    expect((e as BmsError).kind).toBe("unparseable");
    expect((e as BmsError).message).toContain("BMS_TLS_PROFILE");
  }
});

test("every Chrome-family profile is rejected, including padded input", () => {
  const chromeKeys = Object.keys(tls.ClientIdentifier).filter((k) => k.startsWith("chrome"));
  expect(chromeKeys.length).toBeGreaterThan(0);
  for (const key of chromeKeys) {
    expect(() => resolveClientIdentifier(key)).toThrow(BmsError);
  }
  expect(() => resolveClientIdentifier("  chrome_120  ")).toThrow(/BMS_TLS_PROFILE/);
});

const CHIP_HTML = `
{"type":"chip","title":"2D","cta":{"type":"formatSelector","analytics":{"event_code":"ET00502600","format":"2D","screen_name":"movie_showtimes","uuid":"aaa"},"additionalData":{"eventCode":"ET00502600","eventUrl":"spider-man-brand-new-day","language":"English","refEventCode":"ET00502600","uuid":"bbb"}}},
{"type":"chip","title":"3D SCREEN X","cta":{"type":"formatSelector","analytics":{"event_code":"ET00502684","format":"3D SCREEN X","screen_name":"movie_showtimes","uuid":"ccc"},"additionalData":{"eventCode":"ET00502684","eventUrl":"spider-man-brand-new-day-3d-screen-x","language":"English","refEventCode":"ET00502684","uuid":"ddd"}}},
{"type":"chip","title":"IMAX 3D","cta":{"type":"formatSelector","analytics":{"event_code":"ET00502699","format":"IMAX 3D","screen_name":"movie_showtimes","uuid":"eee"},"additionalData":{"eventCode":"ET00502699","eventUrl":"spider-man-brand-new-day-imax-3d","language":"English","refEventCode":"ET00502699","uuid":"fff"}}}
`;

test("parseFormatChips extracts child event codes from format-selector chips", () => {
  expect(parseFormatChips(CHIP_HTML)).toEqual([
    { title: "2D", eventCode: "ET00502600", slug: "spider-man-brand-new-day" },
    { title: "3D SCREEN X", eventCode: "ET00502684", slug: "spider-man-brand-new-day-3d-screen-x" },
    { title: "IMAX 3D", eventCode: "ET00502699", slug: "spider-man-brand-new-day-imax-3d" },
  ]);
  expect(parseFormatChips("<html><body>no chips here</body></html>")).toEqual([]);
});

test("parseShows skips sold-out availStatus 0 and extracts optional BMS tier categories", () => {
  const html = `
  "showtimesSections":[{"data":[{"type":"venue-card","additionalData":{"venueCode":"PVRJ","venueName":"PVR: Juhu"},
  "showtimes":[
    {"additionalData":{"sessionId":"1001","availStatus":"0","showDateCode":"20260728","showDateTime":"202607280640","showTimeCode":"0640","showTime":"06:40 AM","attributes":"IMAX"}},
    {"additionalData":{"sessionId":"1002","availStatus":"2","showDateCode":"20260728","showDateTime":"202607280955","showTimeCode":"0955","showTime":"09:55 AM","attributes":"IMAX","categories":[{"priceDesc":"CLASSIC","curPrice":"450.00","availStatus":"2"},{"priceDesc":"RECLINER","curPrice":"950.00","availStatus":"0"}]}}
  ]}]}]`;
  const shows = parseShows(html);
  expect(shows).toHaveLength(1);
  expect(shows[0]!.sessionId).toBe("1002");
  expect(shows[0]!.ticketCategories).toEqual([
    { name: "CLASSIC", price: 450, available: 1 },
    { name: "RECLINER", price: 950, available: 0 },
  ]);
});

test("parseMoviePoster extracts verified iedb movie posters and ignores generic BMS logos", () => {
  expect(
    parseMoviePoster(
      '<meta property="og:image" content="https://assets-in.bmscdn.com/iedb/movies/images/mobile/thumbnail/xlarge/the-odyssey-et00480917.jpg">',
    ),
  ).toBe(
    "https://assets-in.bmscdn.com/iedb/movies/images/mobile/thumbnail/xlarge/the-odyssey-et00480917.jpg",
  );
  expect(
    parseMoviePoster(
      '<meta property="og:image" content="https://in.bmscdn.com/webin/common/favicon.png">',
    ),
  ).toBeUndefined();
});
