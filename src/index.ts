/** SeatSniper — paste a BookMyShow link, get a DM when that date opens. */
import { Client, GatewayIntentBits, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import * as msg from "./messages.ts";
import {
  initBms, closeBms, fetchShowtimes, fetchBookableDates, bookableDatesCached, beginCycle,
  coalescedCount, parseWatchUrl, showsOnDate, showtimesUrl, prettyDate, BmsError, PROBE_DATE,
} from "./bms.ts";
import {
  addWatch, listWatches, allWatches, countWatches, removeWatch, markOk, markFail,
  seenDates, recordSeenDates, seenVenues, recordSeenVenues, shouldSilentSeedVenues,
  isSubscription, SUBSCRIPTION, MAX_WATCHES_PER_USER, type Watch,
} from "./db.ts";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error("DISCORD_TOKEN missing — copy .env.example to .env");

const POLL_MS = Number(process.env.POLL_INTERVAL_SEC ?? 600) * 1000;


/** "2026-07-30" | "20260730" -> "20260730". Throws on anything else. */
function normaliseDate(input: string): string {
  const d = input.trim().replace(/[-/]/g, "");
  if (!/^\d{8}$/.test(d)) throw new BmsError("bad_url", `Date must look like 2026-07-30, got "${input}"`);
  const [y, m, day] = [+d.slice(0, 4), +d.slice(4, 6), +d.slice(6, 8)];
  if (m < 1 || m > 12 || day < 1 || day > 31) {
    throw new BmsError("bad_url", `"${input}" isn't a real date.`);
  }
  return d;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------------------------------------------------------------- commands

async function cmdWatch(i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  let target;
  try {
    const parsed = parseWatchUrl(i.options.getString("link", true));
    const dateOpt = i.options.getString("date")?.trim();
    // "any" (or a link with no date and no date option) subscribes to the movie:
    // ping me every time a NEW date unlocks, rather than watching one date.
    const wantsAny = dateOpt ? /^(any|all|every|new)$/i.test(dateOpt) : !parsed.date;
    if (wantsAny) return void (await subscribeToMovie(i, parsed));

    const date = dateOpt ? normaliseDate(dateOpt) : parsed.date!;
    if (date < todayIST()) {
      return void i.editReply(
        `❌ ${prettyDate(date)} has already passed — a watch for it could never fire.`,
      );
    }
    target = { city: parsed.city, slug: parsed.slug, eventCode: parsed.eventCode, date };
  } catch (e) {
    return void i.editReply(`❌ ${(e as Error).message}`);
  }

  if (countWatches(i.user.id) >= MAX_WATCHES_PER_USER) {
    return void i.editReply(`You're at ${MAX_WATCHES_PER_USER} watches. \`/stop\` one first.`);
  }

  // Validate against the live site now, so a broken watch fails here rather than
  // silently never firing. Costs one request; saves days of false silence.
  let open, title;
  try {
    const res = await fetchShowtimes(target);
    title = res.title; // BookMyShow's own name for it, not a guess from the slug
    open = showsOnDate(res.shows, target.date);
  } catch (e) {
    const err = e as BmsError;
    if (err.kind === "not_found") {
      return void i.editReply(
        `❌ No movie found for \`${target.eventCode}\` in ${target.city}. ` +
          "Check the link — the city and the event code have to match.",
      );
    }
    return void i.editReply(
      `⚠️ Can't reach BookMyShow right now, so I won't save a watch I can't check.\n\`${err.message}\``,
    );
  }

  if (open.length) {
    return void i.editReply(
      msg.alreadyOnSale({ title, city: target.city, date: target.date, shows: open, url: showtimesUrl(target) }),
    );
  }

  const id = addWatch({
    user_id: i.user.id, channel_id: i.channelId, city: target.city, slug: target.slug,
    event_code: target.eventCode, date: target.date, title,
  });
  if (id === null) return void i.editReply("You're already watching that movie and date. `/list` to see it.");

  await i.editReply(
    msg.armedForDate({ title, city: target.city, date: target.date, everyMin: POLL_MS / 60000 }),
  );
}

/**
 * Subscribe to a movie rather than a single date. Whatever is bookable right now
 * becomes the baseline — the user already knows about those — and every date that
 * appears afterwards gets a DM.
 */
async function subscribeToMovie(
  i: ChatInputCommandInteraction,
  parsed: { city: string; slug: string; eventCode: string },
) {
  if (countWatches(i.user.id) >= MAX_WATCHES_PER_USER) {
    return void i.editReply(`You're at ${MAX_WATCHES_PER_USER} watches. \`/stop\` one first.`);
  }

  let title, dates, venues;
  try {
    ({ title, dates, venues } = await fetchBookableDates(parsed));
  } catch (e) {
    const err = e as BmsError;
    if (err.kind === "not_found") {
      return void i.editReply(
        `❌ No movie found for \`${parsed.eventCode}\` in ${parsed.city}. Check the link.`,
      );
    }
    return void i.editReply(
      `⚠️ Can't reach BookMyShow right now, so I won't save a watch I can't check.\n\`${err.message}\``,
    );
  }

  const id = addWatch({
    user_id: i.user.id, channel_id: i.channelId, city: parsed.city, slug: parsed.slug,
    event_code: parsed.eventCode, date: SUBSCRIPTION, title,
  });
  if (id === null) return void i.editReply("You're already subscribed to that movie. `/list` to see it.");

  recordSeenDates(id, dates); // baseline: today's open dates are not "new"
  if (venues) recordSeenVenues(id, venues.map((v) => v.code));

  await i.editReply(
    msg.armedForMovie({ title, city: parsed.city, openNow: dates, everyMin: POLL_MS / 60000 }),
  );
}

async function cmdList(i: ChatInputCommandInteraction) {
  const rows = listWatches(i.user.id);
  if (!rows.length) {
    return void i.reply({
      content: "Nothing being watched yet. `/help` shows how to start one.",
      flags: MessageFlags.Ephemeral,
    });
  }
  await i.reply({ ...msg.watchList(rows), flags: MessageFlags.Ephemeral });
}

async function cmdStop(i: ChatInputCommandInteraction) {
  const id = i.options.getInteger("id", true);
  const ok = removeWatch(id, i.user.id);
  await i.reply({
    content: ok ? `Stopped watch #${id}.` : `No watch #${id} of yours.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ---------------------------------------------------------------- poller

/** Subscription poll: announce dates and cinemas that weren't bookable last time we looked. */
async function checkSubscription(w: Watch) {
  let dates: string[];
  let venues: { code: string; name: string }[] | null;
  try {
    ({ dates, venues } = await bookableDatesCached({
      city: w.city, slug: w.slug, eventCode: w.event_code,
    }));
  } catch (e) {
    markFail(w.id, (e as Error).message);
    if (w.fail_count + 1 === 3) await dm(w, failEmbed(w, e as Error));
    return;
  }
  markOk(w.id);

  // null venues = parse failed; skip cinema diff (don't treat as "no cinemas").
  let freshVenues: { code: string; name: string }[] = [];
  if (venues) {
    if (shouldSilentSeedVenues(w.id)) {
      recordSeenVenues(w.id, venues.map((v) => v.code));
    } else {
      const known = new Set(seenVenues(w.id));
      freshVenues = venues.filter((v) => !known.has(v.code));
    }
  }

  const knownDates = new Set(seenDates(w.id));
  const freshDates = dates.filter((d) => !knownDates.has(d));
  if (!freshDates.length && !freshVenues.length) return;

  const url = showtimesUrl({
    city: w.city,
    slug: w.slug,
    eventCode: w.event_code,
    date: freshDates[0] ?? dates[0] ?? PROBE_DATE,
  });

  // Only mark these announced once they actually reached the user. Recording first
  // would lose the alert permanently if delivery failed.
  if (await dm(w, msg.subscriptionAlert({
    title: w.title, city: w.city, dates: freshDates, venues: freshVenues, url,
  }))) {
    if (freshDates.length) recordSeenDates(w.id, freshDates);
    if (freshVenues.length) recordSeenVenues(w.id, freshVenues.map((v) => v.code));
  } else {
    console.error(`[watch ${w.id}] undelivered, will retry`);
  }
}

async function checkWatch(w: Watch) {
  if (isSubscription(w)) return void (await checkSubscription(w));
  const target = { city: w.city, slug: w.slug, eventCode: w.event_code, date: w.date };
  let open;
  try {
    // Ask the shared, coalesced question first: which dates are bookable at all?
    // Verified equivalent to matching showDateCode (checked across 3 films x 8 days),
    // and it lets every watch on this movie share one request regardless of date.
    const { dates } = await bookableDatesCached(target);
    if (!dates.includes(w.date)) {
      markOk(w.id);
      return;
    }
    // It's open — only now spend a second request to get the actual showtimes.
    open = showsOnDate((await fetchShowtimes(target)).shows, w.date);
  } catch (e) {
    markFail(w.id, (e as Error).message);
    // One warning at exactly 3 consecutive failures: enough to rule out a blip,
    // and never repeated so a persistent outage can't spam the user.
    if (w.fail_count + 1 === 3) await dm(w, failEmbed(w, e as Error));
    return;
  }
  markOk(w.id);
  if (!open.length) return;

  // Same rule: a watch is only "done its job" once the user was actually told.
  const delivered = await dm(w, msg.ticketsLive({
    title: w.title, city: w.city, date: w.date, shows: open, url: showtimesUrl(target),
  }));
  if (delivered) removeWatch(w.id, w.user_id);
  else console.error(`[watch ${w.id}] undelivered, keeping watch alive to retry`);
}

const failEmbed = (w: Watch, e: Error) => msg.cannotRead({ title: w.title, error: e.message });

/**
 * DM the owner; fall back to the origin channel *and say so*. Never silent.
 * Returns whether the message actually reached the user — callers must not retire
 * a watch or mark a date as announced unless it did, or the alert is lost forever.
 */
async function dm(w: Watch, payload: { embeds: unknown[]; components?: unknown[] }): Promise<boolean> {
  try {
    const user = await client.users.fetch(w.user_id);
    await user.send(payload as never);
    return true;
  } catch {
    try {
      const ch = await client.channels.fetch(w.channel_id);
      if (ch?.isTextBased() && "send" in ch) {
        await ch.send({
          content: `<@${w.user_id}> — your DMs are closed, so this is going here instead.`,
          ...(payload as never as object),
        });
        return true;
      }
      console.error(`[watch ${w.id}] channel ${w.channel_id} is not sendable`);
    } catch (e) {
      console.error(`[watch ${w.id}] could not deliver anywhere:`, (e as Error).message);
    }
    return false;
  }
}

/** YYYYMMDD for today in IST — BookMyShow's dates are Indian local dates. */
function todayIST(): string {
  const ist = new Date(Date.now() + 5.5 * 3600_000); // UTC+5:30, no DST in India
  return ist.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * A watch whose date has passed can never fire — BookMyShow stops listing the date
 * entirely and silently serves the next bookable one, so the watch would poll
 * forever finding nothing. Retire it and say so, rather than leaving it to rot.
 */
async function expireStale(w: Watch): Promise<boolean> {
  if (isSubscription(w) || w.date >= todayIST()) return false;
  await dm(w, msg.watchExpired({ title: w.title, date: w.date }));
  removeWatch(w.id, w.user_id);
  console.log(`[poll] expired watch ${w.id} (${w.date} < ${todayIST()})`);
  return true;
}

async function poll() {
  const watches = allWatches();
  if (!watches.length) return;
  beginCycle(); // fresh coalescing map; never serves an answer across polls
  const started = Date.now();
  for (const w of watches) {
    if (await expireStale(w)) continue;
    await checkWatch(w);
    // Stagger so we never burst. Cheap insurance against looking automated.
    await Bun.sleep(2000 + Math.random() * 3000);
  }
  const saved = coalescedCount();
  console.log(
    `[poll] ${watches.length} watch(es) in ${Math.round((Date.now() - started) / 1000)}s` +
      (saved ? ` · ${saved} request(s) saved by coalescing` : ""),
  );
}

// ---------------------------------------------------------------- wire-up

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === "help") await i.reply({ ...msg.help(), flags: MessageFlags.Ephemeral });
    else if (i.commandName === "watch") await cmdWatch(i);
    else if (i.commandName === "list") await cmdList(i);
    else if (i.commandName === "stop") await cmdStop(i);
  } catch (e) {
    console.error("command failed:", e);
    const msg = { content: `Something broke: \`${(e as Error).message}\``, flags: MessageFlags.Ephemeral } as const;
    await (i.deferred || i.replied ? i.editReply(msg.content) : i.reply(msg)).catch(() => {});
  }
});

client.once("clientReady", (c) => {
  console.log(`SeatSniper online as ${c.user.tag}`);
  poll().catch(console.error);
  setInterval(() => void poll().catch(console.error), POLL_MS);
});

await initBms();
await client.login(TOKEN);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await closeBms();
    await client.destroy();
    process.exit(0);
  });
}
