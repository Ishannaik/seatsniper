/** Register slash commands. Guild-scoped if DISCORD_GUILD_ID is set (instant), else global (~1h). */
import { REST, Routes } from "discord.js";

import { buildCommands, resolveBotRuntime } from "./commands.ts";

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required");
}

const runtime = resolveBotRuntime();
const commands = buildCommands(runtime);

const rest = new REST().setToken(DISCORD_TOKEN);
const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

await rest.put(route, { body: commands });
console.log(
  `Registered ${commands.length} ${runtime} commands ${DISCORD_GUILD_ID ? `to guild ${DISCORD_GUILD_ID} (instant)` : "globally (~1h to propagate)"}`,
);
