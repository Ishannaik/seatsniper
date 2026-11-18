/** SeatSniper — paste a BookMyShow or District link, get a DM when that date opens. */
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Options,
  Status,
} from "discord.js";
import { commandSuggestions } from "./commands.ts";
import {
  addSubscription,
  addWatch,
  allWatches,
  closeDb,
  countWatches,
  DB_PATH,
  findWatch,
  getWatchById,
  listWatches,
  MAX_WATCHES_PER_USER,
  type NewWatch,
  removeAllWatches,
  removeWatch,
  SUBSCRIPTION,
  type Watch,
} from "./db.ts";
import {
  filterMatchingShows,
  filterSummary,
  hasShowLevelFilter,
  type NormalizedWatchFilters,
  parseWatchFilters,
} from "./filters.ts";
import * as msg from "./messages.ts";
import {
  checkWatch,
  type DeliveryOutcome,
  expireStale,
  type MessagePayload,
  qualifySubscriptionDates,
} from "./poller.ts";
import {
  type BmsError,
  beginCycle,
  closeProviders,
  coalescedCount,
  discoverListing,
  type FormatChip,
  initProviders,
  isDistrictEvent,
  parseWatchUrl,
  providerName,
  providerOf,
  resolveTargetCity,
  type Show,
  showsForListing,
  showtimesUrl,
  type Target,
} from "./providers.ts";
import { staggerBounds, staggerDelayMs } from "./stagger.ts";
import { parseDateInput, prettyDate, todayIST } from "./time-filter.ts";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error("DISCORD_TOKEN missing — copy .env.example to .env");

const POLL_MS = Number(process.env.POLL_INTERVAL_SEC ?? 600) * 1000;
if (!Number.isFinite(POLL_MS) || POLL_MS < 1000) {
  throw new Error("POLL_INTERVAL_SEC must be at least 1 second");
}

const STAGGER = staggerBounds();
const UPTIME_KUMA_PUSH_URL = process.env.UPTIME_KUMA_PUSH_URL?.trim() || "";
const LIVENESS_PATH =
  process.env.LIVENESS_PATH?.trim() || join(dirname(DB_PATH), "last_cycle.json");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  makeCache: Options.cacheWithLimits({
    MessageManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    GuildMemberManager: 0,
    UserManager: 50,
  }),
});

type ListingIdentity = {
  provider?: "bms" | "district";
  city: string;
  slug: string;
  eventCode: string;
};

function duplicatePayload(existing: Watch, requestedFilters: string | null) {
  return msg.duplicateWatch({
    id: existing.id,
    title: existing.title,
    date: existing.date,
    currentFilters: filterSummary(existing),
    requestedFilters,
  });
}

async function guardDuplicateOrCap(
  i: ChatInputCommandInteraction,
  listing: ListingIdentity,
  date: string,
  requestedSummary: string | null,
): Promise<boolean> {
  const existing = findWatch(i.user.id, providerOf(listing), listing.city, listing.eventCode, date);
  if (existing) {
    await i.editReply(duplicatePayload(existing, requestedSummary));
    return true;
  }
  if (countWatches(i.user.id) >= MAX_WATCHES_PER_USER) {
    await i.editReply(`You're at ${MAX_WATCHES_PER_USER} watches. \`/stop\` one first.`);
    return true;
  }
  return false;
}

function providerErrorText(listing: ListingIdentity, err: BmsError): string {
  if (err.kind === "not_found") {
    return (
      `❌ No movie found for \`${listing.eventCode}\` in ${listing.city}. ` +
      "Check the link — the city and the event code have to match."
    );
  }
  return (
    `⚠️ Can't reach ${providerName(listing)} right now, so I won't save a watch I can't check.\n` +
    `\`${err.message}\``
  );
}

function buildNewWatch(
  i: ChatInputCommandInteraction,
  listing: ListingIdentity,
  date: string,
  title: string,
  f: NormalizedWatchFilters,
): NewWatch {
  return {
    user_id: i.user.id,
    channel_id: i.channelId,
    provider: listing.provider,
    city: listing.city,
    slug: listing.slug,
    event_code: listing.eventCode,
    date,
    title,
    ...f,
  };
}

async function replyRaceDuplicate(
  i: ChatInputCommandInteraction,
  listing: ListingIdentity,
  date: string,
  requestedSummary: string | null,
  fallback: string,
): Promise<void> {
  const existing = findWatch(i.user.id, providerOf(listing), listing.city, listing.eventCode, date);
  if (existing) {
    await i.editReply(duplicatePayload(existing, requestedSummary));
    return;
  }
  await i.editReply(fallback);
}

async function cmdWatch(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const filterResult = parseWatchFilters({
    format: i.options.getString("format"),
    days: i.options.getString("days"),
    after: i.options.getString("after"),
    before: i.options.getString("before"),
    theatre: i.options.getString("theatre"),
    seats: i.options.getInteger("seats"),
    budget: i.options.getNumber("budget"),
  });
  if (!filterResult.ok) return void (await i.editReply(filterResult.error));
  const { filters: f, summary } = filterResult;

  let target: Target;
  try {
    const parsed = parseWatchUrl(i.options.getString("link", true));
    if (isDistrictEvent(parsed) && (f.seat_count != null || f.seat_budget != null)) {
      return void (await i.editReply(
        "Seat count and budget alerts apply to movies only; District events don't expose cinema seat tiers.",
      ));
    }
    if (f.seat_count != null && parsed.provider !== "district") {
      return void (await i.editReply(
        "Exact seat-count alerts (`seats:`) currently support District movies only — BookMyShow only publishes tier prices, so use `budget:` without `seats:`.",
      ));
    }
    if (isDistrictEvent(parsed) && f.format_filter) {
      return void (await i.editReply(
        "District events don't have cinema formats. Leave format empty; day, time and venue filters are supported.",
      ));
    }
    parsed.city = await resolveTargetCity(parsed);

    const dateOpt = i.options.getString("date")?.trim();
    const resolvedDate = dateOpt
      ? parseDateInput(dateOpt)
      : parsed.date
        ? parseDateInput(parsed.date)
        : "any";

    if (resolvedDate === "any") {
      return void (await subscribeToMovie(i, parsed, f, summary));
    }
    if (resolvedDate < todayIST()) {
      return void (await i.editReply(
        `❌ ${prettyDate(resolvedDate)} has already passed — a watch for it could never fire.`,
      ));
    }
    target = {
      provider: parsed.provider,
      city: parsed.city,
      slug: parsed.slug,
      eventCode: parsed.eventCode,
      date: resolvedDate,
    };
  } catch (e) {
    return void (await i.editReply(`❌ ${(e as Error).message}`));
  }

  if (await guardDuplicateOrCap(i, target, target.date, summary)) return;

  let open: Show[];
  let title: string;
  let posterUrl: string | undefined;
  try {
    const res = await showsForListing(target, f.format_filter);
    title = res.title;
    posterUrl = res.posterUrl;
    open = filterMatchingShows(res.shows, f, { checkDay: true });
  } catch (e) {
    return void (await i.editReply(providerErrorText(target, e as BmsError)));
  }

  const url = showtimesUrl(target);
  if (open.length) {
    return void (await i.editReply(
      msg.alreadyOnSale({
        title,
        city: target.city,
        date: target.date,
        shows: open,
        url,
        posterUrl,
      }),
    ));
  }

  const id = addWatch(buildNewWatch(i, target, target.date, title, f));
  if (id === null) {
    return void (await replyRaceDuplicate(
      i,
      target,
      target.date,
      summary,
      "You're already watching that movie and date. `/list` to see it.",
    ));
  }

  await i.editReply(
    msg.armedForDate({
      title,
      city: target.city,
      date: target.date,
      everyMin: Math.round(POLL_MS / 60000),
      filters: summary,
      watchId: id,
      url,
      posterUrl,
    }),
  );
}

async function subscribeToMovie(
  i: ChatInputCommandInteraction,
  parsed: ListingIdentity,
  f: NormalizedWatchFilters,
  summary: string | null,
): Promise<void> {
  if (await guardDuplicateOrCap(i, parsed, SUBSCRIPTION, summary)) return;

  let title: string;
  let dates: string[];
  let venues: { code: string; name: string }[] | null;
  let chips: FormatChip[];
  let posterUrl: string | undefined;
  let baseline: string[];
  try {
    ({ title, dates, venues, chips, posterUrl } = await discoverListing(parsed, f.format_filter));
    baseline = (
      await qualifySubscriptionDates(parsed, dates, f, chips, showsForListing, {
        logPrefix: "[sub]",
      })
    ).dates;
  } catch (e) {
    return void (await i.editReply(providerErrorText(parsed, e as BmsError)));
  }

  const id = addSubscription(
    buildNewWatch(i, parsed, SUBSCRIPTION, title, f),
    baseline,
    venues ? venues.map((v) => v.code) : null,
  );
  if (id === null) {
    return void (await replyRaceDuplicate(
      i,
      parsed,
      SUBSCRIPTION,
      summary,
      "You're already subscribed to that movie. `/list` to see it.",
    ));
  }

  const isFiltered = hasShowLevelFilter(parsed.provider, f) || Boolean(f.day_filter);
  await i.editReply(
    msg.armedForMovie({
      title,
      city: parsed.city,
      openNow: isFiltered ? baseline : dates,
      totalOpenDates: dates.length,
      filters: summary,
      isEvent: isDistrictEvent(parsed),
      watchId: id,
      url: showtimesUrl({ ...parsed, date: dates[0] ?? todayIST() }),
      posterUrl,
      warning:
        f.format_filter && !baseline.length
          ? `_No ${f.format_filter} shows exist for this movie right now — I'll ping you the moment one appears._`
          : null,
    }),
  );
}

async function cmdList(i: ChatInputCommandInteraction): Promise<void> {
  const today = todayIST();
  const rows = listWatches(i.user.id).map((w) => ({
    ...w,
    url: showtimesUrl({
      provider: w.provider,
      city: w.city,
      slug: w.slug,
      eventCode: w.event_code,
      date: w.date || today,
    }),
  }));
  if (!rows.length) {
    return void (await i.reply({
      content: "Nothing being watched yet. `/help` shows how to start one.",
      flags: MessageFlags.Ephemeral,
    }));
  }
  await i.reply({ ...msg.watchList(rows), flags: MessageFlags.Ephemeral });
}

async function cmdStop(i: ChatInputCommandInteraction): Promise<void> {
  if (i.options.getBoolean("all")) {
    const content = msg.stoppedAllText(removeAllWatches(i.user.id));
    return void (await i.reply({ content, flags: MessageFlags.Ephemeral }));
  }

  const id = i.options.getInteger("id");
  if (id === null) {
    return void (await i.reply({
      content: "Pick a watch `id:` to stop, or pass `all: true` to stop every watch.",
      flags: MessageFlags.Ephemeral,
    }));
  }

  const existing = getWatchById(id);
  if (!existing || existing.user_id !== i.user.id || !removeWatch(id, i.user.id)) {
    return void (await i.reply({
      content: `No watch #${id} of yours.`,
      flags: MessageFlags.Ephemeral,
    }));
  }

  await i.reply({
    content: `Stopped watching **${existing.title}** (#${id}).`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStopButton(i: ButtonInteraction): Promise<void> {
  if (i.customId === msg.STOP_ALL_CUSTOM_ID) {
    const content = msg.stoppedAllText(removeAllWatches(i.user.id));
    await i.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  const id = Number(i.customId.slice(msg.STOP_BUTTON_PREFIX.length));
  if (!Number.isInteger(id) || id < 1) {
    await i.reply({ content: "Invalid watch ID.", flags: MessageFlags.Ephemeral });
    return;
  }

  const existing = getWatchById(id);
  if (!existing) {
    await i.reply({
      content: `Watch #${id} is no longer active.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (existing.user_id !== i.user.id) {
    await i.reply({ content: "That watch isn't yours.", flags: MessageFlags.Ephemeral });
    return;
  }

  removeWatch(id, i.user.id);
  await i.reply({
    content: `Stopped watching **${existing.title}** (#${id}).`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * DM the owner; fall back to the origin guild channel *and say so*. Callers must not
 * retire a watch or mark dates announced on `"failed"` or the alert is lost forever.
 */
async function dm(w: Watch, payload: MessagePayload): Promise<DeliveryOutcome> {
  try {
    const user = await client.users.fetch(w.user_id);
    await user.send(payload as never);
    console.log(`[watch ${w.id}] delivered to user ${w.user_id} via DM`);
    return "dm";
  } catch (e) {
    console.warn(`[watch ${w.id}] DM to ${w.user_id} failed: ${(e as Error).message}`);
    try {
      const ch = await client.channels.fetch(w.channel_id);
      if (ch?.isDMBased?.()) {
        console.warn(`[watch ${w.id}] channel ${w.channel_id} is DM-based; skipping fallback`);
        return "failed";
      }
      if (ch?.isTextBased() && "send" in ch) {
        await ch.send({
          content: `<@${w.user_id}> — your DMs are closed, so this is going here instead.`,
          ...(payload as never as object),
        });
        console.log(
          `[watch ${w.id}] delivered to user ${w.user_id} via channel ${w.channel_id} (fallback)`,
        );
        return "channel_fallback";
      }
      console.error(`[watch ${w.id}] channel ${w.channel_id} is not sendable`);
    } catch (e2) {
      console.error(`[watch ${w.id}] could not deliver anywhere:`, (e2 as Error).message);
    }
    return "failed";
  }
}

function writeLivenessSnapshot(watchesCount: number, elapsedMs: number, coalesced: number): void {
  try {
    const gatewayReady = client.ws ? client.ws.status === Status.Ready : true;
    const payload = JSON.stringify({
      ok: gatewayReady,
      ts: Date.now(),
      sec: Math.round(elapsedMs / 1000),
      watches: watchesCount,
      coalesced,
      gatewayReady,
    });
    const tmp = `${LIVENESS_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, LIVENESS_PATH);
  } catch {}
}

async function heartbeatUptime(note: string, pingMs?: number): Promise<void> {
  if (!UPTIME_KUMA_PUSH_URL) return;
  try {
    const url = new URL(UPTIME_KUMA_PUSH_URL);
    const wsReady = client.ws ? client.ws.status === Status.Ready : true;
    if (!wsReady) {
      url.searchParams.set("status", "down");
      url.searchParams.set("msg", "gateway_disconnected");
    } else {
      if (!url.searchParams.has("status")) url.searchParams.set("status", "up");
      url.searchParams.set("msg", note);
      if (pingMs != null) url.searchParams.set("ping", String(Math.max(0, Math.round(pingMs))));
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel().catch(() => {});
    if (!res.ok) console.warn(`[uptime] push HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[uptime] push failed: ${(e as Error).message}`);
  }
}

let shuttingDown = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let activePoll: Promise<void> | null = null;

async function poll(): Promise<void> {
  const watches = allWatches();
  const started = Date.now();
  if (!watches.length) {
    writeLivenessSnapshot(0, 0, 0);
    await heartbeatUptime("idle");
    return;
  }
  beginCycle();
  for (const w of watches) {
    if (shuttingDown) break;
    try {
      if (!(await expireStale(w, dm))) {
        await checkWatch(w, dm);
      }
    } catch (e) {
      console.error(`[watch ${w.id}] poll failed:`, e);
    }
    if (shuttingDown) break;
    await Bun.sleep(staggerDelayMs(STAGGER));
  }
  if (shuttingDown) return;
  const elapsed = Date.now() - started;
  const saved = coalescedCount();
  console.log(
    `[poll] ${watches.length} watch(es) in ${Math.round(elapsed / 1000)}s` +
      (saved ? ` · ${saved} request(s) saved by coalescing` : ""),
  );
  writeLivenessSnapshot(watches.length, elapsed, saved);
  await heartbeatUptime(`${watches.length} watches`, elapsed);
}

client.on(Events.InteractionCreate, async (i) => {
  if (i.isAutocomplete()) {
    const context = i.commandName === "stop" ? { watches: listWatches(i.user.id) } : undefined;
    return void i
      .respond(commandSuggestions(i.commandName, i.options.getFocused(true), context))
      .catch(() => {});
  }
  if (i.isButton()) {
    if (!i.customId.startsWith(msg.STOP_BUTTON_PREFIX)) return;
    try {
      await handleStopButton(i);
    } catch (e) {
      console.error("button interaction failed:", e);
    }
    return;
  }
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === "help") {
      await i.reply({
        ...msg.help({
          everyMin: Math.max(1, Math.round(POLL_MS / 60000)),
          maxWatches: MAX_WATCHES_PER_USER,
        }),
        flags: MessageFlags.Ephemeral,
      });
    } else if (i.commandName === "watch") {
      await cmdWatch(i);
    } else if (i.commandName === "list") {
      await cmdList(i);
    } else if (i.commandName === "stop") {
      await cmdStop(i);
    }
  } catch (e) {
    console.error("command failed:", e);
    const errPayload = {
      content: `Something broke: \`${(e as Error).message}\``,
      flags: MessageFlags.Ephemeral,
    } as const;
    await (i.deferred || i.replied ? i.editReply(errPayload.content) : i.reply(errPayload)).catch(
      () => {},
    );
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`SeatSniper online as ${c.user.tag}`);
  const tick = async () => {
    if (shuttingDown) return;
    const run = poll().catch((e) => console.error(e));
    activePoll = run;
    await run;
    activePoll = null;
    if (!shuttingDown) {
      pollTimer = setTimeout(() => void tick(), POLL_MS);
    }
  };
  void tick();
});

await initProviders();
await client.login(TOKEN);

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  if (activePoll) {
    await Promise.race([activePoll, Bun.sleep(10_000)]);
  }
  await closeProviders();
  await Promise.race([client.destroy(), Bun.sleep(3_000)]);
  closeDb();
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void shutdown());
}
