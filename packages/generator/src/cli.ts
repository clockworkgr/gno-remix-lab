#!/usr/bin/env node
// remix-gen <project.json> <out-dir> [--export] [--catalog <dir>]
//
// Writes the runtime files (and generated tests) for a project. With
// --export, also writes the lockfile, provenance and deployment notes.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadCatalog } from "@remixlab/spec/node";
import { exportProject, generate } from "./index.ts";

const usage = "usage: remix-gen <project.json> <out-dir> [--export] [--catalog <dir>]";
let parsed;
try {
  parsed = parseArgs({
    strict: true,
    allowPositionals: true,
    options: { export: { type: "boolean" }, catalog: { type: "string" } },
  });
} catch (e) {
  console.error(`${(e as Error).message}\n${usage}`);
  process.exit(2);
}
if (parsed.positionals.length !== 2) {
  console.error(usage);
  process.exit(2);
}
const [projectFile, outDir] = parsed.positionals as [string, string];
const doExport = parsed.values.export === true;
const catalogDir = parsed.values.catalog ?? join(dirname(fileURLToPath(import.meta.url)), "../../../catalog");

// A stale file left in the output would be compiled by `gno test .`, so the
// output directory must be new or empty.
if (existsSync(outDir) && readdirSync(outDir).length > 0) {
  console.error(`${outDir} is not empty; choose a new directory`);
  process.exit(2);
}

let input: unknown;
try {
  input = JSON.parse(readFileSync(projectFile, "utf8"));
} catch (e) {
  console.error(`${projectFile}: ${(e as Error).message}`);
  process.exit(1);
}

const result = generate(input, loadCatalog(resolvePath(catalogDir)));
if (!result.ok) {
  for (const d of result.diagnostics) console.error(`${d.path || "(project)"}: ${d.message}`);
  process.exit(1);
}
const g = result.value;
for (const w of g.warnings) console.error(`warning: ${w.path}: ${w.message}`);

const files = doExport ? exportProject(g) : { ...g.runtime, ...g.tests };
mkdirSync(outDir, { recursive: true });
for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);

console.log(`config  ${g.configDigest}`);
console.log(`runtime ${g.runtimeDigest}`);
console.log(`wrote ${Object.keys(files).length} files to ${outDir}${g.supported ? "" : " (not a publicly supported deployment)"}`);
