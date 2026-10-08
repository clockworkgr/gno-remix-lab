// Refreshes every catalog component's sourceDigest from its source, then
// regenerates the generator-owned files of the reference realms from their
// project documents. Hand-written files in those directories (the
// <name>_test.gno adversarial tests) are left alone; any other file there
// that the generator no longer produces is deleted.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { bundleDigest } from "@remixlab/spec";
import { loadCatalog, readRuntimeFiles } from "@remixlab/spec/node";
import { generate } from "@remixlab/generator";

export const FIXTURES: Array<{ project: string; dir: string }> = [
  { project: "catalog/recipes/examples/club-poll.default.json", dir: "gno/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/clubpoll" },
  { project: "catalog/recipes/examples/community-directory.default.json", dir: "gno/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/directory" },
  { project: "catalog/recipes/examples/demo-contest.default.json", dir: "gno/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/contest" },
];

const root = join(import.meta.dirname, "..");

const componentsDir = join(root, "catalog/components");
for (const file of readdirSync(componentsDir).filter((f) => f.endsWith(".json")).sort()) {
  const path = join(componentsDir, file);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const digest = bundleDigest(readRuntimeFiles(join(root, manifest.source)));
  if (manifest.sourceDigest !== digest) {
    manifest.sourceDigest = digest;
    writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`${manifest.source}: ${digest} (updated)`);
  }
}

const catalog = loadCatalog(join(root, "catalog"));
for (const f of FIXTURES) {
  const r = generate(JSON.parse(readFileSync(join(root, f.project), "utf8")), catalog);
  if (!r.ok) throw new Error(`${f.project}: ${JSON.stringify(r.diagnostics)}`);
  mkdirSync(join(root, f.dir), { recursive: true });
  const files = { ...r.value.runtime, ...r.value.tests };
  const handWritten = `${basename(f.dir)}_test.gno`;
  for (const name of readdirSync(join(root, f.dir))) {
    if (!(name in files) && name !== handWritten) {
      rmSync(join(root, f.dir, name));
      console.log(`${f.dir}/${name}: removed (no longer generated)`);
    }
  }
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, f.dir, name), content);
  }
  console.log(`${f.dir}: ${r.value.runtimeDigest}`);
}
