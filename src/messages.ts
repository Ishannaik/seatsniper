/**
 * Everything SeatSniper says, in one place.
 *
 * MESSAGE PLAN
 * ------------
 * Bot        A ticket-drop sniper. It waits silently, then says one useful thing.
 * Reader     In a DM, and they asked for exactly this. Context can be assumed;
 *            nothing needs re-explaining, and nothing needs selling.
 * Voice      Terse, factual, no hype. It reports; it doesn't celebrate.
 *
 * Accent semantics — each colour means one thing, always:
 *   LIVE    green   a date is bookable right now. The payoff. Nothing else is green.
 *   ARMED   slate   watching / subscribed. Not news yet, so it stays quiet.
 *   ALARM   red     SeatSniper itself is broken. The brand colour as the alarm.
 *   RETIRED faint   a watch ended. Informational, lowest volume.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import {
  collectFormats,
  formatCity,
  hasExactSeatCounts,
  isShowFillingFast,
  type Show,
} from "./movie-model.ts";
import { formatTimeWindow, prettyDate } from "./time-filter.ts";

export const LIVE = 0x2ecc71;
export const ARMED = 0x4a4d52;
export const ALARM = 0xe01b24;
export const RETIRED = 0x8a8f98;

export const STOP_BUTTON_PREFIX = "seatsniper:stop:";
export const STOP_ALL_CUSTOM_ID = `${STOP_BUTTON_PREFIX}all`;

const ICON =
  "https://cdn.discordapp.com/app-icons/1531174105854771363/0fa8d0978bcce83b8d17b2b85ddc919c.png?size=128";

const sig = (e: EmbedBuilder, kind: string) =>
  e.setAuthor({ name: `SeatSniper · ${kind}`, iconURL: ICON });

const clamp = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

function applyPoster(e: EmbedBuilder, posterUrl?: string | null): EmbedBuilder {
  if (posterUrl?.startsWith("https://")) e.setThumbnail(posterUrl);
  return e;
}

const stopButton = (id: number, label = "Stop watch") =>
  new ButtonBuilder()
    .setCustomId(`${STOP_BUTTON_PREFIX}${id}`)
    .setLabel(clamp(label, 80))
    .setStyle(ButtonStyle.Secondary);

function armedPayload(embed: EmbedBuilder, url?: string | null, watchId?: number | null) {
  if (url) embed.setURL(url);
  if (watchId == null) return { embeds: [embed] };
  return {
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton(watchId))],
  };
}

function bookRow(url: string, watchId?: number | null): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Book now").setStyle(ButtonStyle.Link).setURL(url),
  );
  if (watchId != null) row.addComponents(stopButton(watchId, "Stop watching"));
  return row;
}

/** Session links are public District URLs; opening one does not select or hold a seat. */
function bookingActions(
  url: string,
  shows?: Show[] | null,
  watchId?: number | null,
): ActionRowBuilder<ButtonBuilder>[] {
  const byUrl = new Map<string, Show>();
  for (const s of shows ?? []) {
    if (s.bookingUrl && !byUrl.has(s.bookingUrl)) byUrl.set(s.bookingUrl, s);
  }
  const rows = [bookRow(url, watchId)];
  const unique = [...byUrl.entries()].slice(0, 5);
  if (unique.length) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        unique.map(([link, s]) =>
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setURL(link)
            .setLabel(clamp(`${s.showTime} · ${s.venueName}`, 80)),
        ),
      ),
    );
  }
  return rows;
}

function categoryDetails(shows: Show[]): string | null {
  const lines = [
    ...new Set(
      shows.flatMap((s) => {
        const exact = hasExactSeatCounts(s);
        return (s.ticketCategories ?? [])
          .filter((c) => c.available > 0)
          .map((c) => {
            const countText = exact
              ? c.totalSeats
                ? ` · ${c.available}/${c.totalSeats} available`
                : ` · ${c.available} available`
              : "";
            return `${s.venueName} · ${c.name}: ₹${c.price}/seat${countText}`;
          });
      }),
    ),
  ];
  if (!lines.length) return null;

  let text = "";
  for (const line of lines.slice(0, 6)) {
    if ((text + line).length > 850) break;
    text += `${line}\n`;
  }
  return `${text}Listed prices exclude fees. Counts can change; adjacent seats are not verified.`;
}

function formatSlot(s: Show): string {
  const badge = s.attributes ? ` \`${s.attributes}\`` : "";
  const fast = isShowFillingFast(s) ? " _(filling fast)_" : "";
  return `<t:${s.epoch}:t>${badge}${fast}`;
}

function earliestEpoch(shows: Show[]): number | null {
  let min: number | null = null;
  for (const s of shows) {
    if (s.epoch > 0 && (min === null || s.epoch < min)) min = s.epoch;
  }
  return min;
}

function timeList(shows: Show[], limit = 8): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of shows) {
    const key = `${s.epoch}|${s.attributes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length < limit) out.push(formatSlot(s));
  }
  const extra = seen.size - out.length;
  return out.join(" · ") + (extra > 0 ? ` _+${extra} more_` : "");
}

function groupedVenueBlocks(shows: Show[], timesPerVenue: number): string[] {
  const byVenue = new Map<string, { name: string; seen: Set<string>; times: string[] }>();
  for (const s of shows) {
    const key = s.venueCode || s.venueName || "Other";
    const name = s.venueName || s.venueCode || "Other";
    let venue = byVenue.get(key);
    if (!venue) {
      venue = { name, seen: new Set(), times: [] };
      byVenue.set(key, venue);
    }
    const slotKey = `${s.epoch}|${s.attributes}`;
    if (!venue.seen.has(slotKey)) {
      venue.seen.add(slotKey);
      venue.times.push(formatSlot(s));
    }
  }
  return [...byVenue.values()].map((v) => {
    const shown = v.times.slice(0, timesPerVenue);
    const extra = v.times.length - shown.length;
    return `**${v.name}**\n${shown.join(" · ")}${extra > 0 ? ` _+${extra} more_` : ""}`;
  });
}

function groupedTimeList(shows: Show[], venueLimit = 6, timesPerVenue = 4): string {
  const blocks = groupedVenueBlocks(shows, timesPerVenue);
  const kept: string[] = [];
  for (const block of blocks.slice(0, venueLimit)) {
    const next = kept.length ? `${kept.join("\n\n")}\n\n${block}` : block;
    if (next.length > 1024) break;
    kept.push(block);
  }
  while (kept.length > 0) {
    const extra = blocks.length - kept.length;
    const suffix = extra > 0 ? `\n_+${extra} more theatres_` : "";
    if (kept.join("\n\n").length + suffix.length <= 1024) {
      return `${kept.join("\n\n")}${suffix}`;
    }
    kept.pop();
  }
  return timeList(shows);
}

function theatreList(shows: Show[], limit = 6): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of shows) {
    const key = s.venueCode || s.venueName;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (out.length < limit) out.push(s.venueName || key);
  }
  const extra = seen.size - out.length;
  return out.join(" · ") + (extra > 0 ? ` _+${extra} more_` : "");
}

function venueLines(venues: { code: string; name: string }[], limit = 8): string {
  const shown = venues.slice(0, limit).map((v) => `**${v.name || v.code}**`);
  const extra = venues.length - shown.length;
  return shown.join("\n") + (extra > 0 ? `\n_+${extra} more_` : "");
}

function dateList(dates: string[], limit = 20): string {
  const shown = dates.slice(0, limit).map(prettyDate);
  const extra = dates.length - shown.length;
  return shown.join(" · ") + (extra > 0 ? ` _+${extra} more_` : "");
}

function filterNote(filters?: string | null, matchedFormats?: string[] | null): string {
  if (!filters) return "";
  const found = matchedFormats?.length ? ` (found: ${matchedFormats.join(" · ")})` : "";
  return `\n_Matching your filter: ${filters}${found}_`;
}

function appendShowFields(
  embed: EmbedBuilder,
  shows?: Show[] | null,
  includeFormats = false,
): void {
  if (!shows?.length) return;
  embed.addFields({ name: "Showtimes", value: groupedTimeList(shows) });
  if (includeFormats) {
    const fmts = collectFormats(shows);
    if (fmts.length) {
      embed.addFields({
        name: fmts.length === 1 ? "Format" : "Formats",
        value: fmts.slice(0, 6).join(" · "),
        inline: true,
      });
    }
  }
  const categories = categoryDetails(shows);
  if (categories) embed.addFields({ name: "Ticket categories", value: categories });
}

/** The payoff: this date just became bookable. */
export function ticketsLive(opts: {
  title: string;
  city: string;
  date: string;
  shows: Show[];
  url: string;
  filters?: string | null;
  matchedFormats?: string[] | null;
  posterUrl?: string | null;
}) {
  const first = earliestEpoch(opts.shows);
  const countdown = first ? ` · first show <t:${first}:R>` : "";
  const embed = applyPoster(sig(new EmbedBuilder(), "Alert"), opts.posterUrl)
    .setColor(LIVE)
    .setTitle(clamp(`${opts.title} — tickets are live`, 256))
    .setURL(opts.url)
    .setDescription(
      `${opts.shows.length} show${opts.shows.length === 1 ? "" : "s"} in ` +
        `${formatCity(opts.city)} on ${prettyDate(opts.date)}${countdown}.` +
        filterNote(opts.filters, opts.matchedFormats),
    )
    .setTimestamp();
  appendShowFields(embed, opts.shows, true);
  return { embeds: [embed], components: bookingActions(opts.url, opts.shows) };
}

/** Subscription payoff: dates that weren't on sale last time now are. */
export function newDates(opts: {
  title: string;
  city: string;
  dates: string[];
  url: string;
  filters?: string | null;
  matchedFormats?: string[] | null;
  shows?: Show[] | null;
  posterUrl?: string | null;
  watchId?: number | null;
}) {
  const n = opts.dates.length;
  const heading = n === 1 ? "a new date opened" : `${n} new dates opened`;
  const embed = applyPoster(sig(new EmbedBuilder(), "Alert"), opts.posterUrl)
    .setColor(LIVE)
    .setTitle(clamp(`${opts.title} — ${heading}`, 256))
    .setURL(opts.url)
    .setDescription(
      `${dateList(opts.dates)}\n\nNow on sale in ${formatCity(opts.city)}. ` +
        "I'll keep watching for later dates." +
        filterNote(opts.filters, opts.matchedFormats),
    )
    .setTimestamp();
  appendShowFields(embed, opts.shows);
  return { embeds: [embed], components: bookingActions(opts.url, opts.shows, opts.watchId) };
}

/** Subscription payoff: venues that weren't listing last time now are. */
export function newCinemas(opts: {
  title: string;
  city: string;
  venues: { code: string; name: string }[];
  url: string;
  filters?: string | null;
  matchedFormats?: string[] | null;
  isEvent?: boolean;
  shows?: Show[] | null;
  posterUrl?: string | null;
  watchId?: number | null;
}) {
  const nounSingular = opts.isEvent ? "new venue" : "new cinema";
  const nounPlural = opts.isEvent ? "venues" : "cinemas";
  const heading =
    opts.venues.length === 1 ? nounSingular : `${opts.venues.length} new ${nounPlural}`;
  const embed = applyPoster(sig(new EmbedBuilder(), "Alert"), opts.posterUrl)
    .setColor(LIVE)
    .setTitle(clamp(`${opts.title} — ${heading}`, 256))
    .setURL(opts.url)
    .setDescription(
      `Now listing in ${formatCity(opts.city)}:\n${venueLines(opts.venues)}\n\n` +
        "I'll keep watching for more." +
        filterNote(opts.filters, opts.matchedFormats),
    )
    .setTimestamp();
  appendShowFields(embed, opts.shows);
  return { embeds: [embed], components: bookingActions(opts.url, opts.shows, opts.watchId) };
}

export function subscriptionAlert(opts: {
  title: string;
  city: string;
  dates: string[];
  venues: { code: string; name: string }[];
  url: string;
  filters?: string | null;
  matchedFormats?: string[] | null;
  isEvent?: boolean;
  shows?: Show[] | null;
  posterUrl?: string | null;
  watchId?: number | null;
}) {
  if (opts.dates.length && opts.venues.length) {
    const noun = opts.isEvent ? "venues" : "cinemas";
    const embed = applyPoster(sig(new EmbedBuilder(), "Alert"), opts.posterUrl)
      .setColor(LIVE)
      .setTitle(clamp(`${opts.title} — new dates & ${noun}`, 256))
      .setURL(opts.url)
      .setDescription(
        `Updates in ${formatCity(opts.city)}.${filterNote(opts.filters, opts.matchedFormats)}`,
      )
      .addFields(
        { name: "New dates", value: dateList(opts.dates) },
        { name: opts.isEvent ? "New venues" : "New cinemas", value: venueLines(opts.venues) },
      )
      .setTimestamp();
    appendShowFields(embed, opts.shows);
    return { embeds: [embed], components: bookingActions(opts.url, opts.shows, opts.watchId) };
  }
  if (opts.dates.length) return newDates(opts);
  return newCinemas(opts);
}

/** Quiet confirmation. Not news yet — it must not look like an alert. */
export function armedForDate(opts: {
  title: string;
  city: string;
  date: string;
  everyMin: number;
  filters?: string | null;
  watchId?: number | null;
  url?: string | null;
  posterUrl?: string | null;
}) {
  const embed = applyPoster(sig(new EmbedBuilder(), "Watch"), opts.posterUrl)
    .setColor(ARMED)
    .setTitle(clamp(opts.title, 256))
    .setDescription(
      `Waiting for **${prettyDate(opts.date)}** in ${formatCity(opts.city)} to go on sale.\n` +
        (opts.filters ? `Only pinging for **${opts.filters}**.\n` : "") +
        `Checking every ${opts.everyMin} minutes — you'll get a DM the moment it does.`,
    )
    .setTimestamp();
  return armedPayload(embed, opts.url, opts.watchId);
}

function openDatesField(openNow: string[], totalOpenDates?: number | null) {
  if (openNow.length) {
    return {
      name: `Already on sale (${openNow.length})`,
      value: `${dateList(openNow)}\n_No ping for these._`,
    };
  }
  if (totalOpenDates && totalOpenDates > 0) {
    return {
      name: "No matching dates yet",
      value:
        `${totalOpenDates} date${totalOpenDates === 1 ? "" : "s"} on sale without your filter — ` +
        "I'll ping you when a match opens.",
    };
  }
  return { name: "Nothing on sale yet", value: "You'll hear from me when the first date opens." };
}

export function armedForMovie(opts: {
  title: string;
  city: string;
  openNow: string[];
  filters?: string | null;
  warning?: string | null;
  isEvent?: boolean;
  watchId?: number | null;
  url?: string | null;
  posterUrl?: string | null;
  totalOpenDates?: number | null;
}) {
  const venueLabel = opts.isEvent ? "venue" : "cinema";
  const embed = applyPoster(sig(new EmbedBuilder(), "Watch"), opts.posterUrl)
    .setColor(ARMED)
    .setTitle(clamp(opts.title, 256))
    .setDescription(
      `Watching every date in ${formatCity(opts.city)}. You'll get a DM when a new date or ${venueLabel} ` +
        "opens, until you stop it." +
        (opts.filters ? `\nOnly pinging for **${opts.filters}**.` : "") +
        (opts.warning ? `\n${opts.warning}` : ""),
    )
    .addFields(openDatesField(opts.openNow, opts.totalOpenDates))
    .setTimestamp();
  return armedPayload(embed, opts.url, opts.watchId);
}

/** Already bookable — so no watch was created. Say that plainly. */
export function alreadyOnSale(opts: {
  title: string;
  city: string;
  date: string;
  shows: Show[];
  url: string;
  posterUrl?: string | null;
}) {
  const fmts = collectFormats(opts.shows);
  const first = earliestEpoch(opts.shows);
  const countdown = first ? ` · first show <t:${first}:R>` : "";
  const embed = applyPoster(sig(new EmbedBuilder(), "Watch"), opts.posterUrl)
    .setColor(LIVE)
    .setTitle(clamp(`${opts.title} — already on sale`, 256))
    .setURL(opts.url)
    .setDescription(
      `${opts.shows.length} show${opts.shows.length === 1 ? "" : "s"} in ` +
        `${formatCity(opts.city)} on ${prettyDate(opts.date)}${countdown}, so there's nothing to wait for.`,
    )
    .addFields({ name: "Showtimes", value: timeList(opts.shows) })
    .setTimestamp();
  const theatres = theatreList(opts.shows);
  if (theatres) embed.addFields({ name: "Theatres", value: theatres });
  if (fmts.length) {
    embed.addFields({
      name: fmts.length === 1 ? "Format" : "Formats",
      value: fmts.slice(0, 6).join(" · "),
      inline: true,
    });
  }
  const categories = categoryDetails(opts.shows);
  if (categories) embed.addFields({ name: "Ticket categories", value: categories });
  return { embeds: [embed], components: bookingActions(opts.url, opts.shows) };
}

export function duplicateWatch(opts: {
  id: number;
  title: string;
  date: string;
  currentFilters: string | null;
  requestedFilters: string | null;
}) {
  const targetLabel = opts.date === "" ? "every new date" : prettyDate(opts.date);
  const currentNote = opts.currentFilters
    ? ` (filter: **${opts.currentFilters}**)`
    : " (no filters)";
  const diffNote =
    opts.currentFilters !== opts.requestedFilters
      ? `\nStop **#${opts.id}** below if you want to recreate it${opts.requestedFilters ? ` with **${opts.requestedFilters}**` : " without filters"}.`
      : "";
  return {
    content: `You're already watching **${opts.title}** (${targetLabel}) as **#${opts.id}**${currentNote}.${diffNote}`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton(opts.id, `Stop #${opts.id}`)),
    ],
  };
}

export function stoppedAllText(removed: number): string {
  return removed > 0
    ? `Stopped all ${removed} watch${removed === 1 ? "" : "es"}.`
    : "You have no active watches.";
}

export type WatchListRow = {
  id: number;
  title: string;
  city: string;
  date: string;
  fail_count: number;
  last_ok_at: number | null;
  format_filter?: string | null;
  day_filter?: string | null;
  after_filter?: string | null;
  before_filter?: string | null;
  theatre_filter?: string | null;
  provider?: "bms" | "district";
  seat_count?: number | null;
  seat_budget?: number | null;
  url?: string | null;
};

function watchStateText(w: WatchListRow, source: string): string {
  if (w.fail_count >= 3) {
    return w.last_ok_at
      ? `can't read ${source} · last checked <t:${w.last_ok_at}:R>`
      : `can't read ${source} · never checked`;
  }
  return w.last_ok_at ? `checked <t:${w.last_ok_at}:R>` : "not checked yet";
}

function formatWatchRow(w: WatchListRow): string {
  const source = w.provider === "district" ? "District" : "BookMyShow";
  const what = w.date === "" ? "every new date or cinema" : prettyDate(w.date);
  const heading = w.url ? `**[${w.title}](${w.url})**` : `**${w.title}**`;
  const windowText = formatTimeWindow(w.after_filter, w.before_filter);
  const filters = [w.format_filter, w.theatre_filter, w.day_filter, windowText].filter(Boolean);
  const filtLine = filters.length ? `\nFilter: ${filters.join(" · ")}` : "";
  const seats = [
    w.seat_count != null ? `${w.seat_count} seats in one category; adjacency unchecked` : null,
    w.seat_budget != null ? `up to ₹${w.seat_budget}/seat before fees` : null,
  ].filter(Boolean);
  const seatLine = seats.length ? `\n${seats.join(" · ")}` : "";
  return (
    `#${w.id} · ${heading} — ${what}\n` +
    `${formatCity(w.city)} · ${source} · ${watchStateText(w, source)}${filtLine}${seatLine}`
  );
}

function watchListButtons(rows: WatchListRow[]): ActionRowBuilder<ButtonBuilder>[] {
  if (!rows.length) return [];
  const actionRows: ActionRowBuilder<ButtonBuilder>[] = [];
  const maxStopRows = rows.length >= 2 ? 4 : 5;
  for (let i = 0; i < Math.min(rows.length, maxStopRows * 5); i += 5) {
    actionRows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        rows.slice(i, i + 5).map((w) => stopButton(w.id, `Stop #${w.id} · ${w.title}`)),
      ),
    );
  }
  if (rows.length >= 2) {
    actionRows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(STOP_ALL_CUSTOM_ID)
          .setLabel("Stop all watches")
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }
  return actionRows;
}

export function watchList(rows: WatchListRow[]) {
  const body = clamp(rows.map(formatWatchRow).join("\n\n"), 4096);
  const embed = sig(new EmbedBuilder(), "Watches").setColor(ARMED).setDescription(body);
  const components = watchListButtons(rows);
  return components.length ? { embeds: [embed], components } : { embeds: [embed] };
}

/** Something is wrong with SeatSniper. Say what, and what it does NOT mean. */
export function cannotRead(opts: { title: string; error: string; provider?: string }) {
  return {
    embeds: [
      sig(new EmbedBuilder(), "Problem")
        .setColor(ALARM)
        .setTitle(`I can't read ${opts.provider ?? "BookMyShow"} right now`)
        .setDescription(
          `Three checks in a row failed for **${opts.title}**, so I can't tell you whether ` +
            "it's on sale.\n\n**This is a fault on my side, not a “no tickets” answer.** " +
            "I'll keep trying and tell you when it opens.",
        )
        .addFields({ name: "What failed", value: `\`\`\`${opts.error.slice(0, 260)}\`\`\`` })
        .setTimestamp(),
    ],
  };
}

export function help(opts?: { everyMin?: number; maxWatches?: number }) {
  const everyMin = opts?.everyMin ?? 10;
  const maxWatches = opts?.maxWatches ?? 5;
  return {
    embeds: [
      sig(new EmbedBuilder(), "Help")
        .setColor(ARMED)
        .setTitle("Get a DM the moment tickets go on sale")
        .setDescription(
          "Open the movie or event on BookMyShow or District, copy the link (or tap **Share**), " +
            "and paste it into `/watch`. The link carries your city. Dining is not supported.",
        )
        .addFields(
          {
            name: "Watch one date",
            value:
              "`/watch link:<paste> date:2026-07-30`\n" +
              "Shortcuts work too: `today`, `tomorrow`, `fri`, `next sat`. " +
              "Pings you once when that date opens, then stops.",
          },
          {
            name: "Watch every date",
            value:
              "`/watch link:<paste>`\n" +
              "Leave `date:` out (or pass `date:any`). Pings you each time a **new** date " +
              "or cinema opens, until you stop it.",
          },
          {
            name: "Filter by format / theatre / day",
            value:
              "`format:IMAX,4DX` · `theatre:PVR,INOX` · `days:fri,sat,sun` · `after:18:00` · `before:23:00`\n" +
              "Optional (`6pm` / `11am` shorthand works). Only pings when a matching show appears.\n" +
              "_`format:` and `days:` filter date and showtime alerts; `theatre:` also filters new cinemas._",
          },
          {
            name: "Seat count and budget",
            value:
              "Use `budget:500` (listed INR per seat before fees) on movies, and `seats:2` on " +
              "District movies (within one ticket category; seat adjacency is not checked).",
          },
          {
            name: "District events",
            value:
              "Paste the District `/events/...-buy-tickets` link. Use `date:any` or one date; " +
              "`days:`, `after:`, `before:`, and `theatre:` (venue) all work.",
          },
          {
            name: "Manage",
            value:
              "`/list` — active watches with one-tap stop buttons\n" +
              "`/stop` — choose a watch by ID, or `all:true` to stop all",
          },
          {
            name: "Limits",
            value:
              "Watches only observe public listings and notify you — SeatSniper never logs in, " +
              "holds seats, or books tickets. Buttons open BookMyShow or District so you can pay.",
          },
        )
        .setFooter({
          text: `Checks every ${everyMin} minute${everyMin === 1 ? "" : "s"} · ${maxWatches} watches each`,
        }),
    ],
  };
}

export function watchExpired(opts: { title: string; date: string }) {
  return {
    embeds: [
      sig(new EmbedBuilder(), "Watch")
        .setColor(RETIRED)
        .setTitle(clamp(`${opts.title} — watch ended`, 256))
        .setDescription(`${prettyDate(opts.date)} has passed, so I've stopped watching it.`)
        .setTimestamp(),
    ],
  };
}
