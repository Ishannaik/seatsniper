import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { matchesBookingPreferences, validateBookingPreferences } from "./booking-preferences.ts";
import { parseDistrictPage } from "./district.ts";
import { ticketsLive } from "./messages.ts";
import type { Show } from "./bms.ts";
const show: Show = { sessionId: "s", availStatus: "AVAILABLE", showDateCode: "20261115", showTime: "13:50", attributes: "3D", epoch: 1794720800, venueCode: "v", venueName: "PVR", ticketCategories: [{ name: "Classic", available: 1, price: 300 }, { name: "Recliner", available: 4, price: 900 }] };
test("seat count and budget must match the same category", () => {
  expect(matchesBookingPreferences(show, { seat_count: 2, seat_budget: 500 })).toBe(false);
  expect(matchesBookingPreferences(show, { seat_count: 2, seat_budget: 900 })).toBe(true);
  expect(matchesBookingPreferences(show, { seat_count: 5 })).toBe(false);
  expect(matchesBookingPreferences(show, { seat_budget: 300 })).toBe(true);
  expect(matchesBookingPreferences({ ...show, ticketCategories: undefined }, { seat_count: 2 })).toBe(false);
  expect(matchesBookingPreferences(show, {})).toBe(true);
});
test("invalid seat counts and budgets are rejected", () => {
  for (const p of [{ seat_count: 0 }, { seat_count: 11 }, { seat_count: 1.5 }, { seat_budget: 0 }, { seat_budget: NaN }]) expect(() => validateBookingPreferences(p)).toThrow();
});
test("captured District categories and direct links reach the correct session", () => {
  const html = readFileSync(new URL("./fixtures/district/movie.html", import.meta.url), "utf8");
  const page = parseDistrictPage(html, { city: "mumbai", slug: "ramayana", eventCode: "MV176276" });
  const first = page.shows[0]!;
  expect(first.ticketCategories![0]).toEqual({ name: "CLASSIC ROWS", available: 39, price: 320 });
  expect(matchesBookingPreferences(first, { seat_count: 2, seat_budget: 400 })).toBe(true);
  const url = new URL(first.bookingUrl!);
  expect(url.hostname).toBe("www.district.in"); expect(url.pathname).toBe("/movies/seat-layout/rtb7dmwvuo");
  expect(url.searchParams.get("encsessionid")).toBe("1023314-22265-obe015-1023314");
  expect(url.searchParams.get("contentid")).toBe("176276");
  const msg = ticketsLive({ title: page.title, city: "mumbai", date: first.showDateCode, shows: [first], url: "https://www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276" });
  expect(msg.components).toHaveLength(2);
  const button = msg.components[1]!.toJSON().components[0]!;
  expect("url" in button ? button.url : undefined).toEqual(first.bookingUrl);
  expect(msg.embeds[0]!.toJSON().fields!.some((f) => f.value.includes("adjacent seats are not verified"))).toBe(true);
  expect(() => parseDistrictPage(html.replaceAll('"areas":', '"changedAreas":'), { city: "mumbai", slug: "ramayana", eventCode: "MV176276" })).toThrow();
});
