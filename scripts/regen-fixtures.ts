// Regenerates the generator-owned files of the reference realms from their
// project documents. Hand-written files in those directories (adversarial
// tests) are left alone.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog } from "@remixlab/spec/node";
import { generate } from "@remixlab/generator";

export const FIXTURES: Array<{ project: string; dir: string }> = [
  { project: "catalog/recipes/examples/club-poll.default.json", dir: "gno/r/remixlab/clubpoll" },
  { project: "catalog/recipes/examples/community-directory.default.json", dir: "gno/r/remixlab/directory" },
  { project: "catalog/recipes/examples/demo-contest.default.json", dir: "gno/r/remixlab/contest" },
];

const root = join(import.meta.dirname, "..");
const catalog = loadCatalog(join(root, "catalog"));
for (const f of FIXTURES) {
  const r = generate(JSON.parse(readFileSync(join(root, f.project), "utf8")), catalog);
  if (!r.ok) throw new Error(`${f.project}: ${JSON.stringify(r.diagnostics)}`);
  mkdirSync(join(root, f.dir), { recursive: true });
  for (const [name, content] of Object.entries({ ...r.value.runtime, ...r.value.tests })) {
    writeFileSync(join(root, f.dir, name), content);
  }
  console.log(`${f.dir}: ${r.value.runtimeDigest}`);
}
