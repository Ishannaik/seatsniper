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
 *
 * Signature  The author line — name + logo — on every single message, so it's
 *            recognisable mid-scroll without reading a word.
 *
 * Slots deliberately left EMPTY:
 *   thumbnail  BookMyShow's buytickets page carries no poster art (verified: only
 *              favicons and app icons on the CDN). BMS's own logo would be filler.
 *   image      nothing to show that the words don't say.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Show } from "./bms.ts";
import { prettyDate } from "./bms.ts";

export const LIVE = 0x2ecc71;
export const ARMED = 0x4a4d52;
export const ALARM = 0xe01b24;
export const RETIRED = 0x8a8f98;

const ICON =
  "https://cdn.discordapp.com/app-icons/1531174105854771363/0fa8d0978bcce83b8d17b2b85ddc919c.png?size=128";

const sig = (e: EmbedBuilder, kind: string) =>
  e.setAuthor({ name: `SeatSniper · ${kind}`, iconURL: ICON });

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A real tap target beats a markdown link — especially on a phone. */
const bookButton = (url: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Book now").setStyle(ButtonStyle.Link).setURL(url),
  );

/** Up to `limit` distinct slots as native Discord times, localised per reader. */
function timeList(shows: Show[], limit = 8): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of shows) {
    const key = `${s.epoch}|${s.attributes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length < limit) out.push(`<t:${s.epoch}:t>${s.attributes ? ` ${s.attributes}` : ""}`);
  }
  const extra = seen.size - out.length;
  return out.join(" · ") + (extra > 0 ? ` _+${extra} more_` : "");
}

const formatsOf = (shows: Show[]) =>
  [...new Set(shows.map((s) => s.attributes).filter(Boolean))];

/** The payoff: this date just became bookable. */
export function ticketsLive(opts: {
  title: string; city: string; date: string; shows: Show[]; url: string; filters?: string | null;
}) {
  const fmts = formatsOf(opts.shows);
  const embed = sig(new EmbedBuilder(), "Alert")
    .setColor(LIVE)
    .setTitle(`${opts.title} — tickets are live`)
    .setURL(opts.url)
    .setDescription(
      `${opts.shows.length} show${opts.shows.length === 1 ? "" : "s"} in ` +
        `${titleCase(opts.city)} on ${prettyDate(opts.date)}.` +
        (opts.filters ? `\n_Matching your filter: ${opts.filters}_` : ""),
    )
    .addFields({ name: "Showtimes", value: timeList(opts.shows) })
    .setTimestamp();
  if (fmts.length) {
    embed.addFields({
      name: fmts.length === 1 ? "Format" : "Formats",
      value: fmts.slice(0, 6).join(" · "),
      inline: true,
    });
  }
  return { embeds: [embed], components: [bookButton(opts.url)] };
}

/** Subscription payoff: dates that weren't on sale last time now are. */
export function newDates(opts: { title: string; city: string; dates: string[]; url: string; filters?: string | null }) {
  const n = opts.dates.length;
  return {
    embeds: [
      sig(new EmbedBuilder(), "Alert")
        .setColor(LIVE)
        .setTitle(`${opts.title} — ${n === 1 ? "a new date opened" : `${n} new dates opened`}`)
        .setURL(opts.url)
        .setDescription(
          `${opts.dates.map(prettyDate).join(" · ")}\n\nNow on sale in ${titleCase(opts.city)}. ` +
            "I'll keep watching for later dates." +
            (opts.filters ? `\n_Matching your filter: ${opts.filters}_` : ""),
        )
        .setTimestamp(),
    ],
    components: [bookButton(opts.url)],
  };
}

/** Subscription payoff: venues that weren't listing last time now are. */
export function newCinemas(opts: {
  title: string; city: string; venues: { code: string; name: string }[]; url: string; filters?: string | null;
}) {
  const list = opts.venues.slice(0, 8)
    .map((v) => `**${v.name}** (\`${v.code}\`)`)
    .join("\n");
  const extra = opts.venues.length - Math.min(opts.venues.length, 8);
  const embed = sig(new EmbedBuilder(), "Alert")
    .setColor(LIVE)
    .setTitle(`${opts.title} — ${opts.venues.length === 1 ? "new cinema" : `${opts.venues.length} new cinemas`}`)
    .setURL(opts.url)
    .setDescription(
      `Now listing in ${titleCase(opts.city)}:\n${list}` +
        (extra > 0 ? `\n_+${extra} more_` : "") +
        "\n\nI'll keep watching for more." +
        (opts.filters ? `\n_Matching your filter: ${opts.filters}_` : ""),
    )
    .setTimestamp();
  return { embeds: [embed], components: [bookButton(opts.url)] };
}

export function subscriptionAlert(opts: {
  title: string; city: string; dates: string[];
  venues: { code: string; name: string }[]; url: string;
  filters?: string | null; matchedFormats?: string[];
}) {
  const filterLine = opts.filters ? `\n_Matching your filter: ${opts.filters}${opts.matchedFormats?.length ? ` (found: ${opts.matchedFormats.join(" · ")})` : ""}_` : "";
  if (opts.dates.length && opts.venues.length) {
    const embed = sig(new EmbedBuilder(), "Alert")
      .setColor(LIVE)
      .setTitle(`${opts.title} — new dates & cinemas`)
      .setURL(opts.url)
      .setDescription(`Updates in ${titleCase(opts.city)}.` + filterLine)
      .addFields(
        { name: "New dates", value: opts.dates.map(prettyDate).join(" · ") },
        {
          name: "New cinemas",
          value: opts.venues.slice(0, 8).map((v) => `**${v.name}** (\`${v.code}\`)`).join("\n"),
        },
      )
      .setTimestamp();
    return { embeds: [embed], components: [bookButton(opts.url)] };
  }
  if (opts.dates.length) return newDates(opts);
  return newCinemas(opts);
}

/** Quiet confirmation. Not news yet — it must not look like an alert. */
export function armedForDate(opts: { title: string; city: string; date: string; everyMin: number; filters?: string | null }) {
  return {
    embeds: [
      sig(new EmbedBuilder(), "Watch")
        .setColor(ARMED)
        .setTitle(opts.title)
        .setDescription(
          `Waiting for **${prettyDate(opts.date)}** in ${titleCase(opts.city)} to go on sale.\n` +
            (opts.filters ? `Only pinging for **${opts.filters}**.\n` : "") +
            `Checking every ${opts.everyMin} minutes — you'll get a DM the moment it does.`,
        )
        .setTimestamp(),
    ],
  };
}

export function armedForMovie(opts: { title: string; city: string; openNow: string[]; everyMin: number; filters?: string | null }) {
  const e = sig(new EmbedBuilder(), "Watch")
    .setColor(ARMED)
    .setTitle(opts.title)
    .setDescription(
      `Watching every date in ${titleCase(opts.city)}. You'll get a DM when a new date or cinema ` +
        `opens, until you stop it.` +
        (opts.filters ? `\nOnly pinging for **${opts.filters}**.` : ""),
    )
    .setTimestamp();
  e.addFields(
    opts.openNow.length
      ? {
          name: `Already on sale (${opts.openNow.length})`,
          value: opts.openNow.map(prettyDate).join(" · ") + "\n_No ping for these._",
        }
      : { name: "Nothing on sale yet", value: "You'll hear from me when the first date opens." },
  );
  return { embeds: [e] };
}

/** Already bookable — so no watch was created. Say that plainly. */
export function alreadyOnSale(opts: {
  title: string; city: string; date: string; shows: Show[]; url: string;
}) {
  const fmts = formatsOf(opts.shows);
  const e = sig(new EmbedBuilder(), "Watch")
    .setColor(LIVE)
    .setTitle(`${opts.title} — already on sale`)
    .setURL(opts.url)
    .setDescription(
      `${opts.shows.length} show${opts.shows.length === 1 ? "" : "s"} in ` +
        `${titleCase(opts.city)} on ${prettyDate(opts.date)}, so there's nothing to wait for.`,
    )
    .addFields({ name: "Showtimes", value: timeList(opts.shows) });
  if (fmts.length) {
    e.addFields({ name: fmts.length === 1 ? "Format" : "Formats", value: fmts.slice(0, 6).join(" · "), inline: true });
  }
  return { embeds: [e], components: [bookButton(opts.url)] };
}

export function watchList(rows: { id: number; title: string; city: string; date: string; fail_count: number; last_ok_at: number | null; format_filter?: string | null; day_filter?: string | null }[]) {
  const body = rows
    .map((w) => {
      const state =
        w.fail_count >= 3 ? "can't read BookMyShow"
        : w.last_ok_at ? `checked <t:${w.last_ok_at}:R>`
        : "not checked yet";
      const what = w.date === "" ? "every new date or cinema" : prettyDate(w.date);
      const filt = (w.format_filter || w.day_filter)
        ? `\n🎯 ${[w.format_filter, w.day_filter].filter(Boolean).join(" · ")}`
        : "";
      return `**${w.title}** — ${what}\n${titleCase(w.city)} · ${state} · \`/stop id:${w.id}\`${filt}`;
    })
    .join("\n\n");
  return {
    embeds: [sig(new EmbedBuilder(), "Watches").setColor(ARMED).setDescription(body)],
  };
}

/** Something is wrong with SeatSniper. Say what, and what it does NOT mean. */
export function cannotRead(opts: { title: string; error: string }) {
  return {
    embeds: [
      sig(new EmbedBuilder(), "Problem")
        .setColor(ALARM)
        .setTitle("I can't read BookMyShow right now")
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

/**
 * The only message someone reads before they trust the bot with anything.
 * It answers three questions in order — what does it do, where do I get the link,
 * what do I type — and stops. No feature tour.
 */
export function help() {
  return {
    embeds: [
      sig(new EmbedBuilder(), "Help")
        .setColor(ARMED)
        .setTitle("Get a DM the moment tickets go on sale")
        .setDescription(
          "Open the movie on BookMyShow, copy the link from your browser or the " +
            "**Share** button, and paste it below. The link carries the city, so " +
            "you'll get your own city's theatres.",
        )
        .addFields(
          {
            name: "Watch one date",
            value:
              "```/watch link:<paste> date:2026-07-30```" +
              "Pings you once when that date opens, then stops.",
          },
          {
            name: "Watch every date",
            value:
              "```/watch link:<paste>```" +
              "Leave the date out. Pings you each time a **new** date opens, " +
              "until you stop it. Good for a film that isn't out yet.",
          },
          {
            name: "Filter by format / day",
            value:
              "```/watch link:<paste> format:IMAX,4DX days:fri,sat,sun```" +
              "Optional. Only pings when a matching show appears. " +
              "Formats: IMAX, 4DX, ScreenX, 3D, 2D, MX4D, Dolby Atmos…",
          },
          {
            name: "Manage",
            value: "`/list` — what you're watching\n`/stop id:3` — stop one",
          },
        )
        .setFooter({ text: "Checks every 10 minutes · 5 watches each" }),
    ],
  };
}

export function watchExpired(opts: { title: string; date: string }) {
  return {
    embeds: [
      sig(new EmbedBuilder(), "Watch")
        .setColor(RETIRED)
        .setTitle(`${opts.title} — watch ended`)
        .setDescription(`${prettyDate(opts.date)} has passed, so I've stopped watching it.`)
        .setTimestamp(),
    ],
  };
}
