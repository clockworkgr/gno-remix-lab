import { bundleDigest, canonicalJson, configDigest, parseProject, type Catalog, type ClubPollProject, type ContestProject, type Diagnostic, type DirectoryProject, type ProjectSpec } from "@remixlab/spec";
import { resolve, type Lockfile } from "@remixlab/resolver";
import { clubPollFiles } from "./recipes/clubpoll.ts";
import { contestFiles } from "./recipes/contest.ts";
import { directoryFiles } from "./recipes/directory.ts";

export { gnoString, gnoInt, gnoBool, gnoPackageName, gnoPkgPath } from "./gno.ts";

export const GENERATOR_VERSION = "0.1.0";

export interface Generated {
  spec: ProjectSpec;
  lock: Lockfile;
  /** Files deployed on chain: gnomod.toml and non-test .gno files. */
  runtime: Record<string, string>;
  /** Generated tests; part of the export, never of the on-chain payload. */
  tests: Record<string, string>;
  configDigest: string;
  runtimeDigest: string;
  supported: boolean;
  warnings: Diagnostic[];
}

export type GenerateResult = { ok: true; value: Generated } | { ok: false; diagnostics: Diagnostic[] };

/**
 * Turns an untrusted project document into Gno source. Identical input,
 * catalog and generator version always produce byte-identical files.
 */
export function generate(input: unknown, catalog: Catalog): GenerateResult {
  const parsed = parseProject(input);
  if (!parsed.ok) return parsed;
  const spec = parsed.value;

  const resolved = resolve(spec, catalog);
  if (!resolved.ok) return resolved;
  const { lock, supported, warnings } = resolved.value;

  const recipe = catalog.recipes.get(spec.recipe.id)!;
  const digest = configDigest(spec);

  // TypeScript does not narrow on the nested recipe id; parseProject
  // guarantees that config matches it.
  let files: Record<string, string>;
  switch (spec.recipe.id) {
    case "club-poll":
      files = clubPollFiles({ spec: spec as ClubPollProject, recipe, lock, configDigest: digest });
      break;
    case "community-directory":
      files = directoryFiles({ spec: spec as DirectoryProject, recipe, lock, configDigest: digest });
      break;
    case "demo-contest":
      files = contestFiles({ spec: spec as ContestProject, recipe, lock, configDigest: digest });
      break;
  }

  const runtime: Record<string, string> = {};
  const tests: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) {
    (name.endsWith("_test.gno") ? tests : runtime)[name] = files[name]!;
  }

  return {
    ok: true,
    value: {
      spec,
      lock,
      runtime,
      tests,
      configDigest: digest,
      runtimeDigest: bundleDigest(runtime),
      supported,
      warnings,
    },
  };
}

/**
 * The downloadable project: runtime files, tests, the project document, the
 * lockfile, provenance and deployment instructions.
 */
export function exportProject(g: Generated): Record<string, string> {
  const pretty = (v: unknown) => JSON.stringify(JSON.parse(canonicalJson(v)), null, 2) + "\n";
  const provenance = {
    generator: { name: "@remixlab/generator", version: GENERATOR_VERSION },
    recipe: g.lock.recipe,
    configDigest: g.configDigest,
    runtimeDigest: g.runtimeDigest,
    runtimeDigestFormat: "remixlab-bundle-v1",
    supported: g.supported,
    components: g.lock.components.map((c) => ({ id: c.id, version: c.version, pkgPath: c.pkgPath, lifecycle: c.lifecycle })),
    thirdParty: g.lock.thirdParty,
  };
  return {
    ...g.runtime,
    ...g.tests,
    "remix.project.json": pretty(g.spec),
    "remix.lock.json": pretty(g.lock),
    "remix.provenance.json": pretty(provenance),
    "DEPLOY.md": deployInstructions(g),
  };
}

function deployInstructions(g: Generated): string {
  const pkg = g.spec.app.pkgPath;
  const deps = [...g.lock.components.map((c) => c.pkgPath), ...g.lock.thirdParty].sort();
  return `# Deploying ${g.spec.app.title}

Network profile: \`${g.lock.network.id}\` (chain ID \`${g.lock.network.chainId}\`)
Realm path: \`${pkg}\`
Runtime digest: \`${g.runtimeDigest}\`
${g.supported ? "" : "\n**Not a publicly supported deployment:** it uses draft components or an unverified network.\n"}
## 1. Check dependencies

Every package below must already exist on the target chain:

${deps.map((d) => `- \`${d}\``).join("\n")}

\`\`\`sh
gnokey query vm/qfile --data '${deps[0]}' --remote <rpc>
\`\`\`

## 2. Test locally

\`\`\`sh
gno test .
\`\`\`

## 3. Deploy

Deploy from your own key; the deployer becomes the app's first owner.
Adjust gas to the network's current parameters.

\`gnokey maketx addpkg -pkgdir\` uploads every .gno file in the directory,
tests included, so copy the runtime files into a separate directory first:

\`\`\`sh
mkdir -p ../deploy && cp gnomod.toml ${Object.keys(g.runtime).filter((f) => f.endsWith(".gno")).join(" ")} ../deploy/
gnokey maketx addpkg \\
  -pkgdir ../deploy \\
  -pkgpath ${pkg} \\
  -gas-fee 1000000ugnot -gas-wanted 60000000 \\
  -chainid ${g.lock.network.chainId} -remote <rpc> -broadcast \\
  <your-key>
\`\`\`

Only gnomod.toml and the non-test .gno files are part of the on-chain
package and its runtime digest. Test files and remix.*.json stay local.
`;
}
