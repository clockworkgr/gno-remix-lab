import {
  componentManifestSchema,
  networkProfileSchema,
  recipeManifestSchema,
  type Catalog,
  type ComponentManifest,
  type NetworkProfile,
  type RecipeManifest,
} from "./catalog.ts";

export interface RawCatalog {
  components: unknown[];
  recipes: unknown[];
  networks: unknown[];
}

/** Validates raw catalog documents and indexes them. Throws on any error. */
export function buildCatalog(raw: RawCatalog): Catalog {
  const components = index(raw.components, (d) => componentManifestSchema.parse(d), "component");
  const recipes = index(raw.recipes, (d) => recipeManifestSchema.parse(d), "recipe");
  const networks = index(raw.networks, (d) => networkProfileSchema.parse(d), "network");
  for (const c of components.values()) {
    for (const dep of c.componentDependencies) {
      if (!components.has(dep)) throw new Error(`component ${c.id}: unknown dependency ${dep}`);
    }
  }
  for (const r of recipes.values()) {
    for (const ref of r.components) {
      const c = components.get(ref.id);
      if (!c) throw new Error(`recipe ${r.id}: unknown component ${ref.id}`);
      if (c.catalogVersion !== ref.version) {
        throw new Error(`recipe ${r.id}: ${ref.id}@${ref.version} not in catalog (have ${c.catalogVersion})`);
      }
    }
  }
  return { components, recipes, networks };
}

function index<T extends ComponentManifest | RecipeManifest | NetworkProfile>(
  docs: unknown[],
  parse: (d: unknown) => T,
  kind: string,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const d of docs) {
    const v = parse(d);
    if (out.has(v.id)) throw new Error(`duplicate ${kind} ${v.id}`);
    out.set(v.id, v);
  }
  return out;
}
