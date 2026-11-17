import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { beginCycle, bookableDatesCached, fetchShowtimesCached, parseWatchUrl, showtimesUrl } from "./providers.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; beginCycle(); });
const target = { provider: "district" as const, city: "mumbai", slug: "ramayana", eventCode: "MV176276", date: "20261115" };
const html = readFileSync(new URL("./fixtures/district/movie.html", import.meta.url), "utf8");

test("routes both URL types and creates provider-specific booking links", () => {
  expect(parseWatchUrl("https://in.bookmyshow.com/movies/mumbai/test/buytickets/ET00480917/20261115").provider).toBe("bms");
  expect(parseWatchUrl("https://www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276").provider).toBe("district");
  expect(showtimesUrl(target)).toStartWith("https://www.district.in/");
  expect(showtimesUrl({ ...target, provider: "bms", eventCode: "ET00480917" })).toContain("bookmyshow.com");
});

test("coalesces District reads within a cycle, never across cycles", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => { requests.push(String(input)); return new Response(html); }) as unknown as typeof fetch;
  beginCycle();
  const [a, b] = await Promise.all([bookableDatesCached(target), bookableDatesCached({ ...target, date: "20261119" } as typeof target)]);
  expect(a).toEqual(b); expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain("fromdate");
  await Promise.all([fetchShowtimesCached(target), fetchShowtimesCached(target)]);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("fromdate=2026-11-15");
  beginCycle(); await bookableDatesCached(target); expect(requests).toHaveLength(3);
});

test("checks all language groups and deduplicates identical screenings", async () => {
  const multi = html.replace('"languageFormatGroups": [', '"languageFormatGroups": [{"format":"SecondGroup"},');
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => { requests.push(String(input)); return new Response(String(input).includes("frmtid=secondgroup") ? multi.replace('"frmtid": "rtb7dmwvuo"', '"frmtid": "secondgroup"') : multi); }) as unknown as typeof fetch;
  beginCycle();
  const result = await fetchShowtimesCached(target);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("frmtid=secondgroup");
  expect(result.shows).toHaveLength(4);
});

test("HTTP errors remain errors rather than empty availability", async () => {
  globalThis.fetch = (async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch;
  beginCycle(); await expect(bookableDatesCached(target)).rejects.toThrow("District HTTP 403");
});
