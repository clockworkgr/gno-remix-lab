import { type ProjectSpec, type RecipeManifest, type Rule } from "@remixlab/spec";
import { pkgPathOf, type Lockfile } from "@remixlab/resolver";
import { gnoPackageName, gnoPkgPath, gnoString, tomlString } from "../gno.ts";

export interface RecipeInput<S extends ProjectSpec = ProjectSpec> {
  spec: S;
  recipe: RecipeManifest;
  lock: Lockfile;
  configDigest: string;
}

export const RULE_CONST: Record<Rule, string> = {
  public: "policies.RulePublic",
  member: "policies.RuleMember",
  reviewer: "policies.RuleReviewer",
  owner: "policies.RuleOwner",
  nobody: "policies.RuleNobody",
};

/** An import block: standard library first, then pinned packages, each sorted. */
export function imports(lock: Lockfile, ids: string[], std: string[] = [], extraPkgs: string[] = []): string {
  const stdLines = std.map((p) => `\t"${p}"`);
  const pkgs = [...ids.map((id) => pkgPathOf(lock, id)), ...extraPkgs].map((p) => `\t"${gnoPkgPath(p)}"`).sort();
  const groups = [stdLines, pkgs].filter((g) => g.length > 0).map((g) => g.join("\n"));
  return `import (\n${groups.join("\n\n")}\n)`;
}

/** Lines of a const block with values aligned the way gno fmt aligns them. */
export function alignConsts(pairs: Array<[name: string, value: string]>): string[] {
  const width = Math.max(...pairs.map(([n]) => n.length));
  return pairs.map(([n, v]) => `\t${n.padEnd(width)} = ${v}`);
}

export function gnomod({ spec }: RecipeInput): string {
  return `module = ${tomlString(gnoPkgPath(spec.app.pkgPath))}\ngno = "0.9"\n`;
}

export function packageName(spec: ProjectSpec): string {
  return gnoPackageName(spec.app.pkgPath.slice(spec.app.pkgPath.lastIndexOf("/") + 1));
}

export function descriptor({ spec, recipe, lock, configDigest }: RecipeInput): string {
  const components = recipe.components.map((r) => `\t\t\t${gnoString(`${r.id}@${r.version}`)},`).sort();
  return `package ${packageName(spec)}

import "${gnoPkgPath(pkgPathOf(lock, "core"))}"

// configDigest is the canonical digest of the project configuration that
// produced this realm.
const configDigest = ${gnoString(configDigest)}

// Descriptor identifies this app's recipe and components.
func Descriptor() core.AppDescriptor {
	return core.AppDescriptor{
		Recipe:        recipeID,
		RecipeVersion: recipeVersion,
		Components: []string{
${components.join("\n")}
		},
		ConfigDigest:      configDigest,
		ViewSchemaVersion: core.ViewSchemaVersion,
		Bindings:          []string{"membership.read/v1=" + pkgPath},
	}
}
`;
}
