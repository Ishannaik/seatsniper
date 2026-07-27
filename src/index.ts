/** SeatSniper — paste a BookMyShow link, get a DM when that date opens. */
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  initBms, closeBms, fetchShowtimes, parseWatchUrl, showsOnDate, showtimesUrl, prettyDate, BmsError,
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


/**
 * Distinct showtimes for display. Several theatres run the same slot, so the raw
 * list repeats times — 51 shows collapse to ~12 distinct ones. We don't capture
 * venue names yet (see roadmap), so listing duplicates would just look broken.
 */
function distinctTimes(shows: { showTime: string; attributes: string }[], limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of shows) {
    const label = `\`${s.showTime}\`${s.attributes ? ` ${s.attributes}` : ""}`;
    if (seen.has(label)) continue;
    seen.add(label);
    if (out.length < limit) out.push(label);
  }
  return out;
}

/** "51 shows across 12 times" reads better than a wall of repeated slots. */
const showSummary = (n: number, distinct: number) =>
  `${n} show${n === 1 ? "" : "s"}${distinct < n ? ` across ${distinct} times` : ""}`;

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
    const dateOpt = i.options.getString("date");
    const date = dateOpt ? normaliseDate(dateOpt) : parsed.date;
    if (!date) {
      return void i.editReply(
        "❌ No date. Either paste a link that ends in a date, or pass `date:2026-07-30`.",
      );
    }
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
    const times = distinctTimes(open);
    return void i.editReply({
      content: `✅ **${title}** is already bookable on ${prettyDate(target.date)} — no watch needed.`,
      embeds: [
        new EmbedBuilder().setColor(RED)
          .setTitle(showSummary(open.length, times.length) + " open now")
          .setDescription(times.join(" · "))
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

  const times = distinctTimes(open, 15);
  await dm(
    w,
    new EmbedBuilder().setColor(RED).setTitle("🎯 BOOKINGS OPEN")
      .setURL(showtimesUrl(target))
      .setDescription(
        `**${w.title}**\n${prettyDate(w.date)} · ${w.city}\n` +
          `${showSummary(open.length, times.length)}\n\n${times.join(" · ")}`,
      )
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
  if (w.date >= todayIST()) return false;
  await dm(
    w,
    new EmbedBuilder().setColor(GREY).setTitle("⌛ Watch expired")
      .setDescription(
        `**${w.title}** — ${prettyDate(w.date)} has passed, so this watch can't ever ` +
          "fire. I've removed it.",
      )
      .setFooter({ text: `watch #${w.id}` }),
  );
  removeWatch(w.id, w.user_id);
  console.log(`[poll] expired watch ${w.id} (${w.date} < ${todayIST()})`);
  return true;
}

async function poll() {
  const watches = allWatches();
  if (!watches.length) return;
  console.log(`[poll] ${watches.length} watch(es)`);
  for (const w of watches) {
    if (await expireStale(w)) continue;
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
