/** Register slash commands. Guild-scoped if DISCORD_GUILD_ID is set (instant), else global (~1h). */
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required");
}

const commands = [
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Watch a BookMyShow link and get a DM when that date opens")
    .addStringOption((o) =>
      o.setName("link").setDescription("Paste the BookMyShow movie link").setRequired(true))
    .addStringOption((o) =>
      o.setName("date").setDescription("Date to watch, e.g. 2026-07-30 (defaults to the date in the link)")),
  new SlashCommandBuilder().setName("list").setDescription("Show your active watches"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop a watch")
    .addIntegerOption((o) =>
      o.setName("id").setDescription("Watch number from /list").setRequired(true)),
].map((c) => ({
  ...c.toJSON(),
  // 0 = install to a guild, 1 = install to a user account.
  integration_types: [0, 1],
  // 0 = in a guild, 1 = in the bot's DM, 2 = in any other private channel.
  // Without this the commands only ever show up inside servers.
  contexts: [0, 1, 2],
}));

const rest = new REST().setToken(DISCORD_TOKEN);
const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

await rest.put(route, { body: commands });
console.log(
  `Registered ${commands.length} commands ${DISCORD_GUILD_ID ? `to guild ${DISCORD_GUILD_ID} (instant)` : "globally (~1h to propagate)"}`,
);
