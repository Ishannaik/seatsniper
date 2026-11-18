/**
 * Regenerate or verify the `src/*.ts` module table in `AGENTS.md` (rule R7).
 *
 * Usage:
 *   bun scripts/gen-agents-modules.ts          # rewrite AGENTS.md module table in place
 *   bun scripts/gen-agents-modules.ts --check  # exit 1 if AGENTS.md drifted from disk
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC_DIR = join(ROOT, "src");
const AGENTS_PATH = join(ROOT, "AGENTS.md");
export const START_MARKER = "<!-- AGENTS-MODULES:START -->";
export const END_MARKER = "<!-- AGENTS-MODULES:END -->";

function locateMarkerBounds(normalized: string): { start: number; end: number } | null {
  const startMatch = /^<!-- AGENTS-MODULES:START -->$/m.exec(normalized);
  const endMatch = /^<!-- AGENTS-MODULES:END -->$/m.exec(normalized);
  if (!startMatch || !endMatch || endMatch.index < startMatch.index) return null;
  return { start: startMatch.index, end: endMatch.index + END_MARKER.length };
}

function firstCommentSummary(filePath: string): string {
  const lines = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").split("\n");
  for (const raw of lines.slice(0, 12)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "/**" || trimmed === "*/") continue;
    if (trimmed.startsWith("* ")) return trimmed.slice(2).trim();
    if (trimmed.startsWith("// ")) return trimmed.slice(3).trim();
    break;
  }
  return "(see module)";
}

export function discoverProductionModules(): Map<string, string> {
  const entries = readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts") && !d.name.endsWith(".test.ts"))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  const out = new Map<string, string>();
  for (const name of entries) {
    out.set(name, firstCommentSummary(join(SRC_DIR, name)));
  }
  return out;
}

function parseExistingRows(block: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/.exec(line.trim());
    const mod = match?.[1]?.trim();
    const desc = match?.[2]?.trim();
    if (mod && desc) rows.set(mod, desc);
  }
  return rows;
}

function renderModuleBlock(onDisk: Map<string, string>, existing: Map<string, string>): string {
  const lines = [START_MARKER, "| module | job |", "|---|---|"];
  for (const [name, fallback] of onDisk) {
    const desc = existing.get(name) ?? fallback;
    lines.push(`| \`${name}\` | ${desc} |`);
  }
  lines.push(END_MARKER);
  return lines.join("\n");
}

export function checkAgentsModules(): string[] {
  const normalized = readFileSync(AGENTS_PATH, "utf8").replace(/\r\n/g, "\n");
  const bounds = locateMarkerBounds(normalized);
  if (!bounds) {
    return [`R7 AGENTS.md missing standalone ${START_MARKER} ... ${END_MARKER} lines`];
  }

  const currentBlock = normalized.slice(bounds.start, bounds.end);
  const existing = parseExistingRows(currentBlock);
  const onDisk = discoverProductionModules();
  const violations: string[] = [];

  for (const name of onDisk.keys()) {
    if (!existing.has(name)) {
      violations.push(
        `R7 src/${name} exists on disk but is missing from AGENTS.md — run \`bun run agents:sync\``,
      );
    }
  }
  for (const name of existing.keys()) {
    if (!onDisk.has(name)) {
      violations.push(
        `R7 AGENTS.md lists '${name}' which does not exist in src/ — run \`bun run agents:sync\``,
      );
    }
  }
  const expectedBlock = renderModuleBlock(onDisk, existing);
  if (violations.length === 0 && currentBlock !== expectedBlock) {
    violations.push("R7 AGENTS.md module table order/format drifted — run `bun run agents:sync`");
  }
  return violations;
}

export function syncAgentsModules(): { changed: boolean; error?: string } {
  const raw = readFileSync(AGENTS_PATH, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const normalized = raw.replace(/\r\n/g, "\n");
  const bounds = locateMarkerBounds(normalized);
  if (!bounds) {
    return {
      changed: false,
      error: `[agents:sync] standalone markers not found in AGENTS.md (${START_MARKER} ... ${END_MARKER})`,
    };
  }

  const currentBlock = normalized.slice(bounds.start, bounds.end);
  const nextBlock = renderModuleBlock(discoverProductionModules(), parseExistingRows(currentBlock));
  if (currentBlock === nextBlock) return { changed: false };

  const updated = normalized.slice(0, bounds.start) + nextBlock + normalized.slice(bounds.end);
  writeFileSync(AGENTS_PATH, eol === "\r\n" ? updated.replace(/\n/g, "\r\n") : updated, "utf8");
  return { changed: true };
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const errs = checkAgentsModules();
    if (errs.length > 0) {
      for (const e of errs) console.error(`  [X] ${e}`);
      process.exit(1);
    }
    console.log("[agents:sync] AGENTS.md module table matches src/*.ts");
    process.exit(0);
  }
  const res = syncAgentsModules();
  if (res.error) {
    console.error(res.error);
    process.exit(2);
  }
  console.log(res.changed ? "[agents:sync] AGENTS.md updated" : "[agents:sync] already in sync");
}
