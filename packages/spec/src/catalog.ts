import { z } from "zod";

// Remix Lab catalog metadata. These are project formats, not Gno standards.

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "expected MAJOR.MINOR.PATCH");
const componentId = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/, "expected a lowercase component id");
const interfaceId = z.string().regex(/^[a-z][a-z0-9.]*\/v\d+$/, "expected <name>/v<major>");
/**
 * gno.land package paths as the VM accepts them (gnovm Re_name at the pinned
 * toolchain): every element starts with a letter, continues with letters or
 * digits, and uses "_" or "-" only between alphanumerics. A namespace and a
 * name are required.
 */
export const PKG_PATH_RE = /^gno\.land\/[pr](\/[a-z][a-z0-9]*([_-][a-z0-9]+)*){2,}$/;
export const pkgPathSchema = z.string().max(256).regex(PKG_PATH_RE, "expected a gno.land /p/ or /r/ path such as gno.land/r/<namespace>/<name>");
export const realmPathSchema = pkgPathSchema.refine((p) => p.startsWith("gno.land/r/"), "expected a /r/ realm path");

const VERSION_ELEMENT = /^v(0|[1-9][0-9]*)$/;

/**
 * The package name a path's files must declare: the last element, or the
 * one before it when the last is a version suffix such as "v2".
 */
export function expectedPackageName(pkgPath: string): string {
  const parts = pkgPath.split("/");
  const last = parts[parts.length - 1] ?? "";
  return VERSION_ELEMENT.test(last) && parts.length > 4 ? (parts[parts.length - 2] ?? "") : last;
}
const networkId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

export const lifecycleSchema = z.enum(["draft", "reviewed", "published", "deprecated", "withdrawn"]);
export type Lifecycle = z.infer<typeof lifecycleSchema>;

export const componentManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: componentId,
  catalogVersion: semver,
  kind: z.enum(["library", "adapter"]),
  title: z.string().min(1).max(60),
  summary: z.string().min(1).max(280),
  provides: z.array(interfaceId),
  requires: z.array(interfaceId),
  /** Source directory in this repository, relative to the repo root. */
  source: z.string().regex(/^gno\/[pr]\/[a-z0-9_/]+$/),
  /**
   * bundleDigest of the source's runtime files: what a published package
   * must hash to. scripts/regen-fixtures.ts keeps it current.
   */
  sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** Published package path per network profile id. */
  packages: z.record(networkId, pkgPathSchema),
  /** Third-party packages imported by the runtime source. */
  dependencies: z.array(pkgPathSchema),
  /** Other catalog components imported by this one. */
  componentDependencies: z.array(componentId),
  stateOwner: z.enum(["none", "host-realm", "shared-realm"]),
  license: z.string().min(1).max(64),
  maintainer: z.string().min(1).max(120),
  lifecycle: lifecycleSchema,
  review: z.strictObject({
    status: z.enum(["unreviewed", "internal", "independent"]),
    scope: z.string().max(500),
  }),
  limits: z.record(z.string(), z.number().int()),
});
export type ComponentManifest = z.infer<typeof componentManifestSchema>;

export const ruleSchema = z.enum(["public", "member", "reviewer", "owner", "nobody"]);
export type Rule = z.infer<typeof ruleSchema>;
export const RULE_ORDER: readonly Rule[] = ["public", "member", "reviewer", "owner", "nobody"];

export const recipeManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: componentId,
  version: semver,
  title: z.string().min(1).max(60),
  summary: z.string().min(1).max(280),
  components: z.array(z.strictObject({ id: componentId, version: semver })),
  operations: z.array(
    z.strictObject({
      // Same rule as policies.checkOp: dot- or underscore-separated parts
      // that start with a letter.
      op: z.string().max(48).regex(/^[a-z][a-z0-9]*([._][a-z][a-z0-9]*)*$/),
      description: z.string().min(1).max(200),
      default: ruleSchema,
      floor: ruleSchema,
    }),
  ),
  lifecycle: lifecycleSchema,
}).superRefine((r, ctx) => {
  const ids = r.components.map((c) => c.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["components"], message: "duplicate component" });
  const seen = new Set<string>();
  r.operations.forEach((o, i) => {
    if (seen.has(o.op)) ctx.addIssue({ code: "custom", path: ["operations", i, "op"], message: `duplicate operation ${o.op}` });
    seen.add(o.op);
    if (RULE_ORDER.indexOf(o.default) < RULE_ORDER.indexOf(o.floor)) {
      ctx.addIssue({ code: "custom", path: ["operations", i, "default"], message: "default is more permissive than the floor" });
    }
    if (o.floor === "owner" && o.default === "nobody") {
      ctx.addIssue({ code: "custom", path: ["operations", i, "default"], message: "owner-level operations cannot be disabled" });
    }
  });
});
export type RecipeManifest = z.infer<typeof recipeManifestSchema>;

export const networkProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: networkId,
  title: z.string().min(1).max(60),
  // Appears in generated shell commands, so only plain characters.
  chainId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/),
  rpc: z.string().url().regex(/^https?:\/\//, "expected an http(s) URL"),
  kind: z.enum(["local", "testnet", "staging", "mainnet"]),
  /** Whether the compatibility suite has passed against this profile. */
  verified: z.boolean(),
  /** Third-party packages known to exist on this network. */
  availablePackages: z.array(pkgPathSchema),
  /** Allow draft components (local development only). */
  allowDraftComponents: z.boolean(),
}).refine((n) => n.kind === "local" || !n.allowDraftComponents, {
  path: ["allowDraftComponents"],
  message: "only local profiles may allow draft components",
});
export type NetworkProfile = z.infer<typeof networkProfileSchema>;

export interface Catalog {
  components: ReadonlyMap<string, ComponentManifest>;
  recipes: ReadonlyMap<string, RecipeManifest>;
  networks: ReadonlyMap<string, NetworkProfile>;
}
