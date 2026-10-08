import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog } from "./build.ts";
import type { Catalog } from "./catalog.ts";

/** Whether a package file goes on chain: gnomod.toml and non-test .gno files. */
export function isRuntimeFile(name: string): boolean {
  return name === "gnomod.toml" || (name.endsWith(".gno") && !name.endsWith("_test.gno") && !name.endsWith("_filetest.gno"));
}

/** The runtime files of the package in dir, by name. */
export function readRuntimeFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    if (isRuntimeFile(name)) out[name] = readFileSync(join(dir, name), "utf8");
  }
  return out;
}

/** Loads and validates catalog/{components,recipes,networks}/*.json. */
export function loadCatalog(catalogDir: string): Catalog {
  const read = (sub: string) =>
    readdirSync(join(catalogDir, sub))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(catalogDir, sub, f), "utf8")) as unknown;
        } catch (e) {
          throw new Error(`${sub}/${f}: ${(e as Error).message}`);
        }
      });
  return buildCatalog({ components: read("components"), recipes: read("recipes"), networks: read("networks") });
}
