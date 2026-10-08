#!/usr/bin/env node
// remix-gen <project.json> <out-dir> [--export] [--catalog <dir>]
//
// Writes the runtime files (and generated tests) for a project. With
// --export, also writes the lockfile, provenance and deployment notes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "@remixlab/spec/node";
import { exportProject, generate } from "./index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const doExport = args.includes("--export");
if (doExport) args.splice(args.indexOf("--export"), 1);
const catalogDir = flag("--catalog") ?? join(dirname(fileURLToPath(import.meta.url)), "../../../catalog");

if (args.length !== 2) {
  console.error("usage: remix-gen <project.json> <out-dir> [--export] [--catalog <dir>]");
  process.exit(2);
}
const [projectFile, outDir] = args as [string, string];

const result = generate(JSON.parse(readFileSync(projectFile, "utf8")), loadCatalog(resolvePath(catalogDir)));
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
