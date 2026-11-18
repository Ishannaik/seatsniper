import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { districtUrl, parseDistrictPage, parseDistrictUrl } from "./district.ts";
import { matchesTimeFilter } from "./time-filter.ts";

const baseTarget = {
  provider: "district" as const,
  city: "mumbai",
  slug: "ramayana",
  eventCode: "MV176276",
};

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/district/${name}.html`, import.meta.url), "utf8");
}

describe("District public movie pages", () => {
  test("strict URL identity, explicit city, and date", () => {
    expect(
      parseDistrictUrl(
        "<https://www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276?fromdate=2026-11-19>",
      ),
    ).toEqual({ ...baseTarget, date: "20261119" });

    expect(districtUrl({ ...baseTarget, date: "20261119" })).toContain("fromdate=2026-11-19");

    const invalidUrls = [
      "https://district.in.evil.com/movies/x",
      "https://www.district.in/events/test",
      "https://www.district.in/movies/ramayana-movie-tickets-MV176276",
      "https://user@www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276",
    ];
    for (const url of invalidUrls) {
      expect(() => parseDistrictUrl(url)).toThrow();
    }

    expect(
      parseDistrictUrl(
        "Book tickets now! https://m.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276?fromdate=2026-11-19.",
      ),
    ).toEqual({ ...baseTarget, date: "20261119" });
    expect(() => parseDistrictUrl("https://link.district.in/share123")).toThrow(
      /Short share links/i,
    );
  });

  test("captured sessions use UTC, including IST midnight rollover", () => {
    const page = parseDistrictPage(fixture("movie"), baseTarget);
    expect(page.title).toBe("Ramayana");

    const show = page.shows[0]!;
    expect(show.showDateCode).toBe("20261115");
    expect(show.showTime).toBe("13:50"); // JSON-LD: 2026-11-15T13:50:00+05:30
    expect(show.epoch).toBe(Date.parse("2026-11-15T08:20:00Z") / 1000);
    expect(matchesTimeFilter(show.epoch, 13 * 60, 14 * 60)).toBe(true);
    expect(show.bookingUrl).toBe(
      "https://www.district.in/movies/seat-layout/rtb7dmwvuo?encsessionid=1023314-22265-obe015-1023314&freeseating=false&fromsessions=true&type=MOVIES&contentid=176276",
    );

    const future = parseDistrictPage(fixture("future"), { ...baseTarget, date: "20261119" });
    expect(future.shows[0]!.showDateCode).toBe("20261119");
    expect(future.shows[0]!.showTime).toBe("00:05");

    expect(parseDistrictPage(fixture("movie"), { ...baseTarget, date: "20261119" }).shows).toEqual(
      [],
    );
  });

  test("explicit closed date and unreleased movie are valid empty states", () => {
    expect(parseDistrictPage(fixture("closed"), { ...baseTarget, date: "20270201" }).shows).toEqual(
      [],
    );
    expect(
      parseDistrictPage(fixture("upcoming"), {
        ...baseTarget,
        eventCode: "MV187766",
        slug: "jailer-2",
      }),
    ).toMatchObject({
      title: "Jailer 2",
      shows: [],
      dates: [],
      upcoming: true,
    });
  });

  test("blocked, malformed, mismatched and incomplete responses throw", () => {
    const brokenPages = [
      "<html>Access denied</html>",
      '<script id="__NEXT_DATA__">{bad}</script>',
      fixture("movie").replace('"movieSessions": {', '"movieSessionsChanged": {'),
      fixture("movie").replace('"cityName": "mumbai"', '"cityName": "delhi"'),
    ];
    for (const html of brokenPages) {
      expect(() => parseDistrictPage(html, baseTarget)).toThrow();
    }

    expect(() =>
      parseDistrictPage(fixture("movie"), { ...baseTarget, eventCode: "MV999999" }),
    ).toThrow();
    expect(() => parseDistrictPage(fixture("closed"), baseTarget)).toThrow();
  });

  test("disabled and sold-out sessions never count as bookable", () => {
    const disabledHtml = fixture("movie").replaceAll(
      '"disableClick": false',
      '"disableClick": true',
    );
    expect(parseDistrictPage(disabledHtml, baseTarget).shows).toEqual([]);

    const soldOutHtml = fixture("movie").replace(/"avail": \d+/g, '"avail": 0');
    expect(parseDistrictPage(soldOutHtml, baseTarget).shows).toEqual([]);
  });

  test("merges extraSessions, preserves optional sTotal capacity, and extracts verified posterUrl", () => {
    const raw = fixture("movie")
      .replace('"sAvail": 39,', '"sAvail": 39, "sTotal": 120,')
      .replace(
        '"name": "Ramayana"',
        '"name": "Ramayana", "poster_url": "https://cdn.district.in/movies/ramayana-poster.jpg"',
      )
      .replace(
        '"sessions": [',
        '"extraSessions": [{"sid":"extra99","pid":"1","mid":"1","showTime":"2026-11-15T16:30:00","scrnFmt":"IMAX 3D","disableClick":false,"avail":12,"sType":0,"areas":[{"label":"IMAX","sAvail":12,"sTotal":60,"price":650}]}], "sessions": [',
      );
    const page = parseDistrictPage(raw, baseTarget);
    expect(page.posterUrl).toBe("https://cdn.district.in/movies/ramayana-poster.jpg");
    expect(page.shows[0]!.ticketCategories![0]).toEqual({
      name: "CLASSIC ROWS",
      available: 39,
      price: 320,
      totalSeats: 120,
    });
    const extra = page.shows.find((s) => s.sessionId.includes(":extra99:"));
    expect(extra).toBeDefined();
    expect(extra!.attributes).toBe("IMAX 3D");
    expect(extra!.ticketCategories).toEqual([
      { name: "IMAX", available: 12, price: 650, totalSeats: 60 },
    ]);
  });
});
