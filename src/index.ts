/** SeatSniper — paste a BookMyShow link, get a DM when that date opens. */
import { Client, GatewayIntentBits, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import * as msg from "./messages.ts";
import {
  initBms, closeBms, fetchShowtimes, fetchShowtimesCached, fetchBookableDates, bookableDatesCached, beginCycle,
  coalescedCount, parseWatchUrl, showsOnDate, showtimesUrl, prettyDate, BmsError, PROBE_DATE,
  type FormatChip, type Show, type Target,
} from "./bms.ts";
import {
  addWatch, listWatches, allWatches, countWatches, removeWatch, markOk, markFail,
  seenDates, recordSeenDates, seenVenues, recordSeenVenues, shouldSilentSeedVenues,
  isSubscription, SUBSCRIPTION, MAX_WATCHES_PER_USER, type Watch,
} from "./db.ts";
import { parseTimeFilter, matchesTimeFilter } from "./time-filter.ts";
import {
  FORMAT_CHOICES, DAY_CHOICES, normaliseFormats, normaliseDays, matchesFormat,
  matchesDay, matchesTheatre, normaliseTheatres, filterSummary,
} from "./filters.ts";
import { staggerBounds, staggerDelayMs } from "./stagger.ts";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error("DISCORD_TOKEN missing — copy .env.example to .env");

const POLL_MS = Number(process.env.POLL_INTERVAL_SEC ?? 600) * 1000;

const STAGGER = staggerBounds();

/** Optional Uptime Kuma Push URL. Bot pings it after each poll so Kuma can alert if we die. */
const UPTIME_KUMA_PUSH_URL = process.env.UPTIME_KUMA_PUSH_URL?.trim() || "";


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

// ---------------------------------------------------------------- child format events
//
// The buytickets page carries format-selector chips that map format names to
// SEPARATE child event codes — ScreenX/IMAX/4DX showtimes live under those child
// events, not under the parent event's `attributes`. A filtered watch must check
// the parent AND every matching child event before deciding a date has shows.

type MovieRef = Pick<Watch, "city" | "slug" | "event_code">;

function chipTarget(chip: FormatChip, city: string, date: string): Target {
  return { city, slug: chip.slug, eventCode: chip.eventCode, date };
}

/** Distinct matching formats, in first-seen order. */
function collectFormats(shows: Show[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of shows) {
    if (s.attributes && !seen.has(s.attributes)) {
      seen.add(s.attributes);
      out.push(s.attributes);
    }
  }
  return out;
}

/**
 * All shows on `date` (parent event + matching child format events) that satisfy
 * the filter. Child checks are best-effort: a failing child event must not sink
 * the parent's answer, and it retries next poll.
 */
async function matchingShows(
  movie: MovieRef,
  date: string,
  filter: string,
  chips: FormatChip[],
): Promise<{ shows: Show[]; formats: string[] }> {
  const parent = { city: movie.city, slug: movie.slug, eventCode: movie.event_code, date };
  const shows = showsOnDate((await fetchShowtimesCached(parent)).shows, date)
    .filter((s) => matchesFormat(s.attributes, filter));

  for (const chip of chipsMatchingFilter(chips, filter)) {
    try {
      const child = showsOnDate((await fetchShowtimesCached(chipTarget(chip, movie.city, date))).shows, date)
        .filter((s) => matchesFormat(s.attributes, filter));
      shows.push(...child);
    } catch (e) {
      console.error(`[${movie.event_code}] ${chip.title} check failed for ${date}:`, (e as Error).message);
    }
  }
  return { shows, formats: collectFormats(shows) };
}

/** The format-selector chips (child events) whose title matches the filter. */
function chipsMatchingFilter(chips: FormatChip[], filter: string): FormatChip[] {
  return chips.filter((c) => matchesFormat(c.title, filter));
}

// ---------------------------------------------------------------- commands

async function cmdWatch(i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  let target;
  const formatFilter = normaliseFormats(i.options.getString("format"));
  const dayFilter = normaliseDays(i.options.getString("days"));

  // Reject an unparseable time instead of silently dropping the filter: a watch that
  // quietly ignores "after 18:00" fires at 10am and looks broken.
  const afterRaw = i.options.getString("after")?.trim() || null;
  const beforeRaw = i.options.getString("before")?.trim() || null;
  const afterMinutes = afterRaw === null ? null : parseTimeFilter(afterRaw);
  const beforeMinutes = beforeRaw === null ? null : parseTimeFilter(beforeRaw);
  if (afterRaw !== null && afterMinutes === null) {
    return void i.editReply(`❌ I couldn't read \`after: ${afterRaw}\` as a time. Use 24-hour \`18:00\` or \`6:00 PM\`.`);
  }
  if (beforeRaw !== null && beforeMinutes === null) {
    return void i.editReply(`❌ I couldn't read \`before: ${beforeRaw}\` as a time. Use 24-hour \`12:00\` or \`11:30 AM\`.`);
  }
  // An empty window can never match, so say so now rather than watching forever in silence.
  if (afterMinutes !== null && beforeMinutes !== null && afterMinutes >= beforeMinutes) {
    return void i.editReply(
      `❌ \`after: ${afterRaw}\` is not before \`before: ${beforeRaw}\`, so no show could ever match. ` +
        "The window does not wrap past midnight.",
    );
  }
  const afterFilter = afterRaw;
  const beforeFilter = beforeRaw;

  const theatreFilter = normaliseTheatres(i.options.getString("theatre"));
  try {
    const parsed = parseWatchUrl(i.options.getString("link", true));
    const dateOpt = i.options.getString("date")?.trim();
    // "any" (or a link with no date and no date option) subscribes to the movie:
    // ping me every time a NEW date unlocks, rather than watching one date.
    const wantsAny = dateOpt ? /^(any|all|every|new)$/i.test(dateOpt) : !parsed.date;
    if (wantsAny) return void (await subscribeToMovie(i, parsed, formatFilter, dayFilter, afterFilter, beforeFilter, theatreFilter));

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
    format_filter: formatFilter, day_filter: dayFilter,
    after_filter: afterFilter, before_filter: beforeFilter, theatre_filter: theatreFilter,
  });
  if (id === null) return void i.editReply("You're already watching that movie and date. `/list` to see it.");

  await i.editReply(
    msg.armedForDate({ title, city: target.city, date: target.date, everyMin: POLL_MS / 60000, filters: filterSummary({ format_filter: formatFilter, day_filter: dayFilter, after_filter: afterFilter, before_filter: beforeFilter, theatre_filter: theatreFilter }) }),
  );
}

/**
 * Subscribe to a movie rather than a single date. Whatever is bookable right now
 * becomes the baseline — the user already knows about those — and every date that
 * appears afterwards gets a DM. With a format filter, only dates that currently
 * have matching shows are baselined; the rest stay armed so they fire the day a
 * matching show appears on them.
 */
async function subscribeToMovie(
  i: ChatInputCommandInteraction,
  parsed: { city: string; slug: string; eventCode: string },
  formatFilter: string | null,
  dayFilter: string | null,
  afterFilter: string | null,
  beforeFilter: string | null,
  theatreFilter: string | null,
) {
  if (countWatches(i.user.id) >= MAX_WATCHES_PER_USER) {
    return void i.editReply(`You're at ${MAX_WATCHES_PER_USER} watches. \`/stop\` one first.`);
  }

  let title, dates, venues, chips;
  try {
    ({ title, dates, venues, chips } = await fetchBookableDates(parsed));
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

  // With a format filter, baseline only the dates that already have matching shows
  // (parent or child format event). Dates without them must stay unseeded so a
  // later unlock still fires. Validation hits are per-date and fresh — never served
  // from the poll cycle cache.
  let baseline: string[] = dates;
  let matchingNow: string[] = [];
  if (formatFilter) {
    const matched: string[] = [];
    for (const d of dates) {
      const target = { city: parsed.city, slug: parsed.slug, eventCode: parsed.eventCode, date: d };
      try {
        const shows = showsOnDate((await fetchShowtimes(target)).shows, d)
          .filter((s) => matchesFormat(s.attributes, formatFilter!));
        for (const chip of chipsMatchingFilter(chips, formatFilter)) {
          const child = showsOnDate((await fetchShowtimes(chipTarget(chip, parsed.city, d))).shows, d)
            .filter((s) => matchesFormat(s.attributes, formatFilter!));
          shows.push(...child);
        }
        if (shows.length) matched.push(d);
      } catch (e) {
        // Uncheckable date at creation — treat as not-yet-matching so it stays armed.
        console.error(`[sub] format validation failed for ${d}:`, (e as Error).message);
      }
    }
    baseline = matched;
    matchingNow = matched;
  }

  const id = addWatch({
    user_id: i.user.id, channel_id: i.channelId, city: parsed.city, slug: parsed.slug,
    event_code: parsed.eventCode, date: SUBSCRIPTION, title,
    format_filter: formatFilter, day_filter: dayFilter,
    after_filter: afterFilter, before_filter: beforeFilter, theatre_filter: theatreFilter,
  });
  if (id === null) return void i.editReply("You're already subscribed to that movie. `/list` to see it.");

  recordSeenDates(id, baseline); // baseline: today's matching dates are not "new"
  if (venues) recordSeenVenues(id, venues.map((v) => v.code));

  await i.editReply(
    msg.armedForMovie({
      title, city: parsed.city, openNow: formatFilter ? matchingNow : dates, everyMin: POLL_MS / 60000,
      filters: filterSummary({ format_filter: formatFilter, day_filter: dayFilter, after_filter: afterFilter, before_filter: beforeFilter, theatre_filter: theatreFilter }),
      warning:
        formatFilter && !matchingNow.length
          ? `_No ${formatFilter} shows exist for this movie right now — I'll ping you the moment one appears._`
          : null,
    }),
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
  let chips: FormatChip[] = [];
  try {
    ({ dates, venues, chips } = await bookableDatesCached({
      city: w.city, slug: w.slug, eventCode: w.event_code,
    }));
  } catch (e) {
    markFail(w.id, (e as Error).message);
    if (w.fail_count + 1 === 3) await dm(w, failEmbed(w, e as Error));
    return;
  }
  markOk(w.id);

  // null venues = parse failed; skip cinema diff (don't treat as "no cinemas").
  //
  // NOTE: fresh venues are diffed by venue code only — format_filter and day_filter are
  // NOT applied here, unlike the freshDates path below. A new cinema listing the film in
  // any format still alerts, and the DM's filter line reflects the watch's filters rather
  // than a format checked for the cinema. Documented in the README Commands section.
  // Filtering this half needs showtimes-or-attributes per venue plus careful coalescing,
  // so it is a deliberate gap rather than an oversight (see issue #21).
  //
  // theatre_filter IS applied here: the venue's name and code are already in hand, so
  // it costs no extra request and needs none of the coalescing above.
  let freshVenues: { code: string; name: string }[] = [];
  if (venues) {
    if (shouldSilentSeedVenues(w.id)) {
      recordSeenVenues(w.id, venues.map((v) => v.code));
    } else {
      const known = new Set(seenVenues(w.id));
      freshVenues = venues.filter((v) => !known.has(v.code));
      if (w.theatre_filter) freshVenues = freshVenues.filter((v) => matchesTheatre(v.name, v.code, w.theatre_filter!));
    }
  }

  const knownDates = new Set(seenDates(w.id));
  let freshDates = dates.filter((d) => !knownDates.has(d));

  // Apply day filter to fresh dates before announcing.
  if (w.day_filter) freshDates = freshDates.filter((d) => matchesDay(d, w.day_filter!));

  // Format, time-of-day and theatre filters: only announce dates that actually have a
  // matching show — on the parent event OR a matching child format event (ScreenX etc.).
  // Costs an extra fetchShowtimes per fresh date — spent only when one of those filters
  // is set, and coalesced so N watches on the same movie share the request. A date alone
  // says nothing about start times or venues, so all three share a single pass.
  let matchedFormats: string[] = [];
  const afterMinutes = w.after_filter ? parseTimeFilter(w.after_filter) : null;
  const beforeMinutes = w.before_filter ? parseTimeFilter(w.before_filter) : null;
  const needsShowtimes = Boolean(w.format_filter) || Boolean(w.theatre_filter) || afterMinutes !== null || beforeMinutes !== null;
  if (needsShowtimes && freshDates.length) {
    const kept: string[] = [];
    for (const d of freshDates) {
      try {
        let shows: Show[];
        if (w.format_filter) {
          shows = (await matchingShows(w, d, w.format_filter, chips)).shows;
        } else {
          shows = showsOnDate((await fetchShowtimesCached({ city: w.city, slug: w.slug, eventCode: w.event_code, date: d })).shows, d);
        }
        const hits = shows.filter(
          (sh) =>
            (!w.theatre_filter || matchesTheatre(sh.venueName, sh.venueCode, w.theatre_filter)) &&
            matchesTimeFilter(sh.epoch, afterMinutes, beforeMinutes),
        );
        if (hits.length) {
          kept.push(d);
          if (w.format_filter) {
            for (const h of hits) if (h.attributes && !matchedFormats.includes(h.attributes)) matchedFormats.push(h.attributes);
          }
        } else if (w.format_filter) {
          console.log(`[watch ${w.id}] ${d} filtered out: no ${w.format_filter} shows`);
        }
      } catch (e) {
        // Uncheckable date — log it and retry next poll rather than silently skipping.
        console.error(`[watch ${w.id}] format check failed for ${d}:`, (e as Error).message);
      }
    }
    freshDates = kept;
  }

  if (!freshDates.length && !freshVenues.length) return;

  const url = showtimesUrl({
    city: w.city,
    slug: w.slug,
    eventCode: w.event_code,
    date: freshDates[0] ?? dates[0] ?? PROBE_DATE,
  });

  // Only mark these announced once they actually reached the user. Recording first
  // would lose the alert permanently if delivery failed.
  const outcome = await dm(w, msg.subscriptionAlert({
    title: w.title, city: w.city, dates: freshDates, venues: freshVenues, url,
    filters: filterSummary(w), matchedFormats,
  }));
  if (outcome !== "failed") {
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
  let chips: FormatChip[] = [];
  try {
    // Ask the shared, coalesced question first: which dates are bookable at all?
    // Verified equivalent to matching showDateCode (checked across 3 films x 8 days),
    // and it lets every watch on this movie share one request regardless of date.
    const res = await bookableDatesCached(target);
    chips = res.chips;
    if (!res.dates.includes(w.date)) {
      markOk(w.id);
      return;
    }
    // It's open — only now spend a second request to get the actual showtimes.
    open = showsOnDate((await fetchShowtimesCached(target)).shows, w.date);
  } catch (e) {
    markFail(w.id, (e as Error).message);
    // One warning at exactly 3 consecutive failures: enough to rule out a blip,
    // and never repeated so a persistent outage can't spam the user.
    if (w.fail_count + 1 === 3) await dm(w, failEmbed(w, e as Error));
    return;
  }
  markOk(w.id);
  if (!open.length) return;

  // Apply user filters: only fire if shows match the requested format/day.
  // Format matching consults child events first, then day/time/theatre so a
  // ScreenX hit cannot overwrite an earlier day constraint.
  let filtered = open;
  let matchedFormats: string[] = [];
  if (w.format_filter) {
    // Filtered one-shots must also consult matching child format events —
    // ScreenX shows live under a child event, so the parent's shows alone lie.
    const { shows, formats } = await matchingShows(w, w.date, w.format_filter, chips);
    filtered = shows;
    matchedFormats = formats;
  }
  if (w.day_filter) filtered = filtered.filter((s) => matchesDay(s.showDateCode, w.day_filter!));
  if (w.after_filter || w.before_filter) {
    filtered = filtered.filter((s) =>
      matchesTimeFilter(s.epoch, parseTimeFilter(w.after_filter ?? ""), parseTimeFilter(w.before_filter ?? "")));
  }
  if (w.theatre_filter) filtered = filtered.filter((s) => matchesTheatre(s.venueName, s.venueCode, w.theatre_filter!));
  if (!filtered.length) return; // shows exist but none match — stay silent, keep watching

  // Same rule: a watch is only "done its job" once the user was actually told.
  const outcome = await dm(w, msg.ticketsLive({
    title: w.title, city: w.city, date: w.date, shows: filtered, url: showtimesUrl(target),
    filters: filterSummary(w), matchedFormats,
  }));
  if (outcome !== "failed") removeWatch(w.id, w.user_id);
  else console.error(`[watch ${w.id}] undelivered, keeping watch alive to retry`);
}

const failEmbed = (w: Watch, e: Error) => msg.cannotRead({ title: w.title, error: e.message });

/** Where a notification actually landed. */
type DeliveryOutcome = "dm" | "channel_fallback" | "failed";

/**
 * DM the owner; fall back to the origin channel *and say so*. Never silent.
 * Returns where the message landed — callers must not retire a watch or mark a
 * date as announced unless it was "dm" or "channel_fallback", or the alert is
 * lost forever. Logs every delivery so "who got what" is answerable from the log.
 */
async function dm(w: Watch, payload: { embeds: unknown[]; components?: unknown[] }): Promise<DeliveryOutcome> {
  try {
    const user = await client.users.fetch(w.user_id);
    await user.send(payload as never);
    console.log(`[watch ${w.id}] delivered to user ${w.user_id} via DM`);
    return "dm";
  } catch (e) {
    console.warn(`[watch ${w.id}] DM to ${w.user_id} failed: ${(e as Error).message}`);
    try {
      const ch = await client.channels.fetch(w.channel_id);
      if (ch?.isTextBased() && "send" in ch) {
        await ch.send({
          content: `<@${w.user_id}> — your DMs are closed, so this is going here instead.`,
          ...(payload as never as object),
        });
        console.log(`[watch ${w.id}] delivered to user ${w.user_id} via channel ${w.channel_id} (fallback)`);
        return "channel_fallback";
      }
      console.error(`[watch ${w.id}] channel ${w.channel_id} is not sendable`);
    } catch (e2) {
      console.error(`[watch ${w.id}] could not deliver anywhere:`, (e2 as Error).message);
    }
    return "failed";
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

/**
 * Tell Uptime Kuma we're still alive. Fire-and-forget — a dead Pi must not
 * break the poll loop. Only called after a poll tick finishes so a hung bot
 * stops heartbeating and Kuma goes red.
 */
async function heartbeatUptime(note: string, pingMs?: number): Promise<void> {
  if (!UPTIME_KUMA_PUSH_URL) return;
  try {
    const url = new URL(UPTIME_KUMA_PUSH_URL);
    if (!url.searchParams.has("status")) url.searchParams.set("status", "up");
    url.searchParams.set("msg", note);
    if (pingMs != null) url.searchParams.set("ping", String(Math.max(0, Math.round(pingMs))));
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.warn(`[uptime] push HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[uptime] push failed: ${(e as Error).message}`);
  }
}

async function poll() {
  const watches = allWatches();
  const started = Date.now();
  if (!watches.length) {
    // Still heartbeat when idle — empty watch list is not "bot is dead".
    await heartbeatUptime("idle");
    return;
  }
  beginCycle(); // fresh coalescing map; never serves an answer across polls
  for (const w of watches) {
    try {
      if (!(await expireStale(w))) {
        await checkWatch(w);
      }
    } catch (e) {
      // A watch can disappear while a poll is in flight. One stale snapshot must
      // not abort the rest of the cycle. Reachable since PRAGMA foreign_keys=ON:
      // a /stop between the allWatches() snapshot and a ledger write now throws
      // FOREIGN KEY constraint failed where it used to insert an orphan row.
      // Log the raw value, not `(e as Error).message`. The cast is compile-time only, so a
      // thrown null or undefined would make the handler itself throw and abort the cycle,
      // which is the exact failure this guard exists to prevent.
      console.error(`[watch ${w.id}] poll failed:`, e);
    }
    // Stagger so we never burst. Cheap insurance against looking automated.
    // Tunable via STAGGER_MS_MIN / STAGGER_MS_MAX; defaults are the previous 2000-5000ms.
    await Bun.sleep(staggerDelayMs(STAGGER));
  }
  const elapsed = Date.now() - started;
  const saved = coalescedCount();
  console.log(
    `[poll] ${watches.length} watch(es) in ${Math.round(elapsed / 1000)}s` +
      (saved ? ` · ${saved} request(s) saved by coalescing` : ""),
  );
  await heartbeatUptime(`${watches.length} watches`, elapsed);
}

// ---------------------------------------------------------------- wire-up

client.on("interactionCreate", async (i) => {
  // Autocomplete for /watch format + days options.
  if (i.isAutocomplete()) {
    const focused = i.options.getFocused(true);
    const val = focused.value.toLowerCase();
    const choices = focused.name === "format" ? FORMAT_CHOICES : DAY_CHOICES;
    const matches = choices
      .filter((c) => c.toLowerCase().includes(val))
      .slice(0, 25)
      .map((c) => ({ name: c, value: c }));
    return void i.respond(matches).catch(() => {});
  }
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
