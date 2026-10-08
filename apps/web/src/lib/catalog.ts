// The catalog and Gno sources, bundled from the repository at build time.
import { buildCatalog, type Catalog, type ComponentManifest, type NetworkProfile, type RecipeManifest } from "@remixlab/spec";

const json = (m: Record<string, unknown>) =>
  Object.keys(m)
    .sort()
    .map((k) => m[k]);

const components = import.meta.glob("../../../../catalog/components/*.json", { eager: true, import: "default" });
const recipes = import.meta.glob("../../../../catalog/recipes/*.json", { eager: true, import: "default" });
const networks = import.meta.glob("../../../../catalog/networks/*.json", { eager: true, import: "default" });
const examples = import.meta.glob("../../../../catalog/recipes/examples/*.json", { eager: true, import: "default" });

export const catalog: Catalog = buildCatalog({ components: json(components), recipes: json(recipes), networks: json(networks) });

/** The default project for each recipe, from catalog/recipes/examples. */
export const exampleProjects: Record<string, unknown> = Object.fromEntries(
  Object.entries(examples).map(([path, doc]) => [path.split("/").pop()!.replace(/\.default\.json$/, ""), doc]),
);

export const recipeList = (): RecipeManifest[] => [...catalog.recipes.values()];
export const componentList = (): ComponentManifest[] => [...catalog.components.values()];
export const networkList = (): NetworkProfile[] => [...catalog.networks.values()];

export function network(id: string): NetworkProfile {
  const n = catalog.networks.get(id);
  if (!n) throw new Error(`unknown network ${id}`);
  return n;
}

// Raw source of every Gno package in the repository, loaded on demand.
const sources = import.meta.glob(["../../../../gno/**/*.gno", "../../../../gno/**/gnomod.toml"], {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

const PREFIX = "../../../../";

/** Files of a source directory such as "gno/p/<ns>/remixlab/core/v1", by name. */
export async function sourceFiles(dir: string): Promise<Record<string, string>> {
  const want = `${PREFIX}${dir}/`;
  const out: Record<string, string> = {};
  const names = Object.keys(sources)
    .filter((p) => p.startsWith(want) && !p.slice(want.length).includes("/"))
    .sort();
  await Promise.all(names.map(async (p) => (out[p.slice(want.length)] = await sources[p]!())));
  return out;
}

export const MAINTAINER = "g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm";
const NS = `gno.land/r/${MAINTAINER}/remixlab`;

export interface ReferenceApp {
  pkgPath: string;
  title: string;
  summary: string;
  /** Recipe this app was generated from; undefined for hand-written realms. */
  recipe?: string;
  source: string;
}

/** The maintainer's reference deployments, live on every network the catalog lists them for. */
export const referenceApps: ReferenceApp[] = [
  {
    pkgPath: `${NS}/clubpoll`,
    title: "Club poll",
    summary: "Members vote in single-choice polls. Each poll's electorate is frozen when it opens.",
    recipe: "club-poll",
    source: `gno/r/${MAINTAINER}/remixlab/clubpoll`,
  },
  {
    pkgPath: `${NS}/directory`,
    title: "Community directory",
    summary: "Anyone submits a project; reviewers accept or reject it into a public listing.",
    recipe: "community-directory",
    source: `gno/r/${MAINTAINER}/remixlab/directory`,
  },
  {
    pkgPath: `${NS}/contest`,
    title: "Demo contest",
    summary: "Entries are submitted and reviewed, then members vote on the admitted ones.",
    recipe: "demo-contest",
    source: `gno/r/${MAINTAINER}/remixlab/contest`,
  },
  {
    pkgPath: `${NS}/sharedmembers`,
    title: "Shared membership",
    summary: "A membership service that other apps read from to build poll electorates.",
    source: `gno/r/${MAINTAINER}/remixlab/sharedmembers`,
  },
  {
    pkgPath: `${NS}/sharedpoll`,
    title: "Shared-membership poll",
    summary: "A poll whose electorate comes from the shared membership service.",
    source: `gno/r/${MAINTAINER}/remixlab/sharedpoll`,
  },
];

export const referenceApp = (pkgPath: string) => referenceApps.find((a) => a.pkgPath === pkgPath);

/** The reference realm each recipe's demo runs as. */
export const recipeDemo = (recipeId: string) => referenceApps.find((a) => a.recipe === recipeId);

/** Package paths of the core, policies and forms blocks on a network, for view schemas. */
export function viewPackages(networkId: string) {
  const path = (id: string) => catalog.components.get(id)?.packages[networkId];
  const core = path("core");
  if (!core) return undefined;
  const policies = path("policies");
  const forms = path("forms");
  return { core, ...(policies ? { policies } : {}), ...(forms ? { forms } : {}) };
}
