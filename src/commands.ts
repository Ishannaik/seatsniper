/** Import-safe slash command definitions and autocomplete helpers. */
import {
  ApplicationIntegrationType,
  InteractionContextType,
  SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { daySuggestions, formatSuggestions } from "./filters.ts";
import { formatCity } from "./movie-model.ts";
import {
  addDaysToDateCode,
  dayOfWeek,
  FULL_WEEKDAYS,
  isoDate,
  parseDateInput,
  parseTimeFilter,
  prettyDate,
  todayIST,
} from "./time-filter.ts";

export type StopChoiceWatch = {
  id: number;
  title: string;
  city: string;
  date: string;
  provider?: "bms" | "district";
};

const TIME_PRESETS = [
  { name: "09:00 — Morning (9:00 AM IST)", value: "09:00", search: "09:00 9:00 9am 9 am morning" },
  { name: "12:00 — Noon (12:00 PM IST)", value: "12:00", search: "12:00 12pm 12 pm noon" },
  {
    name: "15:00 — Afternoon (3:00 PM IST)",
    value: "15:00",
    search: "15:00 3:00 3pm 3 pm afternoon",
  },
  { name: "18:00 — Evening (6:00 PM IST)", value: "18:00", search: "18:00 6:00 6pm 6 pm evening" },
  { name: "21:00 — Night (9:00 PM IST)", value: "21:00", search: "21:00 9:00 9pm 9 pm night" },
  {
    name: "23:00 — Late night (11:00 PM IST)",
    value: "23:00",
    search: "23:00 11:00 11pm 11 pm late night",
  },
];

function addWatchScheduleOptions(builder: SlashCommandOptionsOnlyBuilder) {
  return builder
    .addStringOption((o) =>
      o
        .setName("date")
        .setDescription('Date e.g. 2026-07-30, today, tomorrow, fri, or "any" for every new date')
        .setMaxLength(64)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("format")
        .setDescription("Formats: PXL, IMAX, 3D, 4DX, ScreenX; commas mean any")
        .setMaxLength(200)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("days")
        .setDescription("Only ping on these days, e.g. fri,sat,sun")
        .setMaxLength(64)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("after")
        .setDescription("Only ping for shows starting at or after this IST time, e.g. 18:00 or 6pm")
        .setMaxLength(64)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("before")
        .setDescription("Only ping for shows starting before this IST time, e.g. 12:00 or 11am")
        .setMaxLength(64)
        .setAutocomplete(true),
    );
}

function watchCommand() {
  const builder = new SlashCommandBuilder()
    .setName("watch")
    .setDescription(
      "Watch a BookMyShow or District movie/event link and get a DM when that date opens",
    )
    .addStringOption((o) =>
      o
        .setName("link")
        .setDescription("Paste a BookMyShow or District movie/event link")
        .setMaxLength(512)
        .setRequired(true),
    );
  return addWatchScheduleOptions(builder)
    .addStringOption((o) =>
      o
        .setName("theatre")
        .setDescription("Only ping for these cinemas or event venues, e.g. PVR,Yashobhoomi")
        .setMaxLength(200),
    )
    .addIntegerOption((o) =>
      o
        .setName("seats")
        .setDescription(
          "District movies: available seats in one category; adjacency is not checked",
        )
        .setMinValue(1)
        .setMaxValue(10),
    )
    .addNumberOption((o) =>
      o
        .setName("budget")
        .setDescription("Movies: max listed price per seat in INR, excluding fees")
        .setMinValue(1),
    );
}

function stopCommand() {
  return new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop an active watch or all watches")
    .addIntegerOption((o) =>
      o
        .setName("id")
        .setDescription("Watch to stop (pick from list or check /list)")
        .setMinValue(1)
        .setAutocomplete(true)
        .setRequired(false),
    )
    .addBooleanOption((o) =>
      o.setName("all").setDescription("Stop all of your active watches").setRequired(false),
    );
}

export function buildCommands() {
  return [
    watchCommand(),
    new SlashCommandBuilder().setName("help").setDescription("How SeatSniper works"),
    new SlashCommandBuilder().setName("list").setDescription("Show your active watches"),
    stopCommand(),
  ].map((c) =>
    c
      .setIntegrationTypes(
        ApplicationIntegrationType.GuildInstall,
        ApplicationIntegrationType.UserInstall,
      )
      .setContexts(
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      )
      .toJSON(),
  );
}

function buildDateCandidates(base: string) {
  const tomorrow = addDaysToDateCode(base, 1);
  const upcoming = [2, 3, 4, 5, 6].map((offset) => addDaysToDateCode(base, offset));
  const orderedUpcoming = [
    ...upcoming.filter((d) => ["fri", "sat", "sun"].includes(dayOfWeek(d))),
    ...upcoming.filter((d) => !["fri", "sat", "sun"].includes(dayOfWeek(d))),
  ];
  const daySearch = (d: string) => {
    const dow = dayOfWeek(d);
    return `${prettyDate(d).toLowerCase()} ${d} ${isoDate(d)} ${dow} ${FULL_WEEKDAYS[dow] ?? ""}`;
  };
  return [
    {
      name: "Every new date & cinema (any)",
      value: "any",
      search: "every new date cinema any all",
    },
    { name: `Today — ${prettyDate(base)}`, value: base, search: `today tod ${daySearch(base)}` },
    {
      name: `Tomorrow — ${prettyDate(tomorrow)}`,
      value: tomorrow,
      search: `tomorrow tom tmrw ${daySearch(tomorrow)}`,
    },
    ...orderedUpcoming.map((d) => ({
      name: `${prettyDate(d)} (${isoDate(d)})`,
      value: d,
      search: daySearch(d),
    })),
  ];
}

function dateSuggestions(raw: string, now?: number): { name: string; value: string }[] {
  const base = todayIST(now);
  const query = raw.trim().toLowerCase();
  const matched = buildDateCandidates(base)
    .filter((item) => !query || item.search.includes(query))
    .map(({ name, value }) => ({ name, value }));

  if (query) {
    try {
      const resolved = parseDateInput(raw, now);
      if (resolved === "any" && !matched.some((m) => m.value === "any")) {
        matched.unshift({ name: "Every new date & cinema (any)", value: "any" });
      } else if (
        resolved !== "any" &&
        resolved >= base &&
        !matched.some((m) => m.value === resolved)
      ) {
        matched.push({ name: `${prettyDate(resolved)} (${isoDate(resolved)})`, value: resolved });
      }
    } catch {
      // Incomplete input while typing — fall back to substring matches.
    }
  }

  return matched.slice(0, 25);
}

function timeSuggestions(raw: string): { name: string; value: string }[] {
  const query = raw.trim().toLowerCase();
  const matched = TIME_PRESETS.filter((item) => !query || item.search.includes(query)).map(
    ({ name, value }) => ({ name, value }),
  );
  if (query) {
    const minutes = parseTimeFilter(raw);
    if (minutes !== null) {
      const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
      const mm = String(minutes % 60).padStart(2, "0");
      const canonical = `${hh}:${mm}`;
      if (!matched.some((m) => m.value === canonical)) {
        matched.unshift({ name: `${canonical} IST`, value: canonical });
      }
    }
  }
  return matched.slice(0, 25);
}

function formatStopChoiceName(w: StopChoiceWatch): string {
  const when = w.date ? prettyDate(w.date) : "Any new date";
  const prov = w.provider === "district" ? "District" : "BMS";
  const prefix = `#${w.id} · `;
  const suffix = ` · ${when} · ${formatCity(w.city)} (${prov})`;
  const budget = 100 - prefix.length - suffix.length;
  if (budget <= 1) return `${prefix}${w.title}${suffix}`.slice(0, 100);
  const title = w.title.length <= budget ? w.title : `${w.title.slice(0, budget - 1)}…`;
  return `${prefix}${title}${suffix}`.slice(0, 100);
}

function stopSuggestions(
  raw: string,
  watches: readonly StopChoiceWatch[],
): { name: string; value: number }[] {
  const query = raw.trim().toLowerCase();
  return watches
    .filter((w) => {
      if (!query) return true;
      const when = w.date
        ? `${prettyDate(w.date)} ${w.date} ${isoDate(w.date)}`
        : "any new date subscription";
      const prov = w.provider === "district" ? "district" : "bms bookmyshow";
      const haystack =
        `#${w.id} ${w.id} ${w.title} ${w.city} ${formatCity(w.city)} ${when} ${prov}`.toLowerCase();
      return haystack.includes(query);
    })
    .slice(0, 25)
    .map((w) => ({ name: formatStopChoiceName(w), value: w.id }));
}

export function commandSuggestions(
  command: string,
  focused: { name: string; value: string | number },
  context?: { watches?: readonly StopChoiceWatch[]; now?: number },
): { name: string; value: string | number }[] {
  const raw = String(focused.value);
  if (command === "stop") {
    return focused.name === "id" ? stopSuggestions(raw, context?.watches ?? []) : [];
  }
  if (command !== "watch") return [];
  if (focused.name === "date") return dateSuggestions(raw, context?.now);
  if (focused.name === "format") return formatSuggestions(raw);
  if (focused.name === "days") return daySuggestions(raw);
  if (focused.name === "after" || focused.name === "before") return timeSuggestions(raw);
  return [];
}
