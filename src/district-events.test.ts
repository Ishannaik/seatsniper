import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fetchDistrictEvent, flightRecords, parseDistrictEvent } from "./district-events.ts";
import {
  beginCycle,
  bookableDatesCached,
  fetchShowtimesCached,
  parseWatchUrl,
  showtimesUrl,
} from "./providers.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/district/event-${name}.html`, import.meta.url), "utf8");
}

const slug = "samay-raina-live-delhi-yashobhoomi-6a9bfcb5d4d3d3abd96591c9-2026";
const now = Date.parse("2026-11-15T12:00:00Z");
const target = {
  provider: "district" as const,
  city: "delhi",
  slug,
  eventCode: `EV:${slug}`,
  date: "20270205",
};
const fetchOriginal = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  beginCycle();
});

test("event URLs use their own identity and canonical booking link", () => {
  expect(
    parseWatchUrl(`https://www.district.in/events/${slug}-buy-tickets?utm_source=test`),
  ).toEqual({
    ...target,
    city: "",
    date: undefined,
  });
  expect(showtimesUrl(target)).toBe(`https://www.district.in/events/${slug}-buy-tickets`);
  expect(() => parseWatchUrl("https://www.district.in/events/comedy")).toThrow();
});

test("captured general sale returns only sellable shows and IST dates", () => {
  const parsed = parseDistrictEvent(fixture("live"), { slug }, now);
  expect(parsed.title).toBe("Samay Raina Live | Delhi | Yashobhoomi");
  expect(parsed.city).toBe("delhi");
  expect(parsed.dates).toEqual(["20270205", "20270206", "20270207"]);
  expect(parsed.shows).toHaveLength(5);
  expect(parsed.shows[0]).toMatchObject({
    epoch: 1801819800,
    showTime: "15:00",
    venueName: "Yashobhoomi",
  });
});

test("coming-soon registration is not a bookable ticket event", () => {
  const parsed = parseDistrictEvent(
    fixture("soon"),
    { slug: "akaash-singh-generational-triumph-tour-delhi-2027" },
    now,
  );
  expect(parsed.title).toContain("Akaash");
  expect(parsed.shows).toEqual([]);
  expect(parsed.dates).toEqual([]);
});

type MutableEventFixture = {
  sold_out?: boolean;
  locked?: boolean;
  horizontal_cover_image?: string;
  event_state_config: { user_action_state: string };
  sales: { sale_type: string }[];
  sellable_shows?: {
    sold_out?: boolean;
    is_hidden?: boolean;
    start_utc_timestamp?: number;
  }[];
};

function change(mutator: (data: MutableEventFixture) => void): string {
  const record = flightRecords(fixture("live"))[0] as [
    unknown,
    unknown,
    unknown,
    { eventData: { data: MutableEventFixture } },
  ];
  mutator(record[3].eventData.data);
  return `<script>self.__next_f.push(${JSON.stringify([1, `25:${JSON.stringify(record)}\n`])})</script>`;
}

test("sold-out, hidden, past and restricted presale sessions do not alert", () => {
  const mutations: ((d: MutableEventFixture) => void)[] = [
    (d) => {
      d.sold_out = true;
    },
    (d) => {
      d.locked = true;
    },
    (d) => {
      d.event_state_config.user_action_state = "LOGIN";
    },
    (d) => {
      for (const sale of d.sales) {
        sale.sale_type = "pre_reg_sale";
      }
    },
    (d) => {
      for (const show of d.sellable_shows ?? []) {
        show.sold_out = true;
      }
    },
    (d) => {
      for (const show of d.sellable_shows ?? []) {
        show.is_hidden = true;
      }
    },
  ];

  for (const mutate of mutations) {
    expect(parseDistrictEvent(change(mutate), { slug }, now).shows).toEqual([]);
  }
  expect(parseDistrictEvent(fixture("live"), { slug }, Date.parse("2028-01-01")).shows).toEqual([]);
});

test("missing fields, wrong identity and blocked HTML throw instead of returning empty", () => {
  expect(() => parseDistrictEvent("Access denied", { slug }, now)).toThrow();
  expect(() => parseDistrictEvent(fixture("live"), { slug: "wrong" }, now)).toThrow();
  expect(() =>
    parseDistrictEvent(
      change((d) => {
        delete d.sellable_shows;
      }),
      { slug },
      now,
    ),
  ).toThrow();
  expect(() =>
    parseDistrictEvent(
      change((d) => {
        delete d.sellable_shows?.[0]?.start_utc_timestamp;
      }),
      { slug },
      now,
    ),
  ).toThrow();
});

test("Flight text lengths use UTF-8 bytes; content is never interpreted as records or code", () => {
  const text = 'Résumé\n25:{"fake":true} self.__next_f.push([])';
  const json = '26:{"ok":true}\n';
  const stream = `1:T${new TextEncoder().encode(text).length.toString(16)},${text}${json}`;
  expect(
    flightRecords(`<script>self.__next_f.push(${JSON.stringify([1, stream])})</script>`),
  ).toEqual([{ ok: true }]);
});

test("event date and showtime reads share a single HTTP request per cycle", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(fixture("live"));
  }) as unknown as typeof fetch;

  beginCycle();
  const [dates, first, second] = await Promise.all([
    bookableDatesCached(target),
    fetchShowtimesCached(target),
    fetchShowtimesCached({ ...target, date: "20270206" }),
  ]);

  expect(dates.dates).toHaveLength(3);
  expect(first.shows).toHaveLength(2);
  expect(first.chips).toEqual([]);
  expect(second.shows).toHaveLength(1);
  expect(second.chips).toEqual([]);
  expect(calls).toBe(1);

  beginCycle();
  await bookableDatesCached(target);
  expect(calls).toBe(2);
});

test("HTTP errors remain actionable errors and surface Retry-After", async () => {
  globalThis.fetch = (async () =>
    new Response("blocked", { status: 403 })) as unknown as typeof fetch;
  await expect(fetchDistrictEvent(target)).rejects.toThrow("District event HTTP 403");

  globalThis.fetch = (async () =>
    new Response("slow down", {
      status: 429,
      headers: { "Retry-After": "60" },
    })) as unknown as typeof fetch;
  await expect(fetchDistrictEvent(target)).rejects.toThrow(
    "District event HTTP 429 (Retry-After: 60)",
  );
});

test("extracts optional event posterUrl when https cover image is present", () => {
  const withCover = change((d) => {
    d.horizontal_cover_image = "https://cdn.district.in/events/samay-cover.jpg";
  });
  const parsed = parseDistrictEvent(withCover, { slug }, now);
  expect(parsed.posterUrl).toBe("https://cdn.district.in/events/samay-cover.jpg");
});
