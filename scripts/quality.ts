/**
 * SeatSniper Architecture & Drift Gate (`scripts/quality.ts`).
 *
 * Enforces structural invariants that linters/typecheckers miss:
 *   - R2  Production file-length ceiling (400 lines; explicit ratchets for legacy files)
 *   - R3  Zero circular runtime imports across src/*.ts
 *   - R7  AGENTS.md module table matches src/*.ts 1:1
 *   - R8  Repository hygiene (no stray temp DBs, conflict markers, or purged PR #160 artifacts)
 *
 * Usage:
 *   bun scripts/quality.ts                 # check all rules, exit 1 on violation
 *   bun scripts/quality.ts --write-agents  # refresh AGENTS.md module table before checking
 *   bun scripts/quality.ts --json          # machine-readable JSON summary
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { checkAgentsModules, syncAgentsModules } from "./gen-agents-modules.ts";

const ROOT = resolve(import.meta.dir, "..");
const SRC_DIR = join(ROOT, "src");
const MAX_FILE_LINES = 400;

// Ratcheted ceilings for pre-existing large modules: prevents unbounded growth
// while requiring every other module (and any newly split module) to stay <= 400 lines.
const LEGACY_FILE_CEILINGS: Record<string, number> = {
  "index.ts": 1300,
  "messages.ts": 750,
  "bms.ts": 600,
  "district.ts": 500,
};

function productionSrcFiles(): string[] {
  return readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts") && !d.name.endsWith(".test.ts"))
    .map((d) => join(SRC_DIR, d.name))
    .sort((a, b) => a.localeCompare(b));
}

function ruleFileLength(files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const name = relative(SRC_DIR, file).replace(/\\/g, "/");
    const cap = LEGACY_FILE_CEILINGS[name] ?? MAX_FILE_LINES;
    const count = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n").length;
    if (count > cap) {
      out.push(`R2 src/${name} is ${count} lines (ceiling ${cap}) — split into focused modules`);
    }
  }
  return out;
}

function resolveLocalModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = base.endsWith(".ts") ? [base] : [`${base}.ts`, join(base, "index.ts")];
  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function runtimeImports(file: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const code = readFileSync(file, "utf8");
  const scanned = transpiler.scan(code);
  const deps = new Set<string>();
  for (const imp of scanned.imports) {
    if (imp.kind !== "import-statement") continue;
    const target = resolveLocalModule(file, imp.path);
    if (target) deps.add(target);
  }
  return [...deps].sort((a, b) => a.localeCompare(b));
}

function findCycleFrom(
  start: string,
  graph: Map<string, string[]>,
  node: string,
  chain: string[],
  onStack: Set<string>,
): string[] | null {
  for (const dep of graph.get(node) ?? []) {
    if (dep === start) return [...chain, dep];
    if (!onStack.has(dep) && graph.has(dep)) {
      const sub = findCycleFrom(start, graph, dep, [...chain, dep], new Set([...onStack, dep]));
      if (sub) return sub;
    }
  }
  return null;
}

function ruleImportCycles(files: string[]): string[] {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    graph.set(file, runtimeImports(file));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    const cycle = findCycleFrom(file, graph, file, [file], new Set([file]));
    if (!cycle) continue;
    const labels = cycle.map((p) => relative(SRC_DIR, p).replace(/\\/g, "/"));
    const key = [...new Set(labels)].sort().join("|");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(`R3 circular import in src/: ${labels.join(" -> ")}`);
    }
  }
  return out;
}

function checkTextHygiene(filePath: string): string[] {
  const rel = relative(ROOT, filePath).replace(/\\/g, "/");
  const text = readFileSync(filePath, "utf8");
  const out: string[] = [];
  if (/^(<{7} |={7}$|>{7} )/m.test(text)) {
    out.push(`R8 unresolved git merge conflict marker in ${rel}`);
  }
  return out;
}

function ruleRepoHygiene(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(ROOT)) {
    if (/^test-.*\.db(-shm|-wal)?$/i.test(entry) || entry.startsWith(".osv")) {
      out.push(`R8 stray temporary artifact '${entry}' in repository root`);
    }
  }
  for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(...checkTextHygiene(join(SRC_DIR, entry.name)));
    }
  }
  return out;
}

function main(): number {
  if (process.argv.includes("--write-agents")) {
    const sync = syncAgentsModules();
    if (sync.error) {
      console.error(sync.error);
      return 2;
    }
  }

  const files = productionSrcFiles();
  const violations = [
    ...ruleFileLength(files),
    ...ruleImportCycles(files),
    ...checkAgentsModules(),
    ...ruleRepoHygiene(),
  ];

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ pass: violations.length === 0, violations }));
    return violations.length === 0 ? 0 : 1;
  }

  for (const v of violations) console.error(`  [X] ${v}`);
  if (violations.length > 0) {
    console.error(`\nquality gate FAILED (${violations.length} violation(s)).`);
    return 1;
  }
  console.log(
    `  [OK] quality gate passed (${files.length} src modules, 0 cycles, AGENTS.md synced)`,
  );
  return 0;
}

process.exit(main());
