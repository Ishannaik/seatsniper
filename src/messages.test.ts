import { expect, test } from "bun:test";
import { type APIButtonComponent, type APIEmbed, ButtonStyle } from "discord.js";
import {
  ALARM,
  ARMED,
  alreadyOnSale,
  armedForDate,
  armedForMovie,
  cannotRead,
  duplicateWatch,
  help,
  LIVE,
  newCinemas,
  newDates,
  RETIRED,
  subscriptionAlert,
  ticketsLive,
  watchExpired,
  type WatchListRow,
  watchList,
} from "./messages.ts";
import type { Show } from "./movie-model.ts";

const URL = "https://in.bookmyshow.com/movies/mumbai/foo/buytickets/ET00000001";
const POSTER =
  "https://assets-in.bmscdn.com/iedb/movies/images/mobile/thumbnail/xlarge/odyssey.jpg";

function show(
  venueCode: string,
  venueName: string,
  epoch = 0,
  attributes = "",
  over: Partial<Show> = {},
): Show {
  return {
    sessionId: "s",
    availStatus: "",
    showDateCode: "20260728",
    showTime: "06:40 AM",
    attributes,
    epoch,
    venueCode,
    venueName,
    ...over,
  };
}

function firstEmbed(payload: { embeds: { toJSON(): APIEmbed }[] }): APIEmbed {
  const first = payload.embeds[0];
  if (!first) throw new Error("expected at least one embed");
  return first.toJSON();
}

function rowButtons(
  payload: { components?: { toJSON(): { components: APIButtonComponent[] } }[] },
  rowIndex = 0,
): APIButtonComponent[] {
  return payload.components?.[rowIndex]?.toJSON().components ?? [];
}

test("alreadyOnSale lists theatres, countdown, formats, and https poster thumbnail", () => {
  const noEpoch = firstEmbed(
    alreadyOnSale({
      title: "The Odyssey",
      city: "new-delhi",
      date: "20260728",
      shows: [show("PVRJ", "PVR: Juhu"), show("MCIW", "Miraj Cinemas: IMAX, Wadala")],
      url: URL,
    }),
  );
  expect(noEpoch.description).toContain("New Delhi");
  expect(noEpoch.description).not.toContain("<t:0:R>");
  expect(noEpoch.timestamp).toBeTruthy();

  const embed = firstEmbed(
    alreadyOnSale({
      title: "The Odyssey",
      city: "mumbai",
      date: "20260728",
      shows: [
        show("", "PVR: Juhu", 1785200000, "IMAX"),
        show("", "Miraj Cinemas: IMAX, Wadala", 1785203600),
      ],
      url: URL,
      posterUrl: POSTER,
    }),
  );
  const theatres = embed.fields?.find((field) => field.name === "Theatres");
  const showtimes = embed.fields?.find((field) => field.name === "Showtimes");
  expect(theatres?.value).toContain("PVR: Juhu");
  expect(theatres?.value).toContain("Miraj Cinemas: IMAX, Wadala");
  expect(embed.description).toContain("first show <t:1785200000:R>");
  expect(showtimes?.value).toContain("`IMAX`");
  expect(embed.thumbnail?.url).toBe(POSTER);
});

test("ticketsLive groups showtimes under theatre headings with inline format badges and countdown", () => {
  const embed = firstEmbed(
    ticketsLive({
      title: "The Odyssey",
      city: "mumbai",
      date: "20260728",
      shows: [
        show("PVRJ", "PVR: Juhu", 2000, "IMAX"),
        show("MCIW", "Miraj Cinemas: IMAX, Wadala", 1500),
        show("INOX", "", 1500),
      ],
      url: URL,
    }),
  );
  const value = embed.fields?.find((field) => field.name === "Showtimes")?.value ?? "";
  expect(embed.description).toContain("first show <t:1500:R>");
  expect(value).toContain("**PVR: Juhu**");
  expect(value).toContain("**Miraj Cinemas: IMAX, Wadala**");
  expect(value).toContain("**INOX**");
  expect(value).toContain("<t:2000:t> `IMAX`");
  expect((value.match(/<t:1500:t>/g) ?? []).length).toBe(2);
});

test("ticketsLive marks BMS and low-inventory District shows as filling fast without misclassifying BMS tiers", () => {
  const embed = firstEmbed(
    ticketsLive({
      title: "The Odyssey",
      city: "mumbai",
      date: "20260728",
      shows: [
        show("PVRJ", "PVR: Juhu", 1000, "IMAX", { availStatus: "1" }),
        show("INOX", "INOX: Nariman Point", 2000, "2D", {
          availStatus: "3",
          ticketCategories: [{ name: "Recliner", available: 1, price: 600 }],
        }),
        show("DIST", "Cinepolis: Andheri", 3000, "4DX", {
          availStatus: "AVAILABLE",
          ticketCategories: [
            { name: "Classic", available: 8, price: 350, totalSeats: 40 },
            { name: "Prime", available: 10, price: 450 },
          ],
        }),
      ],
      url: URL,
    }),
  );
  const value = embed.fields?.find((field) => field.name === "Showtimes")?.value ?? "";
  const categories = embed.fields?.find((field) => field.name === "Ticket categories")?.value ?? "";
  expect(value).toContain("<t:1000:t> `IMAX` _(filling fast)_");
  expect(value).not.toContain("<t:2000:t> `2D` _(filling fast)_");
  expect(value).toContain("<t:3000:t> `4DX` _(filling fast)_");
  expect(categories).toContain("INOX: Nariman Point · Recliner: ₹600/seat\n");
  expect(categories).not.toContain("Recliner: ₹600/seat · 1 available");
  expect(categories).toContain("Cinepolis: Andheri · Classic: ₹350/seat · 8/40 available");
});

test("ticketsLive keeps grouped showtimes within Discord 1024-char field limit and ignores http:// posters", () => {
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
  const embed = firstEmbed(
    ticketsLive({
      title: "The Odyssey",
      city: "mumbai",
      date: "20260728",
      shows,
      url: URL,
      posterUrl: "http://example.com/poster.jpg",
    }),
  );
  const value = embed.fields?.find((field) => field.name === "Showtimes")?.value ?? "";
  expect(value.length).toBeLessThanOrEqual(1024);
  expect(value).toMatch(/more theatres/);
  expect(embed.thumbnail).toBeUndefined();
});

test("newCinemas lists venue names without leaking internal venue codes", () => {
  const payload = newCinemas({
    title: "The Odyssey",
    city: "mumbai",
    venues: [
      { code: "65155df864ef780008098937", name: "PVR: Juhu" },
      { code: "MCIW", name: "Miraj Cinemas: IMAX, Wadala" },
      { code: "FALLBACK1", name: "" },
    ],
    url: URL,
    watchId: 9,
  });
  const embed = firstEmbed(payload);
  expect(embed.color).toBe(LIVE);
  expect(embed.title).toBe("The Odyssey — 3 new cinemas");
  expect(embed.description).toContain("**PVR: Juhu**");
  expect(embed.description).toContain("**Miraj Cinemas: IMAX, Wadala**");
  expect(embed.description).toContain("**FALLBACK1**");
  expect(embed.description).not.toContain("65155df864ef780008098937");
  expect(embed.description).not.toContain("MCIW");

  const buttons = rowButtons(payload, 0);
  expect(buttons).toHaveLength(2);
  expect(buttons[1]).toMatchObject({
    custom_id: "seatsniper:stop:9",
    label: "Stop watching",
    style: ButtonStyle.Secondary,
  });
});

test("subscriptionAlert handles date-only, venue-only, and combined alerts", () => {
  const dateOnly = subscriptionAlert({
    title: "The Odyssey",
    city: "mumbai",
    dates: ["20260728"],
    venues: [],
    url: URL,
    filters: "IMAX · after 18:00",
    matchedFormats: ["IMAX 3D"],
    watchId: 4,
    posterUrl: POSTER,
    shows: [
      show("PVRJ", "PVR: Juhu", 1785243000, "IMAX 3D", {
        bookingUrl: "https://www.district.in/movies/seat-layout/abc",
        ticketCategories: [{ name: "IMAX", available: 25, price: 650 }],
      }),
    ],
  });
  const dateEmbed = firstEmbed(dateOnly);
  expect(dateEmbed.title).toBe("The Odyssey — a new date opened");
  expect(dateEmbed.description).toContain(
    "_Matching your filter: IMAX · after 18:00 (found: IMAX 3D)_",
  );
  expect(rowButtons(dateOnly, 0)[1]).toMatchObject({
    custom_id: "seatsniper:stop:4",
    label: "Stop watching",
  });
  expect(rowButtons(dateOnly, 1)).toHaveLength(1);

  expect(
    firstEmbed(
      newDates({ title: "The Odyssey", city: "mumbai", dates: ["20260728", "20260730"], url: URL }),
    ).fields,
  ).toBeUndefined();

  const combined = firstEmbed(
    subscriptionAlert({
      title: "The Odyssey",
      city: "mumbai",
      dates: ["20260728", "20260730"],
      venues: [{ code: "1023314", name: "PVR: Juhu" }],
      url: URL,
    }),
  );
  expect(combined.title).toBe("The Odyssey — new dates & cinemas");
  expect(combined.fields?.[1]?.value).toBe("**PVR: Juhu**");

  const venueOnly = firstEmbed(
    subscriptionAlert({
      title: "The Odyssey",
      city: "mumbai",
      dates: [],
      venues: [{ code: "PVRJ", name: "PVR: Juhu" }],
      url: URL,
    }),
  );
  expect(venueOnly.title).toBe("The Odyssey — new cinema");
});

test("armedForDate, armedForMovie, and duplicateWatch attach Stop buttons and explain filter state", () => {
  const dated = armedForDate({
    title: "The Odyssey",
    city: "mumbai",
    date: "20260730",
    everyMin: 10,
    filters: "IMAX",
    watchId: 7,
    url: URL,
    posterUrl: POSTER,
  });
  const datedEmbed = firstEmbed(dated);
  expect(datedEmbed.color).toBe(ARMED);
  expect(datedEmbed.url).toBe(URL);
  expect(datedEmbed.thumbnail?.url).toBe(POSTER);
  expect(rowButtons(dated, 0)[0]).toMatchObject({
    custom_id: "seatsniper:stop:7",
    label: "Stop watch",
    style: ButtonStyle.Secondary,
  });

  const filteredMovie = armedForMovie({
    title: "The Odyssey",
    city: "mumbai",
    openNow: [],
    totalOpenDates: 3,
    filters: "IMAX",
    watchId: 8,
  });
  expect(firstEmbed(filteredMovie).fields?.[0]?.value).toContain(
    "3 dates on sale without your filter",
  );
  expect(rowButtons(filteredMovie, 0)[0]).toMatchObject({ custom_id: "seatsniper:stop:8" });

  expect(
    firstEmbed(
      armedForMovie({ title: "The Odyssey", city: "mumbai", openNow: [], totalOpenDates: 0 }),
    ).fields?.[0]?.name,
  ).toBe("Nothing on sale yet");

  const dup = duplicateWatch({
    id: 7,
    title: "The Odyssey",
    date: "20260730",
    currentFilters: "ScreenX",
    requestedFilters: "IMAX",
  });
  expect(dup.content).toContain("#7");
  expect(dup.content).toContain("with **IMAX**");
  expect(rowButtons(dup, 0)[0]).toMatchObject({ custom_id: "seatsniper:stop:7", label: "Stop #7" });
});

function watchRow(over: Partial<WatchListRow> = {}): WatchListRow {
  return {
    id: 1,
    title: "The Odyssey",
    city: "mumbai",
    date: "20260728",
    fail_count: 0,
    last_ok_at: null,
    ...over,
  };
}

test("watchList renders health states, links, filters, and interactive Stop buttons", () => {
  expect(firstEmbed(watchList([watchRow({ last_ok_at: 1786246591 })])).description).toContain(
    "checked <t:1786246591:R>",
  );
  expect(firstEmbed(watchList([watchRow({ last_ok_at: null })])).description).toContain(
    "not checked yet",
  );
  expect(
    firstEmbed(watchList([watchRow({ fail_count: 3, last_ok_at: 1786246591 })])).description,
  ).toContain("can't read BookMyShow · last checked <t:1786246591:R>");
  expect(
    firstEmbed(watchList([watchRow({ fail_count: 5, last_ok_at: null })])).description,
  ).toContain("can't read BookMyShow · never checked");

  const single = watchList([watchRow({ fail_count: 3, last_ok_at: 1786246591, url: URL })]);
  const singleDesc = firstEmbed(single).description ?? "";
  expect(singleDesc.split("\n")).toHaveLength(2);
  expect(singleDesc).toContain(`#1 · **[The Odyssey](${URL})**`);
  expect(rowButtons(single, 0)[0]).toMatchObject({
    custom_id: "seatsniper:stop:1",
    label: "Stop #1 · The Odyssey",
    style: ButtonStyle.Secondary,
  });

  const multi = watchList([
    watchRow({
      id: 1,
      format_filter: "IMAX",
      theatre_filter: "PVR",
      day_filter: "fri,sat",
      after_filter: "18:00",
      before_filter: "22:00",
    }),
    watchRow({
      id: 2,
      title: "A".repeat(120),
      date: "",
      provider: "district",
      after_filter: "19:00",
      seat_budget: 400,
    }),
  ]);
  const multiDesc = firstEmbed(multi).description ?? "";
  expect(multiDesc).toContain("\nFilter: IMAX · PVR · fri,sat · 18:00–22:00");
  expect(multiDesc).toContain("\nFilter: after 19:00");
  expect(multiDesc).toContain("\nup to ₹400/seat before fees");
  const secondLabel =
    "label" in (rowButtons(multi, 0)[1] ?? {})
      ? (rowButtons(multi, 0)[1] as { label: string }).label
      : "";
  expect(secondLabel.length).toBeLessThanOrEqual(80);
  expect(rowButtons(multi, 1)[0]).toMatchObject({
    custom_id: "seatsniper:stop:all",
    label: "Stop all watches",
    style: ButtonStyle.Danger,
  });
});

test("cannotRead, watchExpired, and help render semantic colours and dynamic cadence footer", () => {
  const errEmbed = firstEmbed(
    cannotRead({ title: "The Odyssey", error: "HTTP 403", provider: "District" }),
  );
  expect(errEmbed.color).toBe(ALARM);
  expect(errEmbed.title).toContain("District");

  const expEmbed = firstEmbed(watchExpired({ title: "The Odyssey", date: "20260728" }));
  expect(expEmbed.color).toBe(RETIRED);
  expect(expEmbed.title).toBe("The Odyssey — watch ended");

  const helpEmbed = firstEmbed(help({ everyMin: 5, maxWatches: 5 }));
  expect(helpEmbed.footer?.text).toBe("Checks every 5 minutes · 5 watches each");
  const oneDate = helpEmbed.fields?.find((field) => field.name === "Watch one date")?.value ?? "";
  const filter =
    helpEmbed.fields?.find((field) => field.name === "Filter by format / theatre / day")?.value ??
    "";
  const limits = helpEmbed.fields?.find((field) => field.name === "Limits")?.value ?? "";
  expect(oneDate).toContain("tomorrow");
  expect(filter).toContain("after:");
  expect(filter).toContain("before:");
  expect(limits).toContain("never logs in");
});
