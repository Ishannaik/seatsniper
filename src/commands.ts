/** Import-safe command contracts for the classic and private-DM runtimes. */
import { SlashCommandBuilder } from "discord.js";
import { DAY_CHOICES, formatSuggestions } from "./filters.ts";
import { DM_WATCH_OPTIONS } from "./dm-command.ts";
export type BotRuntime = "classic" | "dm";
export function resolveBotRuntime(env: Record<string, string | undefined> = process.env): BotRuntime {
  const runtime = env.BOT_RUNTIME?.trim() || "classic";
  if (runtime !== "classic" && runtime !== "dm") throw Error('BOT_RUNTIME must be "classic" or "dm".');
  return runtime;
}
function watchCommand(runtime: BotRuntime) {
  if (runtime === "dm") {
    const command = new SlashCommandBuilder().setName("watch")
      .setDescription("Privately watch a BookMyShow or District movie on one date");
    for (const option of DM_WATCH_OPTIONS) command.addStringOption(o => {
      o.setName(option.name).setDescription(option.description);
      if ("required" in option) o.setRequired(option.required);
      if ("autocomplete" in option) o.setAutocomplete(option.autocomplete);
      return o;
    });
    return command;
  }
  return new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Watch a BookMyShow or District movie/event link and get a DM when that date opens")
    .addStringOption((o) =>
      o.setName("link").setDescription("Paste a BookMyShow or District movie/event link").setRequired(true))
    .addStringOption((o) =>
      o.setName("date").setDescription("Date e.g. 2026-07-30, or \"any\" to be told every time a new date opens"))
    .addStringOption((o) =>
      o.setName("format").setDescription("Formats: PXL, IMAX, 3D, 4DX, ScreenX; commas mean any").setAutocomplete(true))
    .addStringOption((o) =>
      o.setName("days").setDescription("Only ping on these days, e.g. fri,sat,sun").setAutocomplete(true))
    .addStringOption((o) =>
      o.setName("after").setDescription("Only ping for shows starting at or after this IST time, e.g. 18:00"))
    .addStringOption((o) =>
      o.setName("before").setDescription("Only ping for shows starting before this IST time, e.g. 12:00"))
    .addStringOption((o) =>
      o.setName("theatre").setDescription("Only ping for these cinemas or event venues, e.g. PVR,Yashobhoomi"))
    .addIntegerOption((o) => o.setName("seats").setDescription("District movies: available seats in one category; adjacency is not checked").setMinValue(1).setMaxValue(10))
    .addNumberOption((o) => o.setName("budget").setDescription("District movies: max listed price per seat in INR, excluding fees").setMinValue(1));
}
export function buildCommands(runtime: BotRuntime = "classic") {
return [
  watchCommand(runtime),
  new SlashCommandBuilder().setName("book").setDescription("Private District seat holds and booking with your confirmation")
    .addStringOption((o) => o.setName("action").setDescription("Booking step").setRequired(true).addChoices(...["help", "connect", "verify", "shows", "seats", "hold", "event", "event_hold", "pay", "status", "disconnect"].map((value) => ({name: value, value}))))
    .addStringOption((o) => o.setName("link").setDescription("District movie or event link"))
    .addStringOption((o) => o.setName("date").setDescription("Movie date: YYYY-MM-DD"))
    .addNumberOption((o) => o.setName("latitude").setDescription("Latitude of the area to search for movie shows").setMinValue(-90).setMaxValue(90))
    .addNumberOption((o) => o.setName("longitude").setDescription("Longitude of the area to search for movie shows").setMinValue(-180).setMaxValue(180))
    .addIntegerOption((o) => o.setName("show").setDescription("Show number from your latest list").setMinValue(1).setMaxValue(20))
    .addStringOption((o) => o.setName("seats").setDescription("Exact seat labels from the seat map, e.g. F7,F8"))
    .addStringOption((o) => o.setName("tickets").setDescription("Event choice number:quantity, e.g. 1:2"))
    .addIntegerOption((o) => o.setName("method").setDescription("Payment method number from your latest list").setMinValue(1)),
  new SlashCommandBuilder().setName("help").setDescription("How SeatSniper works"),
  new SlashCommandBuilder().setName("list").setDescription("Show your active watches"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription(runtime === "dm" ? "Stop one of your watches, or all your watches if no ID is given" : "Stop a watch")
    .addIntegerOption((o) =>
      o.setName("id").setDescription("Watch number from /list").setRequired(runtime !== "dm")),
].map((c) => ({
  ...c.toJSON(),
  // 0 = install to a guild, 1 = install to a user account.
  integration_types: [0, 1],
  // 0 = in a guild, 1 = in the bot's DM, 2 = in any other private channel.
  // Without this the commands only ever show up inside servers.
  contexts: [0, 1, 2],
}));

}
export function commandSuggestions(
  runtime: BotRuntime, command: string, focused: { name: string; value: string | number },
): { name: string; value: string }[] {
  if (command !== "watch") return [];
  if (focused.name === "format") return formatSuggestions(String(focused.value));
  if (runtime === "classic" && focused.name === "days") {
    const query = String(focused.value).toLowerCase();
    return DAY_CHOICES.filter(day => day.includes(query)).slice(0,25).map(day => ({ name: day, value: day }));
  }
  return [];
}
