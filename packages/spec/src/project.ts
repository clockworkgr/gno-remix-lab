import { z } from "zod";
import { RULE_ORDER, realmPathSchema, ruleSchema, type RecipeManifest, type Rule } from "./catalog.ts";

/**
 * Text that ends up in a Gno string literal and on rendered pages: no
 * control characters, no lone surrogates, bounded length.
 */
const safeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.isWellFormed(), "contains a lone surrogate")
    .refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(s), "contains control characters");

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const clubPollConfigSchema = z
  .strictObject({
    membership: z.strictObject({
      joinMode: z.enum(["invitation", "open"]),
      maxMembers: int(1, 1000),
    }),
    ballots: z.strictObject({
      eligibility: z.enum(["members", "public"]),
      quorumPercent: int(0, 100),
      allowAbstain: z.boolean(),
      maxBallots: int(1, 1000),
      maxOptions: int(2, 20),
      minDurationSeconds: int(60, 365 * 24 * 3600),
      maxDurationSeconds: int(60, 365 * 24 * 3600),
      maxTitleBytes: int(1, 512),
      maxOptionBytes: int(1, 512),
    }),
    rules: z.record(z.string(), ruleSchema),
  })
  .superRefine((c, ctx) => {
    if (c.ballots.minDurationSeconds > c.ballots.maxDurationSeconds) {
      ctx.addIssue({ code: "custom", path: ["ballots", "minDurationSeconds"], message: "must not exceed maxDurationSeconds" });
    }
    if (c.ballots.eligibility === "public" && c.ballots.quorumPercent !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["ballots", "quorumPercent"],
        message: "public polls have no fixed electorate, so a percentage quorum is not available",
      });
    }
  });
export type ClubPollConfig = z.infer<typeof clubPollConfigSchema>;

const GO_KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto",
  "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
]);

// Predeclared identifiers and names the generated code uses itself; a form
// field becomes a function parameter, so it must not shadow any of them.
const RESERVED_IDENTS = new Set([
  "any", "bool", "byte", "comparable", "complex64", "complex128", "error", "float32", "float64", "int", "int8",
  "int16", "int32", "int64", "rune", "string", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "true",
  "false", "iota", "nil", "append", "cap", "clear", "close", "complex", "copy", "delete", "imag", "len", "make",
  "max", "min", "new", "panic", "print", "println", "real", "recover", "address", "realm", "cross", "cur", "id",
  "actor", "answers", "core", "entries", "forms", "members", "membership", "policies", "policy", "render", "strconv",
  "strings", "time",
]);

/** Whether name can be a Gno package name. */
export function isPackageName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/.test(name) && !GO_KEYWORDS.has(name);
}

/** Whether name can be a form field name (and generated parameter name). */
export function isFieldName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,31}$/.test(name) && !GO_KEYWORDS.has(name) && !RESERVED_IDENTS.has(name);
}

const fieldBase = {
  name: z.string().refine(isFieldName, "expected a lowercase identifier that is not a reserved word"),
  label: safeText(80),
  required: z.boolean(),
};

export const formFieldSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...fieldBase, kind: z.literal("text"), maxBytes: int(1, 2048), multiline: z.boolean() }),
  z.strictObject({
    ...fieldBase,
    kind: z.literal("integer"),
    min: int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    max: int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ ...fieldBase, kind: z.literal("choice"), choices: z.array(safeText(80)).min(2).max(20) }),
]);
export type FormField = z.infer<typeof formFieldSchema>;

const membershipConfigSchema = z.strictObject({
  joinMode: z.enum(["invitation", "open"]),
  maxMembers: int(1, 1000),
});

const formConfigSchema = z.strictObject({
  fields: z.array(formFieldSchema).min(1).max(10),
  /** A required text field shown as each entry's title. */
  titleField: z.string(),
  maxSubmissions: int(1, 1000),
  /** 0 means no per-address limit beyond maxSubmissions. */
  maxPerSubmitter: int(0, 1000),
  maxPayloadBytes: int(1, 8192),
});
export type FormConfig = z.infer<typeof formConfigSchema>;

function checkForm(form: FormConfig, ctx: z.RefinementCtx, maxTitleBytes = 2048) {
  const seen = new Set<string>();
  form.fields.forEach((f, i) => {
    const at = ["form", "fields", i];
    if (seen.has(f.name)) ctx.addIssue({ code: "custom", path: [...at, "name"], message: `duplicate field ${f.name}` });
    seen.add(f.name);
    if (f.kind === "integer" && f.min > f.max) {
      ctx.addIssue({ code: "custom", path: [...at, "min"], message: "must not exceed max" });
    }
    if (f.kind === "choice" && new Set(f.choices).size !== f.choices.length) {
      ctx.addIssue({ code: "custom", path: [...at, "choices"], message: "choices must be distinct" });
    }
  });
  const title = form.fields.find((f) => f.name === form.titleField);
  if (!title || title.kind !== "text" || !title.required || title.multiline) {
    ctx.addIssue({ code: "custom", path: ["form", "titleField"], message: "must name a required single-line text field" });
  } else if (title.maxBytes > maxTitleBytes) {
    ctx.addIssue({
      code: "custom",
      path: ["form", "titleField"],
      message: `the title field may be at most ${maxTitleBytes} bytes in this recipe`,
    });
  }
}

export const directoryConfigSchema = z
  .strictObject({
    membership: membershipConfigSchema,
    form: formConfigSchema,
    rules: z.record(z.string(), ruleSchema),
  })
  .superRefine((c, ctx) => checkForm(c.form, ctx));
export type DirectoryConfig = z.infer<typeof directoryConfigSchema>;

/** Contest entry titles become ballot options: "#<id> <title>". */
export const CONTEST_MAX_TITLE_BYTES = 256;

export const contestConfigSchema = z
  .strictObject({
    membership: membershipConfigSchema,
    form: formConfigSchema,
    contest: z.strictObject({
      /** Admitted entries, which become the ballot's options. */
      maxEntries: int(2, 20),
      eligibility: z.enum(["members", "public"]),
      quorumPercent: int(0, 100),
      minDurationSeconds: int(60, 365 * 24 * 3600),
      maxDurationSeconds: int(60, 365 * 24 * 3600),
    }),
    rules: z.record(z.string(), ruleSchema),
  })
  .superRefine((c, ctx) => {
    checkForm(c.form, ctx, CONTEST_MAX_TITLE_BYTES);
    if (c.contest.minDurationSeconds > c.contest.maxDurationSeconds) {
      ctx.addIssue({ code: "custom", path: ["contest", "minDurationSeconds"], message: "must not exceed maxDurationSeconds" });
    }
    if (c.contest.eligibility === "public" && c.contest.quorumPercent !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["contest", "quorumPercent"],
        message: "public voting has no fixed electorate, so a percentage quorum is not available",
      });
    }
    if (c.contest.maxEntries > c.form.maxSubmissions) {
      ctx.addIssue({ code: "custom", path: ["contest", "maxEntries"], message: "must not exceed form.maxSubmissions" });
    }
  });
export type ContestConfig = z.infer<typeof contestConfigSchema>;

const appSchema = z.strictObject({
  /** Final realm path. Drafts may use a placeholder namespace. */
  pkgPath: realmPathSchema.refine(
    (p) => isPackageName(p.slice(p.lastIndexOf("/") + 1)),
    "the last path element must be a valid package name (lowercase, not a Go keyword)",
  ),
  title: safeText(60),
});

const recipeRef = <T extends string>(id: T) =>
  z.strictObject({ id: z.literal(id), version: z.string().regex(/^\d+\.\d+\.\d+$/) });

const projectBase = {
  schemaVersion: z.literal(1),
  app: appSchema,
  network: z.string().min(1).max(32),
};

export const clubPollProjectSchema = z.strictObject({
  ...projectBase,
  recipe: recipeRef("club-poll"),
  config: clubPollConfigSchema,
});
export const directoryProjectSchema = z.strictObject({
  ...projectBase,
  recipe: recipeRef("community-directory"),
  config: directoryConfigSchema,
});
export const contestProjectSchema = z.strictObject({
  ...projectBase,
  recipe: recipeRef("demo-contest"),
  config: contestConfigSchema,
});
export type ClubPollProject = z.infer<typeof clubPollProjectSchema>;
export type DirectoryProject = z.infer<typeof directoryProjectSchema>;
export type ContestProject = z.infer<typeof contestProjectSchema>;
export type ProjectSpec = ClubPollProject | DirectoryProject | ContestProject;

const PROJECT_SCHEMAS = {
  "club-poll": clubPollProjectSchema,
  "community-directory": directoryProjectSchema,
  "demo-contest": contestProjectSchema,
} as const;
export const RECIPE_IDS = Object.keys(PROJECT_SCHEMAS) as Array<keyof typeof PROJECT_SCHEMAS>;

export interface Diagnostic {
  path: string;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; diagnostics: Diagnostic[] };

/** Parses an untrusted project document. Unknown fields are rejected. */
export function parseProject(input: unknown): ParseResult<ProjectSpec> {
  const id = (input as { recipe?: { id?: unknown } } | null)?.recipe?.id;
  const schema = typeof id === "string" && Object.hasOwn(PROJECT_SCHEMAS, id)
    ? PROJECT_SCHEMAS[id as keyof typeof PROJECT_SCHEMAS]
    : undefined;
  if (!schema) {
    return { ok: false, diagnostics: [{ path: "recipe.id", message: `expected one of: ${RECIPE_IDS.join(", ")}` }] };
  }
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    diagnostics: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}

/**
 * Checks a project's rules against its recipe: every operation the recipe
 * defines must be present, none may be unknown, and none may be more
 * permissive than its floor.
 */
export function checkRules(spec: ProjectSpec, recipe: RecipeManifest): Diagnostic[] {
  const out: Diagnostic[] = [];
  const active = activeOperations(spec, recipe);
  const known = new Set(active.map((o) => o.op));
  for (const op of Object.keys(spec.config.rules)) {
    if (!known.has(op)) out.push({ path: `config.rules.${op}`, message: "not an operation of this recipe configuration" });
  }
  for (const o of active) {
    const rule = spec.config.rules[o.op];
    if (rule === undefined) {
      out.push({ path: `config.rules.${o.op}`, message: "missing rule" });
    } else if (ruleRank(rule) < ruleRank(o.floor)) {
      out.push({ path: `config.rules.${o.op}`, message: `may not be more permissive than "${o.floor}"` });
    }
  }
  return out;
}

/** Operations that apply to this configuration (invitations need invitation mode). */
export function activeOperations(spec: ProjectSpec, recipe: RecipeManifest): RecipeManifest["operations"] {
  return recipe.operations.filter((o) => !(o.op === "members.invite" && spec.config.membership.joinMode !== "invitation"));
}

export function ruleRank(r: Rule): number {
  return RULE_ORDER.indexOf(r);
}
