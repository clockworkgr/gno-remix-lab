import { expectedPackageName, type ProjectSpec, type RecipeManifest, type Rule } from "@remixlab/spec";
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
  return gnoPackageName(expectedPackageName(spec.app.pkgPath));
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

/**
 * Invite and RevokeInvite for invitation-mode apps. Inviting (or revoking an
 * invitation for) a role above member also needs members.set_role, so a
 * reviewer who may invite can add members but never more reviewers or
 * owners, and cannot cancel invitations an owner issued for those roles.
 */
export const INVITE_FUNCTIONS = `
// Invite lets addr join with role. Inviting a reviewer or owner also
// requires the members.set_role permission.
func Invite(cur realm, addr address, role string) {
	actor := authorize(cur, opInvite)
	r, err := core.ParseRole(role)
	must(err)
	if r > core.RoleMember {
		must(policy.Authorize(opSetRole, actor))
	}
	must(members.Invite(addr, r))
}

// RevokeInvite cancels a pending invitation. Revoking an invitation for a
// reviewer or owner also requires the members.set_role permission.
func RevokeInvite(cur realm, addr address) {
	actor := authorize(cur, opInvite)
	if r, ok := members.InviteRole(addr); ok && r > core.RoleMember {
		must(policy.Authorize(opSetRole, actor))
	}
	must(members.RevokeInvite(addr))
}
`;

/** Read functions over pending invitations, for invitation-mode apps. */
export const INVITE_READS = `
// Invites returns up to limit pending invitations (at most 25) starting at
// offset, with the role each one grants.
func Invites(offset, limit int) []core.MemberView {
	ready()
	return members.Invites(offset, clampLimit(limit))
}
`;

/** The abort message policies.Authorize gives an actor denied op under rule. */
export function deniedMessage(op: string, rule: Rule): string {
  return rule === "nobody" ? `remix: unauthorized: ${op} is disabled` : `remix: unauthorized: ${op} requires ${rule}`;
}
