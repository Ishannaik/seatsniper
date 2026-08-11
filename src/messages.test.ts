import { expect, test } from "bun:test";
import type { Show } from "./bms.ts";
import { LIVE, alreadyOnSale, newCinemas, subscriptionAlert, ticketsLive, watchList } from "./messages.ts";

const URL = "https://in.bookmyshow.com/movies/mumbai/foo/buytickets/ET00000001";

function show(venueCode: string, venueName: string, epoch = 0, attributes = ""): Show {
  return {
    sessionId: "s",
    availStatus: "",
    showDateCode: "20260728",
    showTime: "06:40 AM",
    attributes,
    epoch,
    venueCode,
    venueName,
  };
}

test("alreadyOnSale includes theatre names when venues are present", () => {
  const { embeds } = alreadyOnSale({
    title: "The Odyssey",
    city: "mumbai",
    date: "20260728",
    shows: [show("PVRJ", "PVR: Juhu"), show("MCIW", "Miraj Cinemas: IMAX, Wadala")],
    url: URL,
  });
  const embed = embeds[0]!.data;
  const theatres = embed.fields?.find((field) => field.name === "Theatres");
  expect(theatres?.value).toContain("PVR: Juhu");
  expect(theatres?.value).toContain("Miraj Cinemas: IMAX, Wadala");
});

test("alreadyOnSale keeps named venues when venue codes are empty", () => {
  const { embeds } = alreadyOnSale({
    title: "The Odyssey",
    city: "mumbai",
    date: "20260728",
    shows: [show("", "PVR: Juhu"), show("", "Miraj Cinemas: IMAX, Wadala")],
    url: URL,
  });
  const embed = embeds[0]!.data;
  const theatres = embed.fields?.find((field) => field.name === "Theatres");
  expect(theatres?.value).toContain("PVR: Juhu");
  expect(theatres?.value).toContain("Miraj Cinemas: IMAX, Wadala");
});

test("ticketsLive groups showtimes under theatre headings", () => {
  const { embeds } = ticketsLive({
    title: "The Odyssey",
    city: "mumbai",
    date: "20260728",
    shows: [
      show("PVRJ", "PVR: Juhu", 1000, "IMAX"),
      show("MCIW", "Miraj Cinemas: IMAX, Wadala", 1000),
    ],
    url: URL,
  });
  const value = embeds[0]!.data.fields?.find((field) => field.name === "Showtimes")?.value ?? "";
  expect(value).toContain("**PVR: Juhu**");
  expect(value).toContain("**Miraj Cinemas: IMAX, Wadala**");
  expect(value).toContain("IMAX");
});

test("ticketsLive keeps the same wall-clock time for different theatres", () => {
  const { embeds } = ticketsLive({
    title: "The Odyssey",
    city: "mumbai",
    date: "20260728",
    shows: [
      show("PVRJ", "PVR: Juhu", 1000),
      show("MCIW", "Miraj Cinemas: IMAX, Wadala", 1000),
    ],
    url: URL,
  });
  const value = embeds[0]!.data.fields?.find((field) => field.name === "Showtimes")?.value ?? "";
  expect((value.match(/<t:1000:t>/g) ?? []).length).toBe(2);
});

test("ticketsLive falls back to venue code when venueName is empty", () => {
  const { embeds } = ticketsLive({
    title: "The Odyssey",
    city: "mumbai",
    date: "20260728",
    shows: [show("PVRJ", "", 1000)],
    url: URL,
  });
  const value = embeds[0]!.data.fields?.find((field) => field.name === "Showtimes")?.value ?? "";
  expect(value).toContain("**PVRJ**");
});

test("ticketsLive keeps grouped showtimes within Discord field limit", () => {
  const longName =
    "PVR: A very long cinema name with IMAX and Dolby Atmos in Mumbai plus additional venue details and hall numbers";
  const shows = Array.from({ length: 6 }, (_, venueIndex) =>
    Array.from({ length: 4 }, (_, timeIndex) =>
      show(
        `V${venueIndex}`,
        `${longName} ${venueIndex}`,
        1000 + venueIndex * 3600 + timeIndex * 60,
        "IMAX",
      ),
    ),
  ).flat();
  const { embeds } = ticketsLive({
    title: "The Odyssey",
    city: "mumbai",
    date: "20260728",
    shows,
    url: URL,
  });
  const value = embeds[0]!.data.fields?.find((field) => field.name === "Showtimes")?.value ?? "";
  expect(value.length).toBeLessThanOrEqual(1024);
  expect(value).toMatch(/more theatres/);
});

test("newCinemas lists venue names and uses LIVE alert colour", () => {
  const { embeds } = newCinemas({
    title: "The Odyssey",
    city: "mumbai",
    venues: [
      { code: "PVRJ", name: "PVR: Juhu" },
      { code: "MCIW", name: "Miraj Cinemas: IMAX, Wadala" },
    ],
    url: URL,
  });
  const embed = embeds[0]!.data;
  expect(embed.color).toBe(LIVE);
  expect(embed.title).toBe("The Odyssey — 2 new cinemas");
  expect(embed.description).toContain("PVR: Juhu");
  expect(embed.description).toContain("Miraj Cinemas: IMAX, Wadala");
  expect(embed.description).toContain("Mumbai");
});

test("subscriptionAlert combines dates and cinemas when both present", () => {
  const { embeds } = subscriptionAlert({
    title: "The Odyssey",
    city: "mumbai",
    dates: ["20260728", "20260730"],
    venues: [{ code: "PVRJ", name: "PVR: Juhu" }],
    url: URL,
  });
  const embed = embeds[0]!.data;
  expect(embed.title).toBe("The Odyssey — new dates & cinemas");
  expect(embed.fields?.[0]?.name).toBe("New dates");
  expect(embed.fields?.[1]?.name).toBe("New cinemas");
  expect(embed.fields?.[1]?.value).toContain("PVR: Juhu");
});

test("subscriptionAlert delegates to newCinemas when only venues", () => {
  const { embeds } = subscriptionAlert({
    title: "The Odyssey",
    city: "mumbai",
    dates: [],
    venues: [{ code: "PVRJ", name: "PVR: Juhu" }],
    url: URL,
  });
  expect(embeds[0]!.data.title).toBe("The Odyssey — new cinema");
});

// --- /list state line (issue #39) ---

function watchRow(over: Partial<Parameters<typeof watchList>[0][0]> = {}) {
  return {
    id: 1,
    title: "The Odyssey",
    city: "mumbai",
    date: "20260728",
    fail_count: 0,
    last_ok_at: null as number | null,
    ...over,
  };
}

test("watchList shows the last successful check as a relative timestamp", () => {
  const { embeds } = watchList([watchRow({ last_ok_at: 1786246591 })]);
  expect(embeds[0]!.data.description).toContain("checked <t:1786246591:R>");
});

test("watchList says so plainly when a watch has never been checked", () => {
  const { embeds } = watchList([watchRow({ last_ok_at: null })]);
  expect(embeds[0]!.data.description).toContain("not checked yet");
});

test("watchList keeps the last-ok time on a watch that can't read BookMyShow", () => {
  // The state that needed it: "can't read BookMyShow" alone does not tell you whether the
  // watch broke minutes ago or never worked at all.
  const { embeds } = watchList([watchRow({ fail_count: 3, last_ok_at: 1786246591 })]);
  const description = embeds[0]!.data.description!;
  expect(description).toContain("can't read BookMyShow");
  expect(description).toContain("<t:1786246591:R>");
});

test("watchList distinguishes a broken watch that never worked", () => {
  const { embeds } = watchList([watchRow({ fail_count: 5, last_ok_at: null })]);
  const description = embeds[0]!.data.description!;
  expect(description).toContain("can't read BookMyShow");
  expect(description).toContain("never checked");
  expect(description).not.toContain("<t:");
});

test("watchList keeps a null last_ok_at from rendering a broken timestamp", () => {
  for (const fail_count of [0, 3]) {
    const { embeds } = watchList([watchRow({ fail_count, last_ok_at: null })]);
    expect(embeds[0]!.data.description).not.toContain("<t:null");
    expect(embeds[0]!.data.description).not.toContain("NaN");
  }
});

test("watchList still keeps each watch to two lines without filters", () => {
  // Mobile-friendly: the state line grew, so check it did not grow a line.
  const { embeds } = watchList([watchRow({ fail_count: 3, last_ok_at: 1786246591 })]);
  expect(embeds[0]!.data.description!.split("\n")).toHaveLength(2);
});
