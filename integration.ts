/** Live integration suite — real requests to production BookMyShow. */
import { initBms, closeBms, fetchShowtimes, parseWatchUrl, showsOnDate, parseMovieTitle, BmsError } from "./src/bms.ts";

await initBms();
let pass = 0, fail = 0;

function check(n: number, name: string, ok: boolean, detail: string) {
  console.log(`${String(n).padStart(2)}. ${ok ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${detail}`);
  ok ? pass++ : fail++;
}

const ODY = { city: "mumbai", slug: "the-odyssey", eventCode: "ET00480917" };
const AOT = { city: "mumbai", slug: "attack-on-titan", eventCode: "ET00508739" };
const SPI = { city: "mumbai", slug: "spider-man-brand-new-day", eventCode: "ET00502600" };

async function count(t: any, date: string) {
  const { title, shows } = await fetchShowtimes({ ...t, date });
  const on = showsOnDate(shows, date);
  return { title, all: shows.length, on: on.length,
           fmts: [...new Set(on.map((s) => s.attributes))].filter(Boolean) };
}
const sleep = () => new Promise((r) => setTimeout(r, 1300));

// ---- live availability -----------------------------------------------
let n = 0;
{ const r = await count(ODY, "20260728"); check(++n, "Odyssey Mumbai 28 Jul is bookable", r.on > 0, `${r.on} shows ${r.fmts}`); await sleep(); }
{ const r = await count(ODY, "20260730"); check(++n, "Odyssey Mumbai 30 Jul NOT bookable", r.on === 0 && r.all > 0, `page had ${r.all} shows, 0 on date`); await sleep(); }
{ const r = await count(AOT, "20260728"); check(++n, "AoT Mumbai 28 Jul is bookable", r.on > 0, `${r.on} shows ${r.fmts}`); await sleep(); }
{ const r = await count(AOT, "20260730"); check(++n, "AoT Mumbai 30 Jul NOT bookable", r.on === 0, `0 on date`); await sleep(); }

// ---- city really changes results --------------------------------------
const cityCounts: Record<string, number> = {};
for (const city of ["mumbai", "delhi", "pune", "bengaluru"]) {
  const r = await count({ ...ODY, city }, "20260728");
  cityCounts[city] = r.on;
  await sleep();
}
check(++n, "city changes show count (not server-located)", new Set(Object.values(cityCounts)).size > 1, JSON.stringify(cityCounts));
check(++n, "every city returns some shows for an open date", Object.values(cityCounts).every((v) => v > 0), JSON.stringify(cityCounts));

// ---- slug is irrelevant, city is not ----------------------------------
{ const r = await count({ ...ODY, slug: "wrong-slug-entirely" }, "20260728");
  check(++n, "wrong slug still returns correct data", r.on === cityCounts.mumbai, `${r.on} vs ${cityCounts.mumbai}`); await sleep(); }

// ---- far future / edge dates ------------------------------------------
{ const r = await count(ODY, "20271231"); check(++n, "far-future date reads as not bookable", r.on === 0, `0 on 2027-12-31`); await sleep(); }
{ const r = await count(ODY, "20200101"); check(++n, "long-past date reads as not bookable", r.on === 0, `0 on 2020-01-01`); await sleep(); }

// ---- bad event code must THROW, not return [] -------------------------
try { await count({ ...ODY, eventCode: "ET99999999" }, "20260728");
  check(++n, "bogus event code throws (never silent [])", false, "returned instead of throwing"); }
catch (e) { check(++n, "bogus event code throws (never silent [])", e instanceof BmsError, `${(e as BmsError).kind}`); }
await sleep();

// ---- parser guards (pure) ---------------------------------------------
const P = (u: string) => parseWatchUrl(u);
const B = "in.bookmyshow.com/movies/mumbai/the-odyssey/buytickets/ET00480917/20260727";
check(++n, "https URL parses", P(`https://${B}`).eventCode === "ET00480917", "ET00480917");
check(++n, "no-scheme URL parses", P(B).city === "mumbai", "mumbai");
check(++n, "discord <url> wrapper stripped", P(`<https://${B}>`).date === "20260727", "20260727");
check(++n, "utm params ignored", P(`https://${B}?utm_source=x`).date === "20260727", "20260727");
check(++n, "query that looks like a date is not used", P(`https://${B}?ref=20991231`).date === "20260727", "20260727");
check(++n, "delhi link yields delhi", P(`https://${B}`.replace("/mumbai/", "/delhi/")).city === "delhi", "delhi");
try { P("https://evil.example.com/movies/mumbai/x/buytickets/ET00480917/1"); check(++n, "non-BMS host rejected", false, "accepted"); }
catch { check(++n, "non-BMS host rejected", true, "threw"); }
try { P("https://in.bookmyshow.com/buytickets/cinema/ET00480917/20260727"); check(++n, "missing city rejected, not defaulted", false, "accepted"); }
catch { check(++n, "missing city rejected, not defaulted", true, "threw"); }
try { P("https://in.bookmyshow.com/explore/movies-mumbai"); check(++n, "no event code rejected", false, "accepted"); }
catch { check(++n, "no event code rejected", true, "threw"); }

// ---- title extraction --------------------------------------------------
{ const r = await count(ODY, "20260728"); check(++n, "real movie title read from BMS", r.title === "The Odyssey", `"${r.title}"`); await sleep(); }
{ const r = await count(SPI, "20260728"); check(++n, "Spider-Man title + page reachable", r.title.includes("Spider-Man"), `"${r.title}" ${r.all} shows`); await sleep(); }
check(++n, "parseMovieTitle decodes entities", parseMovieTitle("<title>Tom &amp; Jerry Movie Showtimes in Mumbai</title>") === "Tom & Jerry", "Tom & Jerry");
check(++n, "parseMovieTitle returns null with no title", parseMovieTitle("<html><body>x</body></html>") === null, "null");

console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
await closeBms();
