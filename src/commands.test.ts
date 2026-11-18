import { expect, test } from "bun:test";
import { buildCommands, commandSuggestions, type StopChoiceWatch } from "./commands.ts";

test("buildCommands defines the unified read-only command set for guilds and DMs", () => {
  const commands = buildCommands();
  expect(commands.map((c) => c.name)).toEqual(["watch", "help", "list", "stop"]);

  for (const cmd of commands) {
    expect(cmd.integration_types).toEqual([0, 1]);
    expect(cmd.contexts).toEqual([0, 1, 2]);
    expect(cmd.description.length).toBeLessThanOrEqual(100);
    for (const opt of cmd.options ?? []) {
      expect(opt.description.length).toBeLessThanOrEqual(100);
    }
  }
});

test("/watch and /stop advertise autocomplete and stop-all options", () => {
  const watch = buildCommands().find((c) => c.name === "watch");
  expect(watch).toBeDefined();

  const options = watch?.options ?? [];
  expect(options.map((o) => o.name)).toEqual([
    "link",
    "date",
    "format",
    "days",
    "after",
    "before",
    "theatre",
    "seats",
    "budget",
  ]);
  expect(options.find((o) => o.name === "link")?.required).toBe(true);
  expect(options.find((o) => o.name === "date")?.description).toContain("any");

  for (const autoOpt of ["date", "format", "days", "after", "before"]) {
    const opt = options.find((o) => o.name === autoOpt) as { autocomplete?: boolean } | undefined;
    expect(opt?.autocomplete).toBe(true);
  }

  const stop = buildCommands().find((c) => c.name === "stop");
  const stopOpts = stop?.options ?? [];
  expect(stopOpts.map((o) => o.name)).toEqual(["id", "all"]);
  expect((stopOpts[0] as { autocomplete?: boolean; required?: boolean })?.autocomplete).toBe(true);
  expect(stopOpts[0]?.required).toBe(false);
  expect(stopOpts[1]?.required).toBe(false);
});

test("commandSuggestions routes /watch options to date, format, days, and IST time presets", () => {
  const now = Date.parse("2026-11-18T10:00:00Z"); // Wednesday 2026-11-18 15:30 IST

  const dates = commandSuggestions("watch", { name: "date", value: "" }, { now });
  expect(dates[0]).toEqual({ name: "Every new date & cinema (any)", value: "any" });
  expect(dates[1]?.value).toBe("20261118");
  expect(dates[2]?.value).toBe("20261119");
  expect(dates[3]?.value).toBe("20261120"); // Upcoming Friday prioritised

  expect(
    commandSuggestions("watch", { name: "date", value: "next wed" }, { now }).map((c) => c.value),
  ).toContain("20261125");
  expect(
    commandSuggestions("watch", { name: "format", value: "PXL,im" }).map((c) => c.value),
  ).toContain("PXL,IMAX");
  expect(commandSuggestions("watch", { name: "days", value: "week" }).map((c) => c.value)).toEqual([
    "fri,sat,sun",
    "mon,tue,wed,thu,fri",
  ]);
  expect(
    commandSuggestions("watch", { name: "after", value: "6pm" }).map((c) => c.value),
  ).toContain("18:00");
  expect(commandSuggestions("watch", { name: "before", value: "7:30pm" })[0]).toEqual({
    name: "19:30 IST",
    value: "19:30",
  });
  expect(commandSuggestions("watch", { name: "theatre", value: "PVR" })).toEqual([]);
  expect(commandSuggestions("stop", { name: "format", value: "im" })).toEqual([]);
});

test("commandSuggestions formats and filters /stop id choices with <=100 char labels", () => {
  const watches: StopChoiceWatch[] = [
    { id: 3, title: "Dune: Part Two", city: "mumbai", date: "20260730", provider: "bms" },
    { id: 4, title: "Ramayana", city: "mumbai", date: "", provider: "district" },
    {
      id: 12,
      title:
        "A Very Long IMAX Special Screening Event Title That Exceeds Discord Choice Limits Easily",
      city: "delhi-ncr",
      date: "20261120",
      provider: "bms",
    },
  ];

  const all = commandSuggestions("stop", { name: "id", value: "" }, { watches });
  expect(all).toHaveLength(3);
  expect(all[0]?.name).toContain("#3 · Dune: Part Two");
  expect(all[0]?.name).toContain("Mumbai (BMS)");
  expect(all[1]?.name).toBe("#4 · Ramayana · Any new date · Mumbai (District)");
  for (const choice of all) {
    expect(choice.name.length).toBeLessThanOrEqual(100);
  }

  expect(
    commandSuggestions("stop", { name: "id", value: "district" }, { watches }).map((c) => c.value),
  ).toEqual([4]);
  expect(
    commandSuggestions("stop", { name: "id", value: "dune" }, { watches }).map((c) => c.value),
  ).toEqual([3]);
  expect(commandSuggestions("stop", { name: "id", value: "" })).toEqual([]);
});
