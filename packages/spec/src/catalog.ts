import { z } from "zod";

// Remix Lab catalog metadata. These are project formats, not Gno standards.

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "expected MAJOR.MINOR.PATCH");
const componentId = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/, "expected a lowercase component id");
const interfaceId = z.string().regex(/^[a-z][a-z0-9.]*\/v\d+$/, "expected <name>/v<major>");
export const pkgPathSchema = z
  .string()
  .max(256)
  .regex(/^gno\.land\/[pr]\/[a-z0-9_]+(\/[a-z0-9_]+)*$/, "expected a gno.land /p/ or /r/ path");
export const realmPathSchema = pkgPathSchema.refine((p) => p.startsWith("gno.land/r/"), "expected a /r/ realm path");
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
      op: z.string().regex(/^[a-z][a-z0-9._]{0,47}$/),
      description: z.string().min(1).max(200),
      default: ruleSchema,
      floor: ruleSchema,
    }),
  ),
  lifecycle: lifecycleSchema,
});
export type RecipeManifest = z.infer<typeof recipeManifestSchema>;

export const networkProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: networkId,
  title: z.string().min(1).max(60),
  chainId: z.string().min(1).max(50),
  rpc: z.string().url(),
  kind: z.enum(["local", "testnet", "staging", "mainnet"]),
  /** Whether the compatibility suite has passed against this profile. */
  verified: z.boolean(),
  /** Third-party packages known to exist on this network. */
  availablePackages: z.array(pkgPathSchema),
  /** Allow draft components (local development only). */
  allowDraftComponents: z.boolean(),
});
export type NetworkProfile = z.infer<typeof networkProfileSchema>;

export interface Catalog {
  components: ReadonlyMap<string, ComponentManifest>;
  recipes: ReadonlyMap<string, RecipeManifest>;
  networks: ReadonlyMap<string, NetworkProfile>;
}
