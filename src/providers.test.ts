import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as bms from "./bms.ts";
import {
  beginCycle,
  bookableDatesCached,
  discoverListing,
  fetchShowtimes,
  fetchShowtimesCached,
  parseWatchUrl,
  showsForListing,
  showtimesUrl,
} from "./providers.ts";
import { ReadCycle } from "./read-cycle.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  beginCycle();
});

const target = {
  provider: "district" as const,
  city: "mumbai",
  slug: "ramayana",
  eventCode: "MV176276",
  date: "20261115",
};

const html = readFileSync(new URL("./fixtures/district/movie.html", import.meta.url), "utf8");

test("routes both URL types, rejects invalid District hosts, and builds booking links", () => {
  expect(
    parseWatchUrl("https://in.bookmyshow.com/movies/mumbai/test/buytickets/ET00480917/20261115")
      .provider,
  ).toBe("bms");
  expect(
    parseWatchUrl("Check out https://in.bookmyshow.com/mumbai/movies/test/ET00480917!").city,
  ).toBe("mumbai");
  expect(
    parseWatchUrl("https://www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276")
      .provider,
  ).toBe("district");
  expect(
    parseWatchUrl(
      "Watch on District: https://m.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276.",
    ).provider,
  ).toBe("district");
  expect(() => parseWatchUrl("https://bad.district.in/movies/x")).toThrow(/district\.in/i);
  expect(() => parseWatchUrl("https://link.district.in/xyz")).toThrow(/Short share links/i);
  expect(showtimesUrl(target)).toStartWith("https://www.district.in/");
  expect(showtimesUrl({ ...target, provider: "bms", eventCode: "ET00480917" })).toContain(
    "bookmyshow.com",
  );
});

test("coalesces District reads within a cycle, never across cycles", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(html);
  }) as unknown as typeof fetch;

  beginCycle();
  const [a, b] = await Promise.all([
    bookableDatesCached(target),
    bookableDatesCached({ ...target, date: "20261119" } as typeof target),
  ]);
  expect(a).toEqual(b);
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain("fromdate");

  const [showsA, showsB] = await Promise.all([
    fetchShowtimesCached(target),
    fetchShowtimesCached(target),
  ]);
  expect(showsA.chips).toEqual([]);
  expect(showsB.chips).toEqual([]);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("fromdate=2026-11-15");

  expect((await fetchShowtimes(target)).chips).toEqual([]);

  beginCycle();
  await bookableDatesCached(target);
  expect(requests).toHaveLength(4);
});

test("checks all language groups and deduplicates identical screenings", async () => {
  const multi = html.replace(
    '"languageFormatGroups": [',
    '"languageFormatGroups": [{"format":"SecondGroup"},',
  );
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    const body = String(input).includes("frmtid=secondgroup")
      ? multi.replace('"frmtid": "rtb7dmwvuo"', '"frmtid": "secondgroup"')
      : multi;
    return new Response(body);
  }) as unknown as typeof fetch;

  beginCycle();
  const result = await fetchShowtimesCached(target);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("frmtid=secondgroup");
  expect(result.shows).toHaveLength(4);
});

test("HTTP errors remain errors rather than empty availability and surface Retry-After", async () => {
  globalThis.fetch = (async () =>
    new Response("blocked", { status: 403 })) as unknown as typeof fetch;
  beginCycle();
  await expect(bookableDatesCached(target)).rejects.toThrow("District HTTP 403");

  globalThis.fetch = (async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "120" },
    })) as unknown as typeof fetch;
  beginCycle();
  await expect(bookableDatesCached(target)).rejects.toThrow("District HTTP 429 (Retry-After: 120)");
});

test("ReadCycle evicts rejected promises so transient blips do not poison later watches", async () => {
  const cycle = new ReadCycle();
  let calls = 0;

  const flaky = async () => {
    calls++;
    await Bun.sleep(5);
    if (calls === 1) throw new Error("transient network blip");
    return "recovered";
  };

  const [first, concurrent] = await Promise.allSettled([
    cycle.once("movie", flaky),
    cycle.once("movie", flaky),
  ]);
  expect(first.status).toBe("rejected");
  expect(concurrent.status).toBe("rejected");
  expect(calls).toBe(1);
  expect(cycle.hits).toBe(1);

  await expect(cycle.once("movie", flaky)).resolves.toBe("recovered");
  expect(calls).toBe(2);
});

test("discoverListing and showsForListing union BMS sibling format chips and enrich chip-only formats", async () => {
  const chips = [
    { title: "2D", eventCode: "ET00439706", slug: "the-odyssey" },
    { title: "MS - Inf Vsn 4DX 3D", eventCode: "ET00526320", slug: "the-odyssey-4dx-3d" },
    { title: "MS-Infinity Vsn 3d", eventCode: "ET00526306", slug: "the-odyssey-3d" },
    { title: "ICE 3D", eventCode: "ET00526287", slug: "the-odyssey-ice-3d" },
  ];

  const datesSpy = spyOn(bms, "fetchBookableDates").mockImplementation(async (t) => {
    if (t.eventCode === "ET00439706" || t.eventCode === "ET00526287") {
      return { title: "The Odyssey", dates: [], venues: [], chips };
    }
    return {
      title: "The Odyssey",
      dates: ["20261217", "20261218"],
      venues: [{ code: "PVRI", name: "PVR Icon" }],
      chips: [],
    };
  });

  const showsSpy = spyOn(bms, "fetchShowtimes").mockImplementation(async (t) => {
    if (t.eventCode === "ET00526320") {
      return {
        title: "The Odyssey",
        chips: [],
        shows: [
          {
            sessionId: "s4dx",
            availStatus: "3",
            showDateCode: "20261217",
            showTime: "07:00 PM",
            attributes: "4DX",
            epoch: 1797514200,
            venueCode: "PVRI",
            venueName: "PVR Icon",
          },
        ],
      };
    }
    if (t.eventCode === "ET00526306") {
      return {
        title: "The Odyssey",
        chips: [],
        shows: [
          {
            sessionId: "s3d",
            availStatus: "3",
            showDateCode: "20261217",
            showTime: "08:00 PM",
            attributes: "2K LASER DOLBY 7.1",
            epoch: 1797517800,
            venueCode: "PVRI",
            venueName: "PVR Icon",
          },
        ],
      };
    }
    return { title: "The Odyssey", shows: [], chips };
  });

  try {
    const unfilteredDates = await discoverListing(
      { provider: "bms", city: "mumbai", slug: "the-odyssey", eventCode: "ET00439706" },
      null,
    );
    expect(unfilteredDates.dates).toEqual(["20261217", "20261218"]);
    expect(unfilteredDates.venues).toEqual([{ code: "PVRI", name: "PVR Icon" }]);

    const unfilteredShows = await showsForListing(
      {
        provider: "bms",
        city: "mumbai",
        slug: "the-odyssey",
        eventCode: "ET00439706",
        date: "20261217",
      },
      null,
    );
    expect(unfilteredShows.shows.map((s) => s.attributes)).toEqual([
      "MS - Inf Vsn 4DX 3D · 4DX",
      "MS-Infinity Vsn 3d · 2K LASER DOLBY 7.1",
    ]);

    const only3d = await showsForListing(
      {
        provider: "bms",
        city: "mumbai",
        slug: "the-odyssey",
        eventCode: "ET00439706",
        date: "20261217",
      },
      "3D",
    );
    expect(only3d.shows).toHaveLength(2);
    expect(only3d.shows[1]?.attributes).toBe("MS-Infinity Vsn 3d · 2K LASER DOLBY 7.1");
  } finally {
    datesSpy.mockRestore();
    showsSpy.mockRestore();
  }
});
