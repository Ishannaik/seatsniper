import { expect, test } from "bun:test";
import { parseWatchUrl, parseShows, showsOnDate, BmsError } from "./bms.ts";

// Trimmed from a real 2026-07-27 response for The Odyssey (ET00480917, Mumbai).
// Two shows on the 28th, one on the 27th — the exact shape BMS returns when it
// substitutes the nearest bookable date for one that isn't open.
const REAL = `
"showtimesSections":[{"showtimes":[{"title":"06:40 AM","screenAttr":"IMAX",
"additionalData":{"sessionId":"14022","availStatus":"3","cutOffDateTime":"202607280655","cutOffDateTimeEpoch":"1785201900","showDateCode":"20260728","showDateTime":"202607280640","showTimeCode":"0640","showTime":"06:40 AM","attributes":"IMAX"},
"additionalData":{"sessionId":"14023","availStatus":"1","cutOffDateTime":"202607281010","cutOffDateTimeEpoch":"1785201901","showDateCode":"20260728","showDateTime":"202607280955","showTimeCode":"0955","showTime":"09:55 AM","attributes":"IMAX"},
"additionalData":{"sessionId":"13919","availStatus":"3","cutOffDateTime":"202607271400","cutOffDateTimeEpoch":"1785141000","showDateCode":"20260727","showDateTime":"202607271345","showTimeCode":"1345","showTime":"01:45 PM","attributes":"IMAX"}]}]`;

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

test("parseShows extracts every show with its real date", () => {
  const shows = parseShows(REAL);
  expect(shows).toHaveLength(3);
  expect(shows[0]).toEqual({
    sessionId: "14022", availStatus: "3", showDateCode: "20260728",
    showTime: "06:40 AM", attributes: "IMAX",
  });
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
