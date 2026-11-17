import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("District commands and polling deliver filtered alerts with retries and deduplication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seatsniper-flow-"));
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./test-support/district-bot-flow.ts", import.meta.url))], { env: { ...process.env, DB_PATH: join(dir, "test.db") }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, out + err).toBe(0);
    expect(out).toContain("District bot flow passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
