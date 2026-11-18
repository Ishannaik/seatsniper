import { describe, expect, test } from "bun:test";
import { BmsError } from "./provider-error.ts";
import {
  addDaysToDateCode,
  istToEpoch,
  matchesTimeFilter,
  parseDateInput,
  parseTimeFilter,
  prettyDate,
} from "./time-filter.ts";

function istEpoch(hours: number, minutes: number): number {
  const utc = Date.UTC(2026, 0, 1, hours, minutes);
  return Math.floor((utc - 5.5 * 3600_000) / 1000);
}

describe("parseTimeFilter and istToEpoch", () => {
  test("parses 24h and 12h IST wall-clock times", () => {
    expect(parseTimeFilter("18:00")).toBe(18 * 60);
    expect(parseTimeFilter("00:00")).toBe(0);
    expect(parseTimeFilter("23:59")).toBe(23 * 60 + 59);
    expect(parseTimeFilter("6:00 PM")).toBe(18 * 60);
    expect(parseTimeFilter("12:00 AM")).toBe(0);
    expect(parseTimeFilter("12:00 PM")).toBe(12 * 60);
    expect(parseTimeFilter("6pm")).toBe(18 * 60);
    expect(parseTimeFilter("6 pm")).toBe(18 * 60);
    expect(parseTimeFilter("11am")).toBe(11 * 60);
    expect(parseTimeFilter("12am")).toBe(0);
    expect(parseTimeFilter("12pm")).toBe(12 * 60);
  });

  test("rejects invalid times", () => {
    for (const invalid of ["6:00", "25:00", "12:60", "13:00 PM", "13pm", "0am", "tomorrow"]) {
      expect(parseTimeFilter(invalid)).toBeNull();
    }
  });

  test("istToEpoch treats YYYYMMDDHHMM as IST (UTC+5:30)", () => {
    expect(new Date(istToEpoch("202607280640") * 1000).toISOString()).toBe(
      "2026-07-28T01:10:00.000Z",
    );
  });
});

describe("matchesTimeFilter", () => {
  test("matches [after, before) IST boundaries and open-ended windows", () => {
    expect(matchesTimeFilter(istEpoch(18, 0), 18 * 60, null)).toBe(true);
    expect(matchesTimeFilter(istEpoch(17, 59), 18 * 60, null)).toBe(false);
    expect(matchesTimeFilter(istEpoch(11, 59), null, 12 * 60)).toBe(true);
    expect(matchesTimeFilter(istEpoch(12, 0), null, 12 * 60)).toBe(false);
    expect(matchesTimeFilter(istEpoch(20, 0), 18 * 60, 22 * 60)).toBe(true);
    expect(matchesTimeFilter(istEpoch(17, 0), 18 * 60, 22 * 60)).toBe(false);
    expect(matchesTimeFilter(istEpoch(23, 0), 18 * 60, 22 * 60)).toBe(false);
    expect(matchesTimeFilter(istEpoch(6, 0), null, null)).toBe(true);
  });
});

describe("prettyDate", () => {
  test("renders YYYYMMDD date codes consistently across timezones", () => {
    expect(prettyDate("20260730")).toBe("Thu, 30 Jul");
    expect(prettyDate("20260105")).toBe("Mon, 5 Jan");
    expect(prettyDate("20240229")).toBe("Thu, 29 Feb");

    const before = process.env.TZ;
    try {
      for (const tz of ["UTC", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Niue"]) {
        process.env.TZ = tz;
        expect(prettyDate("20260730")).toBe("Thu, 30 Jul");
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe("parseDateInput and addDaysToDateCode", () => {
  // Wednesday 2026-11-18 15:30 IST (10:00 UTC)
  const wedNow = Date.parse("2026-11-18T10:00:00Z");

  test("shifts calendar dates across month and year boundaries", () => {
    expect(addDaysToDateCode("20260730", 2)).toBe("20260801");
    expect(addDaysToDateCode("20261231", 1)).toBe("20270101");
  });

  test("resolves subscription aliases, today/tomorrow in IST, and upcoming weekdays", () => {
    for (const alias of ["any", "ALL", "every", "new"]) {
      expect(parseDateInput(alias, wedNow)).toBe("any");
    }

    expect(parseDateInput("today", wedNow)).toBe("20261118");
    expect(parseDateInput("tod", wedNow)).toBe("20261118");
    expect(parseDateInput("tomorrow", wedNow)).toBe("20261119");
    expect(parseDateInput("tom", wedNow)).toBe("20261119");
    expect(parseDateInput("tmrw", wedNow)).toBe("20261119");

    const postMidnightIst = Date.parse("2026-11-18T20:00:00Z");
    expect(parseDateInput("today", postMidnightIst)).toBe("20261119");
    expect(parseDateInput("tomorrow", postMidnightIst)).toBe("20261120");

    expect(parseDateInput("wed", wedNow)).toBe("20261118");
    expect(parseDateInput("next wed", wedNow)).toBe("20261125");
    expect(parseDateInput("fri", wedNow)).toBe("20261120");
    expect(parseDateInput("friday", wedNow)).toBe("20261120");
    expect(parseDateInput("this sat", wedNow)).toBe("20261121");
    expect(parseDateInput("next fri", wedNow)).toBe("20261120");
    expect(parseDateInput("tue", wedNow)).toBe("20261124");
  });

  test("validates explicit calendar dates including leap-year and month-length rules", () => {
    expect(parseDateInput("2026-07-30", wedNow)).toBe("20260730");
    expect(parseDateInput(" 2026/07/30 ", wedNow)).toBe("20260730");
    expect(parseDateInput("20260730", wedNow)).toBe("20260730");
    expect(parseDateInput("2028-02-29", wedNow)).toBe("20280229");
    expect(parseDateInput("2000-02-29", wedNow)).toBe("20000229");
    expect(parseDateInput("0096-02-29", wedNow)).toBe("00960229");
    expect(parseDateInput("2026-04-30", wedNow)).toBe("20260430");

    for (const impossible of [
      "2026-02-30",
      "2026-04-31",
      "2026-02-29",
      "1900-02-29",
      "2026-06-31",
      "2026-11-31",
      "2026-00-01",
      "2026-13-01",
      "2026-01-00",
      "2026-01-32",
    ]) {
      expect(() => parseDateInput(impossible, wedNow)).toThrow("isn't a real date");
    }

    for (const malformed of ["2026-2-3", "202607", "202607300", "   ", "someday"]) {
      expect(() => parseDateInput(malformed, wedNow)).toThrow(BmsError);
    }
  });
});
