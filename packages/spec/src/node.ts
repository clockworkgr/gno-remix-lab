import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog } from "./build.ts";
import type { Catalog } from "./catalog.ts";

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
