import { checkRules, type Catalog, type ComponentManifest, type Diagnostic, type Lifecycle, type ProjectSpec } from "@remixlab/spec";

export interface LockedComponent {
  id: string;
  version: string;
  pkgPath: string;
  source: string;
  lifecycle: Lifecycle;
}

/** The exact dependency set a project generates against. */
export interface Lockfile {
  lockVersion: 1;
  network: { id: string; chainId: string; verified: boolean };
  recipe: { id: string; version: string };
  /** Recipe components and their transitive component dependencies, by id. */
  components: LockedComponent[];
  /** Third-party packages the runtime imports, sorted. */
  thirdParty: string[];
}

export interface Resolution {
  lock: Lockfile;
  /**
   * False when anything in the set is unreviewed draft or the network is not
   * verified: the project can be previewed and exported, but it is not a
   * publicly supported deployment.
   */
  supported: boolean;
  warnings: Diagnostic[];
}

export type ResolveResult = { ok: true; value: Resolution } | { ok: false; diagnostics: Diagnostic[] };

export function resolve(spec: ProjectSpec, catalog: Catalog): ResolveResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  const recipe = catalog.recipes.get(spec.recipe.id);
  if (!recipe) return fail("recipe.id", `unknown recipe ${spec.recipe.id}`);
  if (recipe.version !== spec.recipe.version) {
    return fail("recipe.version", `recipe ${recipe.id}@${spec.recipe.version} is not in this catalog (available: ${recipe.version})`);
  }
  if (recipe.lifecycle === "withdrawn") return fail("recipe.id", `recipe ${recipe.id} has been withdrawn from new compositions`);

  const network = catalog.networks.get(spec.network);
  if (!network) return fail("network", `unknown network profile ${spec.network}`);
  if (!network.verified) {
    warnings.push({ path: "network", message: `${network.id} has not passed the compatibility suite yet` });
  }

  errors.push(...checkRules(spec, recipe));

  // Collect the transitive component closure.
  const closure = new Map<string, ComponentManifest>();
  const visit = (id: string, via: string) => {
    if (closure.has(id)) return;
    const c = catalog.components.get(id);
    if (!c) {
      errors.push({ path: via, message: `unknown component ${id}` });
      return;
    }
    closure.set(id, c);
    for (const dep of c.componentDependencies) visit(dep, `components.${id}`);
  };
  for (const ref of recipe.components) visit(ref.id, "recipe.components");

  const components: LockedComponent[] = [];
  const thirdParty = new Set<string>();
  for (const c of [...closure.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const at = `components.${c.id}`;
    if (c.lifecycle === "withdrawn") errors.push({ path: at, message: `${c.id} has been withdrawn from new compositions` });
    if (c.lifecycle === "deprecated") warnings.push({ path: at, message: `${c.id}@${c.catalogVersion} is deprecated` });
    if (c.lifecycle === "draft") {
      if (!network.allowDraftComponents) {
        errors.push({ path: at, message: `${c.id}@${c.catalogVersion} is a draft and cannot be used on ${network.id}` });
      } else {
        warnings.push({ path: at, message: `${c.id}@${c.catalogVersion} is a draft release` });
      }
    }
    const pkgPath = c.packages[network.id];
    if (!pkgPath) {
      errors.push({ path: at, message: `${c.id}@${c.catalogVersion} is not published on ${network.id}` });
      continue;
    }
    for (const dep of c.dependencies) {
      if (!network.availablePackages.includes(dep)) {
        errors.push({ path: at, message: `${c.id} imports ${dep}, which is not known to exist on ${network.id}` });
      }
      thirdParty.add(dep);
    }
    components.push({ id: c.id, version: c.catalogVersion, pkgPath, source: c.source, lifecycle: c.lifecycle });
  }

  if (errors.length > 0) return { ok: false, diagnostics: errors };

  const supported = network.verified && components.every((c) => c.lifecycle === "reviewed" || c.lifecycle === "published");
  return {
    ok: true,
    value: {
      lock: {
        lockVersion: 1,
        network: { id: network.id, chainId: network.chainId, verified: network.verified },
        recipe: { id: recipe.id, version: recipe.version },
        components,
        thirdParty: [...thirdParty].sort(),
      },
      supported,
      warnings,
    },
  };
}

/** Looks up the package path the lockfile pinned for a component. */
export function pkgPathOf(lock: Lockfile, id: string): string {
  const c = lock.components.find((x) => x.id === id);
  if (!c) throw new Error(`component ${id} is not in the lockfile`);
  return c.pkgPath;
}

function fail(path: string, message: string): ResolveResult {
  return { ok: false, diagnostics: [{ path, message }] };
}
