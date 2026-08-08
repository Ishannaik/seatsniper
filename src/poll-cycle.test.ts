import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Watch } from "./db.ts";
import { runWatchCycle } from "./poll-cycle.ts";

const watch = { id: "w1" } as unknown as Watch;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runWatchCycle", () => {
  test("continues when expiry throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let checked = false;

    await runWatchCycle(watch, {
      expireStale: async () => {
        throw new Error("sqlite busy");
      },
      checkWatch: async () => {
        checked = true;
      },
    });

    expect(checked).toBe(false);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("failed to expire"));
  });

  test("skips the check when the watch expired", async () => {
    let checked = false;

    await runWatchCycle(watch, {
      expireStale: async () => true,
      checkWatch: async () => {
        checked = true;
      },
    });

    expect(checked).toBe(false);
  });

  test("continues when the check throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await runWatchCycle(watch, {
      expireStale: async () => false,
      checkWatch: async () => {
        throw new Error("watch removed mid-cycle");
      },
    });

    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("failed to check"));
  });

  test("runs the check when expiry succeeds", async () => {
    let checked = false;

    await runWatchCycle(watch, {
      expireStale: async () => false,
      checkWatch: async () => {
        checked = true;
      },
    });

    expect(checked).toBe(true);
  });
});
