import { expect, test } from "bun:test";
import { normaliseTheatres, matchesTheatre, filterSummary } from "./filters.ts";

test("normaliseTheatres uppercases, trims and collapses inner whitespace", () => {
  expect(normaliseTheatres("pvr")).toBe("PVR");
  expect(normaliseTheatres(" INOX ")).toBe("INOX");
  expect(normaliseTheatres("pvr , INOX,imax  wadala")).toBe("PVR,INOX,IMAX WADALA");
});

test("normaliseTheatres returns null for empty input", () => {
  expect(normaliseTheatres("")).toBeNull();
  expect(normaliseTheatres("   ")).toBeNull();
  expect(normaliseTheatres(null)).toBeNull();
  expect(normaliseTheatres(",  ,")).toBeNull();
});

test("matchesTheatre is a case-insensitive substring of the venue name", () => {
  expect(matchesTheatre("PVR: Phoenix Palladium, Lower Parel", "PVLP", "PVR")).toBe(true);
  expect(matchesTheatre("INOX: R-City, Ghatkopar", "INRC", "PVR")).toBe(false);
});

test("matchesTheatre also matches the venue code, for users who paste one", () => {
  expect(matchesTheatre("IMAX Wadala", "IMOB", "IMOB")).toBe(true);
  expect(matchesTheatre("IMAX Wadala", "IMOB", "XYZ")).toBe(false);
});

test("matchesTheatre honours any one entry in a comma list", () => {
  const name = "INOX: R-City, Ghatkopar";
  expect(matchesTheatre(name, "INRC", "PVR,INOX")).toBe(true);
  expect(matchesTheatre(name, "INRC", "PVR,CINEPOLIS")).toBe(false);
});

test("matchesTheatre collapses whitespace on both sides", () => {
  expect(matchesTheatre("IMAX  Wadala", "IMOB", "IMAX WADALA")).toBe(true);
  expect(matchesTheatre("IMAX Wadala", "IMOB", "IMAX  WADALA")).toBe(true);
});

test("matchesTheatre tolerates missing venue name or code", () => {
  expect(matchesTheatre("", "IMOB", "IMOB")).toBe(true);
  expect(matchesTheatre("IMAX Wadala", "", "IMAX")).toBe(true);
  expect(matchesTheatre("", "", "PVR")).toBe(false);
});

test("matchesTheatre never matches on an empty filter entry", () => {
  // A stray comma must not turn into a wildcard that matches every cinema.
  expect(matchesTheatre("INOX: R-City", "INRC", "PVR,")).toBe(false);
});

test("filterSummary lists theatres between formats and days", () => {
  expect(filterSummary({ format_filter: "IMAX", day_filter: "fri,sat", theatre_filter: "PVR,INOX" }))
    .toBe("IMAX · PVR · INOX · Fri, Sat");
});

test("filterSummary handles a theatre filter on its own", () => {
  expect(filterSummary({ format_filter: null, day_filter: null, theatre_filter: "PVR" })).toBe("PVR");
});

test("filterSummary is unchanged when no theatre filter is set", () => {
  expect(filterSummary({ format_filter: "IMAX", day_filter: null })).toBe("IMAX");
  expect(filterSummary({ format_filter: null, day_filter: null })).toBeNull();
});
