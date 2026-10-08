import { z } from "zod";
import { RULE_ORDER, expectedPackageName, realmPathSchema, ruleSchema, type RecipeManifest, type Rule } from "./catalog.ts";

/** UTF-8 length of s, the unit every Gno byte limit uses. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Invisible or direction-changing format characters, matching
 * core.IsHiddenFormat in the Gno core block (ZWNJ and ZWJ are allowed).
 */
export const HIDDEN_FORMAT_RE = /[\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u;

/**
 * Text that ends up in a Gno string literal and on rendered pages: at most
 * maxBytes UTF-8 bytes, not blank, no surrounding whitespace, no control,
 * invisible or direction-changing characters, no lone surrogates. The Gno
 * blocks apply the same rules (core.CheckText).
 */
const safeText = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((s) => s.isWellFormed(), "contains a lone surrogate")
    .refine((s) => utf8Bytes(s) <= maxBytes, `must be at most ${maxBytes} bytes of UTF-8`)
    .refine((s) => s.trim() !== "", "must not be blank")
    .refine((s) => s.trim() === s, "must not start or end with whitespace")
    .refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(s), "contains control characters")
    .refine((s) => !HIDDEN_FORMAT_RE.test(s), "contains invisible or direction-changing characters");

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
  "strings", "time", "err", "ok", "authorize", "must", "ready", "setup", "init", "ballot", "ballots", "polls", "main", "url",
]);

/**
 * Whether name can be a generated app's package name: gnovm's rePkgName
 * (at least two characters), an identifier the path rules also accept, not
 * a keyword, not "main" and not a "_test" package.
 */
export function isPackageName(name: string): boolean {
  return (
    /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name) &&
    name.length >= 2 &&
    name.length <= 64 &&
    !GO_KEYWORDS.has(name) &&
    name !== "main" &&
    !name.endsWith("_test")
  );
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
  const minPayload = form.fields.reduce((n, f) => n + (f.required ? minAnswerBytes(f) : 0), 0);
  if (minPayload > form.maxPayloadBytes) {
    ctx.addIssue({
      code: "custom",
      path: ["form", "maxPayloadBytes"],
      message: `the required fields need at least ${minPayload} bytes`,
    });
  }
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

/** The shortest answer a required field accepts, in bytes. */
function minAnswerBytes(f: FormField): number {
  switch (f.kind) {
    case "text":
      return 1;
    case "integer":
      if (f.min <= 0 && f.max >= 0) return 1;
      return f.min > 0 ? String(f.min).length : String(f.max).length;
    case "choice":
      return Math.min(...f.choices.map(utf8Bytes));
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
    (p) => isPackageName(expectedPackageName(p)),
    "the app name (the last path element, or the one before a /vN suffix) must be a valid package name: lowercase letters, digits and single underscores, at least two characters, not a keyword, not main and not ending in _test",
  ),
  title: safeText(60),
});

const recipeRef = <T extends string>(id: T) =>
  z.strictObject({ id: z.literal(id), version: z.string().regex(/^\d+\.\d+\.\d+$/) });

const projectBase = {
  schemaVersion: z.literal(1),
  app: appSchema,
  network: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "expected a network profile id"),
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
  const proto = findProtoKey(input, "");
  if (proto !== undefined) {
    return { ok: false, diagnostics: [{ path: proto, message: '"__proto__" is not allowed as a key' }] };
  }
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

/** Path of the first own "__proto__" key, which schemas would drop silently. */
function findProtoKey(v: unknown, path: string): string | undefined {
  if (v === null || typeof v !== "object") return undefined;
  for (const k of Object.keys(v)) {
    const p = path === "" ? k : `${path}.${k}`;
    if (k === "__proto__") return p;
    const found = findProtoKey((v as Record<string, unknown>)[k], p);
    if (found !== undefined) return found;
  }
  return undefined;
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
    } else if (o.floor === "owner" && rule === "nobody") {
      // policies.Define panics on this, so the realm could not be deployed.
      out.push({ path: `config.rules.${o.op}`, message: "owner-level operations cannot be disabled" });
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
