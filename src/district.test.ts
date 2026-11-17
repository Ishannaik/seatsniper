import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseDistrictPage, parseDistrictUrl, districtUrl } from "./district.ts";
import { matchesTimeFilter } from "./time-filter.ts";
const t = { provider: "district" as const, city: "mumbai", slug: "ramayana", eventCode: "MV176276" };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/district/${name}.html`, import.meta.url), "utf8");

describe("District public movie pages", () => {
  test("strict URL identity, explicit city, and date", () => {
    expect(parseDistrictUrl("<https://www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276?fromdate=2026-11-19>")).toEqual({ ...t, date: "20261119" });
    expect(districtUrl({ ...t, date: "20261119" })).toContain("fromdate=2026-11-19");
    for (const url of ["https://district.in.evil.com/movies/x", "https://www.district.in/events/test", "https://www.district.in/movies/ramayana-movie-tickets-MV176276", "https://user@www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276"]) expect(() => parseDistrictUrl(url)).toThrow();
  });
  test("captured sessions use UTC, including IST midnight rollover", () => {
    const page = parseDistrictPage(fixture("movie"), t);
    expect(page.title).toBe("Ramayana");
    const show = page.shows[0]!;
    expect(show.showDateCode).toBe("20261115");
    expect(show.showTime).toBe("13:50"); // JSON-LD: 2026-11-15T13:50:00+05:30
    expect(show.epoch).toBe(Date.parse("2026-11-15T08:20:00Z") / 1000);
    expect(matchesTimeFilter(show.epoch, 13 * 60, 14 * 60)).toBe(true);
    const future = parseDistrictPage(fixture("future"), { ...t, date: "20261119" });
    expect(future.shows[0]!.showDateCode).toBe("20261119");
    expect(future.shows[0]!.showTime).toBe("00:05");
    expect(parseDistrictPage(fixture("movie"), { ...t, date: "20261119" }).shows).toEqual([]);
  });
  test("explicit closed date and unreleased movie are valid empty states", () => {
    expect(parseDistrictPage(fixture("closed"), { ...t, date: "20270201" }).shows).toEqual([]);
    expect(parseDistrictPage(fixture("upcoming"), { ...t, eventCode: "MV187766", slug: "jailer-2" })).toMatchObject({ title: "Jailer 2", shows: [], dates: [], upcoming: true });
  });
  test("blocked, malformed, mismatched and incomplete responses throw", () => {
    for (const html of ["<html>Access denied</html>", '<script id="__NEXT_DATA__">{bad}</script>', fixture("movie").replace('"movieSessions": {', '"movieSessionsChanged": {'), fixture("movie").replace('"cityName": "mumbai"', '"cityName": "delhi"')]) expect(() => parseDistrictPage(html, t)).toThrow();
    expect(() => parseDistrictPage(fixture("movie"), { ...t, eventCode: "MV999999" })).toThrow();
    expect(() => parseDistrictPage(fixture("closed"), t)).toThrow();
  });
  test("disabled and sold-out sessions never count as bookable", () => {
    const html = fixture("movie").replaceAll('"disableClick": false', '"disableClick": true');
    expect(parseDistrictPage(html, t).shows).toEqual([]);
    const sold = fixture("movie").replace(/"avail": \d+/g, '"avail": 0');
    expect(parseDistrictPage(sold, t).shows).toEqual([]);
  });
});
