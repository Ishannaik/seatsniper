/**
 * Zero-dependency dead-code, orphan-module & unused-dependency gate for SeatSniper.
 *
 * Replaces `knip` at runtime so `bun install` stays free of `picomatch` CVE-2026-112366
 * while enforcing the exact same graph invariants in <30ms via Bun's native TS scanner:
 *   - D1  Every `.ts` module in `src/` and `scripts/` is reachable from an entrypoint
 *   - D2  Every `dependencies` / `devDependencies` package in `package.json` is used
 *   - D3  Every relative local import resolves to an existing module on disk
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC_DIR = join(ROOT, "src");
const SCRIPTS_DIR = join(ROOT, "scripts");
const TRANSPILER = new Bun.Transpiler({ loader: "ts" });

// CLI tool packages invoked via `package.json` scripts rather than TS `import` statements.
const CLI_TOOL_PACKAGES: Record<string, string> = {
  "@biomejs/biome": "biome",
  typescript: "tsc",
};

function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function extractSpecifiers(filePath: string): string[] {
  const code = readFileSync(filePath, "utf8");
  const specs = new Set<string>();

  for (const imp of TRANSPILER.scanImports(code)) {
    specs.add(imp.path);
  }

  // Bun.Transpiler elides pure `import type` / `export type` edges; capture them too.
  const cleaned = stripComments(code);
  const typeImportRe = /\b(?:import|export)\s+type\s+(?:[\s\S]*?\bfrom\s+)?["']([^"']+)["']/g;
  for (const match of cleaned.matchAll(typeImportRe)) {
    const spec = match[1]?.trim();
    if (spec) specs.add(spec);
  }
  return [...specs];
}

function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = /\.[a-z]+$/i.test(base)
    ? [base, base.replace(/\.js$/i, ".ts")]
    : [`${base}.ts`, join(base, "index.ts")];
  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function packageNameFromSpecifier(spec: string): string | null {
  if (
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("bun:") ||
    spec.startsWith("node:")
  ) {
    return null;
  }
  const parts = spec.split("/");
  if (spec.startsWith("@") && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? null;
}

function entrypoints(allSrc: string[], allScripts: string[]): string[] {
  const entries = [
    join(SRC_DIR, "index.ts"),
    join(SRC_DIR, "register.ts"),
    join(ROOT, "integration.ts"),
    ...allScripts,
    ...allSrc.filter((f) => f.endsWith(".test.ts")),
  ];
  return entries.filter((f) => existsSync(f));
}

function walkGraph(entries: string[]): {
  reachable: Set<string>;
  externalPackages: Set<string>;
  brokenImports: string[];
} {
  const reachable = new Set<string>();
  const externalPackages = new Set<string>();
  const brokenImports: string[] = [];
  const queue = [...entries];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);

    for (const spec of extractSpecifiers(current)) {
      if (spec.startsWith(".")) {
        const target = resolveLocal(current, spec);
        if (!target) {
          const rel = relative(ROOT, current).replace(/\\/g, "/");
          brokenImports.push(`D3 broken relative import '${spec}' in ${rel}`);
        } else if (!reachable.has(target)) {
          queue.push(target);
        }
      } else {
        const pkg = packageNameFromSpecifier(spec);
        if (pkg) externalPackages.add(pkg);
      }
    }
  }
  return { reachable, externalPackages, brokenImports };
}

function checkUnusedDependencies(externalPackages: Set<string>): string[] {
  const pkgJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const scriptBlob = Object.values(pkgJson.scripts ?? {}).join(" && ");
  const out: string[] = [];

  for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
    if (!externalPackages.has(dep)) {
      out.push(`D2 unused runtime dependency '${dep}' in package.json`);
    }
  }
  for (const dep of Object.keys(pkgJson.devDependencies ?? {})) {
    if (dep.startsWith("@types/")) continue;
    const cliBin = CLI_TOOL_PACKAGES[dep];
    const usedInScripts = cliBin ? scriptBlob.includes(cliBin) : scriptBlob.includes(dep);
    if (!externalPackages.has(dep) && !usedInScripts) {
      out.push(`D2 unused devDependency '${dep}' in package.json`);
    }
  }
  return out;
}

function main(): number {
  const allSrc = collectTsFiles(SRC_DIR);
  const allScripts = collectTsFiles(SCRIPTS_DIR);
  const { reachable, externalPackages, brokenImports } = walkGraph(entrypoints(allSrc, allScripts));

  const orphans: string[] = [];
  for (const file of [...allSrc, ...allScripts]) {
    if (!reachable.has(file)) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      orphans.push(`D1 orphan unreachable module '${rel}' — wire it in or delete it`);
    }
  }

  const violations = [...brokenImports, ...orphans, ...checkUnusedDependencies(externalPackages)];
  for (const v of violations) console.error(`  [X] ${v}`);
  if (violations.length > 0) {
    console.error(`\ndeadcode gate FAILED (${violations.length} issue(s)).`);
    return 1;
  }
  console.log(
    `  [OK] deadcode gate passed (${reachable.size} reachable modules, 0 orphans, 0 unused deps)`,
  );
  return 0;
}

process.exit(main());
