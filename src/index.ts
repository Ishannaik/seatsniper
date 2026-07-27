/** SeatSniper — paste a BookMyShow link, get a DM when that date opens. */
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  initBms, closeBms, fetchShows, parseWatchUrl, showsOnDate, showtimesUrl, prettyDate, BmsError,
} from "./bms.ts";
import {
  addWatch, listWatches, allWatches, countWatches, removeWatch, markOk, markFail,
  MAX_WATCHES_PER_USER, type Watch,
} from "./db.ts";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error("DISCORD_TOKEN missing — copy .env.example to .env");

const POLL_MS = Number(process.env.POLL_INTERVAL_SEC ?? 600) * 1000;
const RED = 0xe01b24;
const GREY = 0x6b6b6b;

const titleFromSlug = (slug: string) =>
  slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** "2026-07-30" | "20260730" -> "20260730". Throws on anything else. */
function normaliseDate(input: string): string {
  const d = input.trim().replace(/-/g, "");
  if (!/^\d{8}$/.test(d)) throw new BmsError("bad_url", `Date must look like 2026-07-30, got "${input}"`);
  return d;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------------------------------------------------------------- commands

async function cmdWatch(i: ChatInputCommandInteraction) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  let target;
  try {
    const parsed = parseWatchUrl(i.options.getString("link", true));
    const dateOpt = i.options.getString("date");
    const date = dateOpt ? normaliseDate(dateOpt) : parsed.date;
    if (!date) {
      return void i.editReply(
        "❌ No date. Either paste a link that ends in a date, or pass `date:2026-07-30`.",
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
  let open;
  try {
    open = showsOnDate(await fetchShows(target), target.date);
  } catch (e) {
    return void i.editReply(
      `⚠️ Can't reach BookMyShow right now, so I won't save a watch I can't check.\n\`${(e as Error).message}\``,
    );
  }

  const title = titleFromSlug(target.slug);

  if (open.length) {
    return void i.editReply({
      content: `✅ **${title}** is already bookable on ${prettyDate(target.date)} — no watch needed.`,
      embeds: [
        new EmbedBuilder().setColor(RED).setTitle(`${open.length} shows open now`)
          .setDescription(open.slice(0, 12).map((s) => `\`${s.showTime}\` ${s.attributes}`).join(" · "))
          .setURL(showtimesUrl(target)),
      ],
    });
  }

  const id = addWatch({
    user_id: i.user.id, channel_id: i.channelId, city: target.city, slug: target.slug,
    event_code: target.eventCode, date: target.date, title,
  });
  if (id === null) return void i.editReply("You're already watching that movie and date. `/list` to see it.");

  await i.editReply({
    embeds: [
      new EmbedBuilder().setColor(RED).setTitle("🎯 Watching")
        .setDescription(`**${title}**\n${prettyDate(target.date)} · ${target.city}`)
        .addFields({ name: "​", value: `Checking every ${POLL_MS / 60000} min — I'll DM you the moment it opens.` })
        .setFooter({ text: `watch #${id}` }),
    ],
  });
}

async function cmdList(i: ChatInputCommandInteraction) {
  const rows = listWatches(i.user.id);
  if (!rows.length) {
    return void i.reply({
      content: "No watches yet. Paste a BookMyShow link with `/watch`.",
      flags: MessageFlags.Ephemeral,
    });
  }
  const body = rows
    .map((w) => {
      const health =
        w.fail_count >= 3 ? `⚠️ can't read BMS (${w.fail_count} fails)`
        : w.last_ok_at ? `✅ checked ${Math.round((Date.now() / 1000 - w.last_ok_at) / 60)} min ago`
        : "⏳ not checked yet";
      return `**#${w.id}** ${w.title}\n${prettyDate(w.date)} · ${w.city} · ${health}`;
    })
    .join("\n\n");
  await i.reply({
    embeds: [new EmbedBuilder().setColor(RED).setTitle("Your watches").setDescription(body)],
    flags: MessageFlags.Ephemeral,
  });
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

async function checkWatch(w: Watch) {
  const target = { city: w.city, slug: w.slug, eventCode: w.event_code, date: w.date };
  let open;
  try {
    open = showsOnDate(await fetchShows(target), w.date);
  } catch (e) {
    markFail(w.id, (e as Error).message);
    // One warning at exactly 3 consecutive failures: enough to rule out a blip,
    // and never repeated so a persistent outage can't spam the user.
    if (w.fail_count + 1 === 3) await dm(w, failEmbed(w, e as Error));
    return;
  }
  markOk(w.id);
  if (!open.length) return;

  const times = open.slice(0, 15).map((s) => `\`${s.showTime}\`${s.attributes ? ` ${s.attributes}` : ""}`);
  await dm(
    w,
    new EmbedBuilder().setColor(RED).setTitle("🎯 BOOKINGS OPEN")
      .setURL(showtimesUrl(target))
      .setDescription(`**${w.title}**\n${prettyDate(w.date)} · ${w.city}\n\n${times.join(" · ")}`)
      .addFields({ name: "​", value: `**[Book now →](${showtimesUrl(target)})**` })
      .setFooter({ text: `watch #${w.id} · removed, it's done its job` }),
  );
  removeWatch(w.id, w.user_id);
}

const failEmbed = (w: Watch, e: Error) =>
  new EmbedBuilder().setColor(GREY).setTitle("⚠️ I can't read BookMyShow")
    .setDescription(
      `Watch **#${w.id}** (${w.title}) is still active, but 3 checks in a row failed.\n` +
        "**This is my problem, not “no tickets”.**",
    )
    .addFields({ name: "Error", value: `\`${e.message.slice(0, 300)}\`` });

/** DM the owner; fall back to the origin channel *and say so*. Never silent. */
async function dm(w: Watch, embed: EmbedBuilder) {
  try {
    const user = await client.users.fetch(w.user_id);
    await user.send({ embeds: [embed] });
  } catch {
    try {
      const ch = await client.channels.fetch(w.channel_id);
      if (ch?.isTextBased() && "send" in ch) {
        await ch.send({
          content: `<@${w.user_id}> (couldn't DM you — your DMs are closed, so posting here)`,
          embeds: [embed],
        });
      }
    } catch (e) {
      console.error(`[watch ${w.id}] could not deliver anywhere:`, (e as Error).message);
    }
  }
}

async function poll() {
  const watches = allWatches();
  if (!watches.length) return;
  console.log(`[poll] ${watches.length} watch(es)`);
  for (const w of watches) {
    await checkWatch(w);
    // Stagger so we never burst. Cheap insurance against looking automated.
    await Bun.sleep(2000 + Math.random() * 3000);
  }
}

// ---------------------------------------------------------------- wire-up

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === "watch") await cmdWatch(i);
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
