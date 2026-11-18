/**
 * Isolated end-to-end bot smoke test: exercises real command, poller, SQLite and
 * provider routing code in a fresh subprocess with mocked Discord and HTTP layers.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function runBotFlowWorker(): Promise<void> {
  const { mock } = await import("bun:test");
  const discord = await import("discord.js");

  const handlers = new Map<string, (...args: any[]) => any>();
  const deliveries: { id: string; payload: any }[] = [];
  let failDelivery = true;
  let nextTick: (() => void) | undefined;
  let channelSendCalls = 0;

  const nativeTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...args: any[]) => any, ms?: number, ...args: any[]) => {
    if (ms === 600_000) {
      nextTick = () => fn(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return nativeTimeout(fn, ms, ...args);
  }) as typeof setTimeout;

  class FakeClient {
    user = { tag: "SeatSniper-test" };
    ws = { status: discord.Status.Ready };
    users = {
      fetch: async (id: string) => ({
        send: async (payload: any) => {
          if (failDelivery) throw new Error("DM unavailable");
          deliveries.push({ id, payload });
        },
      }),
    };
    channels = {
      fetch: async (id: string) => {
        if (id === "dm-origin") {
          return {
            isDMBased: () => true,
            isTextBased: () => true,
            send: async () => {
              channelSendCalls++;
            },
          };
        }
        throw new Error("channel unavailable");
      },
    };
    on(event: string, fn: (...args: any[]) => any) {
      handlers.set(event, fn);
    }
    once(event: string, fn: (...args: any[]) => any) {
      handlers.set(event, fn);
    }
    async login() {
      return "test";
    }
    async destroy() {}
  }

  let bmsChildLive = true;
  let bmsImaxFirstLive = false;
  let bmsHttpCalls = 0;
  const bmsChipJson = JSON.stringify({
    type: "chip",
    title: "3D SCREEN X",
    cta: {
      type: "formatSelector",
      analytics: { event_code: "ET00502684" },
      additionalData: { eventUrl: "spider-man-3d-screen-x" },
    },
  });
  const bmsImaxChipJson = JSON.stringify({
    type: "chip",
    title: "IMAX 3D",
    cta: {
      type: "formatSelector",
      analytics: { event_code: "ET00509999" },
      additionalData: { eventUrl: "spider-man-imax-3d" },
    },
  });

  function buildBmsHtml(showsJson: string, chipPayload = "", dateCodes: string[] = []): string {
    const datesMeta = dateCodes.map((d) => `"dateCode":"${d}"`).join(",");
    return [
      "<html><head><title>Spider-Man Movie Showtimes in Mumbai</title></head><body>",
      "<script>window.__INITIAL_STATE__ = ",
      chipPayload || "{}",
      datesMeta ? `,${datesMeta}` : "",
      ";</script>",
      showsJson
        ? `showtimesSections "type":"venue-card","venueCode":"PVRM","venueName":"PVR Icon" ${showsJson}`
        : "",
      "</body></html>",
    ].join("");
  }

  // Date.now is pinned to 2026-11-14T12:00:00Z (17:30 IST on 20261114).
  const pastToday2dSession =
    '"additionalData":{"sessionId":"100","availStatus":"3","showDateCode":"20261114","showDateTime":"202611141000","showTimeCode":"1000","showTime":"10:00 AM","attributes":"2D"}';
  const parent2dSession =
    '"additionalData":{"sessionId":"101","availStatus":"2","showDateCode":"20261115","showDateTime":"202611151830","showTimeCode":"1830","showTime":"06:30 PM","attributes":"2D"}';
  const childScreenXSession =
    '"additionalData":{"sessionId":"202","availStatus":"2","showDateCode":"20261115","showDateTime":"202611151930","showTimeCode":"1930","showTime":"07:30 PM","attributes":"3D SCREEN X"}';
  const childImaxSession =
    '"additionalData":{"sessionId":"303","availStatus":"3","showDateCode":"20261218","showDateTime":"202612182000","showTimeCode":"2000","showTime":"08:00 PM","attributes":"IMAX 3D"}';

  mock.module("discord.js", () => ({ ...discord, Client: FakeClient }));
  mock.module("node-tls-client", () => ({
    ClientIdentifier: {
      safari_ios_17_0: "safari_17",
      safari_ios_18_0: "safari_18",
    },
    initTLS: async () => {},
    destroyTLS: async () => {},
    Session: class {
      async get(url: string) {
        bmsHttpCalls++;
        if (url.includes("/ET00440000/")) {
          // Parent 2D event has ZERO bookable dates and ZERO shows, only the IMAX 3D child chip.
          const html = buildBmsHtml("", bmsImaxChipJson, []);
          return { status: 200, text: async () => html };
        }
        if (url.includes("/ET00509999/")) {
          // Child IMAX 3D event opens 20261218 before parent 2D has any dates.
          const html = buildBmsHtml(
            bmsImaxFirstLive ? childImaxSession : "",
            "",
            bmsImaxFirstLive ? ["20261218"] : [],
          );
          return { status: 200, text: async () => html };
        }
        if (url.includes("/ET00502684/")) {
          const html = buildBmsHtml(bmsChildLive ? childScreenXSession : "", "");
          return { status: 200, text: async () => html };
        }
        const html = buildBmsHtml(`${pastToday2dSession} ${parent2dSession}`, bmsChipJson, [
          "20261114",
          "20261115",
        ]);
        return { status: 200, text: async () => html };
      }
      async close() {}
    },
  }));

  let live = false;
  let eventLive = false;
  const eventHtml = readFileSync(
    new URL("./fixtures/district/event-live.html", import.meta.url),
    "utf8",
  );
  const movieHtml = readFileSync(
    new URL("./fixtures/district/movie.html", import.meta.url),
    "utf8",
  );

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/events/")) {
      return new Response(eventLive ? eventHtml : eventHtml.replaceAll("BOOK_TICKETS", "LOGIN"));
    }
    return new Response(
      live ? movieHtml : movieHtml.replaceAll('"disableClick": false', '"disableClick": true'),
    );
  }) as unknown as typeof fetch;

  Date.now = () => Date.parse("2026-11-14T12:00:00Z");
  process.env.DISCORD_TOKEN = "fake-test-token";
  process.env.STAGGER_MS_MIN = "0";
  process.env.STAGGER_MS_MAX = "0";
  process.env.POLL_INTERVAL_SEC = "600";
  delete process.env.UPTIME_KUMA_PUSH_URL;

  await import("./index.ts");
  const db = await import("./db.ts");

  const onInteraction = handlers.get("interactionCreate");
  assert(onInteraction, "interactionCreate handler missing");

  const invokeWatch = async (options: Record<string, string>, user: string, channelId = "c") => {
    const replies: any[] = [];
    await onInteraction({
      commandName: "watch",
      user: { id: user },
      channelId,
      options: {
        getString: (key: string) => options[key] ?? null,
        getInteger: (key: string) => (options[key] ? Number(options[key]) : null),
        getNumber: (key: string) => (options[key] ? Number(options[key]) : null),
      },
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      deferred: true,
      replied: false,
      deferReply: async () => {},
      editReply: async (v: any) => replies.push(v),
    });
    return replies;
  };

  // 1. BMS single-date watch with natural date ("tomorrow") + formatFilter checks child chips.
  const bmsOnSaleReplies = await invokeWatch(
    {
      link: "https://in.bookmyshow.com/mumbai/movies/spider-man/ET00400001",
      date: "tomorrow",
      format: "ScreenX",
    },
    "bms-format-user",
  );
  assert.equal(
    db.listWatches("bms-format-user").length,
    0,
    "should not save watch when child chip is already on sale",
  );
  assert(JSON.stringify(bmsOnSaleReplies).includes("already on sale"));

  // Already-started show on "today" (10:00 AM IST < 17:30 IST) must NOT count as open now.
  await invokeWatch(
    {
      link: "https://in.bookmyshow.com/mumbai/movies/spider-man/ET00400001",
      date: "today",
    },
    "bms-today-user",
  );
  assert.equal(
    db.listWatches("bms-today-user").length,
    1,
    "already-started show on today should not trigger already-on-sale",
  );
  db.removeAllWatches("bms-today-user");

  // Arm watch when child chip has no shows yet, verify pre-network duplicate UX + Stop button.
  bmsChildLive = false;
  await invokeWatch(
    {
      link: "https://in.bookmyshow.com/mumbai/movies/spider-man/ET00400001",
      date: "tomorrow",
      format: "ScreenX",
    },
    "bms-format-user",
  );
  const armedId = db.listWatches("bms-format-user")[0]?.id;
  assert(armedId, "expected armed BMS watch");

  const callsBeforeDup = bmsHttpCalls;
  const dupReplies = await invokeWatch(
    {
      link: "https://in.bookmyshow.com/mumbai/movies/spider-man/ET00400001",
      date: "2026-11-15",
      format: "IMAX",
    },
    "bms-format-user",
  );
  assert.equal(bmsHttpCalls, callsBeforeDup, "duplicate watch must short-circuit before HTTP");
  assert(String(dupReplies[0]?.content).includes(`#${armedId}`));
  assert(String(dupReplies[0]?.content).includes("IMAX"));

  // Cross-user Stop button click is rejected; owner click removes the watch.
  const buttonReplies: string[] = [];
  const clickButton = async (customId: string, userId: string) => {
    await onInteraction({
      customId,
      user: { id: userId },
      isAutocomplete: () => false,
      isButton: () => true,
      isChatInputCommand: () => false,
      reply: async (v: { content: string }) => buttonReplies.push(v.content),
    });
  };
  await clickButton(`seatsniper:stop:${armedId}`, "intruder-user");
  assert(buttonReplies.pop()?.includes("isn't yours"));
  assert.equal(db.listWatches("bms-format-user").length, 1);

  await clickButton(`seatsniper:stop:${armedId}`, "bms-format-user");
  assert(buttonReplies.pop()?.includes(`#${armedId}`));
  assert.equal(db.listWatches("bms-format-user").length, 0);

  // 2. District movie & event watches, polling, retry on failed delivery, and deduplication.
  const createDistrictWatch = async (
    user: string,
    date: string,
    isEvent = false,
    channelId = "c",
  ) => {
    const options: Record<string, string> = isEvent
      ? {
          link: "https://www.district.in/events/samay-raina-live-delhi-yashobhoomi-6a9bfcb5d4d3d3abd96591c9-2026-buy-tickets",
          date,
          theatre: "Yashobhoomi",
          after: "14:00",
          before: "16:00",
        }
      : {
          link: "https://www.district.in/movies/ramayana-movie-tickets-in-mumbai-MV176276",
          date,
          format: "3D",
          theatre: "PVR",
          after: "13:00",
          before: "14:00",
          seats: "2",
          budget: "400",
        };
    const replies = await invokeWatch(options, user, channelId);
    assert.equal(db.listWatches(user).length, 1, JSON.stringify(replies));
  };

  await createDistrictWatch("dated-user", "2026-11-15", false, "dm-origin");
  await createDistrictWatch("subscriber", "any");
  const datedWatch = db.listWatches("dated-user")[0];
  assert(datedWatch);
  assert.equal(datedWatch.provider, "district");
  assert.equal(datedWatch.seat_count, 2);
  assert.equal(datedWatch.seat_budget, 400);

  // Verify /stop id autocomplete surfaces user's active watch.
  let stopChoices: { name: string; value: string | number }[] = [];
  await onInteraction({
    commandName: "stop",
    user: { id: "dated-user" },
    isAutocomplete: () => true,
    isButton: () => false,
    isChatInputCommand: () => false,
    options: { getFocused: () => ({ name: "id", value: "" }) },
    respond: async (items: { name: string; value: string | number }[]) => {
      stopChoices = items;
    },
  });
  assert.equal(stopChoices.length, 1);
  assert.equal(stopChoices[0]?.value, datedWatch.id);

  live = true;
  const waitForTick = async () => {
    for (let n = 0; n < 1000 && !nextTick; n++) await Bun.sleep(2);
    assert(nextTick, "poll did not finish");
  };

  handlers.get("clientReady")!({ user: { tag: "test" } });
  await waitForTick();

  // Verify liveness snapshot file was written atomically.
  const livenessFile = join(dirname(process.env.DB_PATH!), "last_cycle.json");
  assert(existsSync(livenessFile), "last_cycle.json liveness file missing");
  const liveness = JSON.parse(readFileSync(livenessFile, "utf8"));
  assert.equal(liveness.ok, true);
  assert.equal(liveness.gatewayReady, true);

  // Failed DM + DM-based origin channel must skip channel.send fallback and retain both watches.
  assert.equal(channelSendCalls, 0, "DM-based channel must not be used for channel fallback");
  assert.equal(deliveries.length, 0);
  assert.equal(db.listWatches("dated-user").length, 1);
  assert.deepEqual(db.seenDates(db.listWatches("subscriber")[0]!.id), []);

  failDelivery = false;
  const tick = nextTick!;
  nextTick = undefined;
  tick();
  await waitForTick();

  assert.equal(deliveries.length, 2);
  assert.equal(db.listWatches("dated-user").length, 0);
  assert.deepEqual(db.seenDates(db.listWatches("subscriber")[0]!.id), ["20261115"]);
  for (const delivery of deliveries) {
    assert(
      delivery.payload.components[0]
        .toJSON()
        .components[0].url.startsWith("https://www.district.in/"),
    );
  }

  const lastTick = nextTick!;
  nextTick = undefined;
  lastTick();
  await waitForTick();
  assert.equal(deliveries.length, 2, "repeat poll duplicated an alert");

  await createDistrictWatch("event-dated", "2027-02-05", true);
  await createDistrictWatch("event-subscriber", "any", true);
  assert.equal(db.listWatches("event-dated")[0]!.city, "delhi");
  assert(db.listWatches("event-dated")[0]!.event_code.startsWith("EV:"));

  eventLive = true;
  const eventTick = nextTick!;
  nextTick = undefined;
  eventTick();
  await waitForTick();

  assert.equal(deliveries.length, 4);
  assert.equal(db.listWatches("event-dated").length, 0);
  assert.deepEqual(db.seenDates(db.listWatches("event-subscriber")[0]!.id), [
    "20270205",
    "20270206",
    "20270207",
  ]);
  for (const delivery of deliveries.slice(2)) {
    assert(delivery.payload.components[0].toJSON().components[0].url.includes("/events/"));
  }

  const repeatEventTick = nextTick!;
  nextTick = undefined;
  repeatEventTick();
  await waitForTick();
  assert.equal(deliveries.length, 4, "event subscription duplicated an alert");

  // 3. Child-format-first drop: parent 2D has dates=[], child IMAX 3D opens 20261218.
  await invokeWatch(
    {
      link: "https://in.bookmyshow.com/mumbai/movies/spider-man/ET00440000",
      date: "2026-12-18",
      format: "IMAX",
    },
    "imax-dated-user",
  );
  await invokeWatch(
    {
      link: "https://in.bookmyshow.com/mumbai/movies/spider-man/ET00440000",
      date: "any",
      format: "IMAX",
    },
    "imax-sub-user",
  );
  assert.equal(db.listWatches("imax-dated-user").length, 1);
  assert.equal(db.listWatches("imax-sub-user").length, 1);

  bmsImaxFirstLive = true;
  const imaxTick = nextTick!;
  nextTick = undefined;
  imaxTick();
  await waitForTick();

  assert.equal(deliveries.length, 6, "both dated and subscription IMAX-first watches must fire");
  assert.equal(db.listWatches("imax-dated-user").length, 0, "one-shot IMAX watch should retire");
  assert.deepEqual(
    db.seenDates(db.listWatches("imax-sub-user")[0]!.id),
    ["20261218"],
    "IMAX subscription must record 20261218 in seen_dates",
  );

  // 4. Autocomplete on /watch format works cleanly.
  let suggestions: { name: string; value: string | number }[] = [];
  await onInteraction({
    commandName: "watch",
    user: { id: "dated-user" },
    isAutocomplete: () => true,
    isButton: () => false,
    isChatInputCommand: () => false,
    options: { getFocused: () => ({ name: "format", value: "im" }) },
    respond: async (items: { name: string; value: string | number }[]) => {
      suggestions = items;
    },
  });
  assert(suggestions.some((s) => s.value === "IMAX"));

  console.log(
    "SeatSniper bot flow passed: BMS child chips, natural dates, buttons, liveness, District movies & events",
  );
}

if (process.env.SEATSNIPER_BOT_FLOW_WORKER === "1") {
  await runBotFlowWorker();
  process.exit(0);
} else {
  const { expect, test } = await import("bun:test");

  test("BMS child format validation, stop buttons, liveness, and District polling pass end-to-end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seatsniper-flow-"));
    try {
      const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
        env: {
          ...process.env,
          SEATSNIPER_BOT_FLOW_WORKER: "1",
          DB_PATH: join(dir, "test.db"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(await child.exited, out + err).toBe(0);
      expect(out).toContain("SeatSniper bot flow passed");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows temp cleanup best-effort
      }
    }
  });
}
