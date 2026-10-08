// Schemas for the inert views that Remix Lab realms return, view schema
// version 1. Field order must match the Gno struct definitions exactly; a
// test compares these schemas with the Gno sources.
//
// Type IDs embed the package path the realm imported, which differs per
// network, so schemas are built from the paths in the project's lockfile.

import type { Decoded, Schema } from "./values.ts";

export const VIEW_SCHEMA_VERSION = 1;

export interface ViewPackages {
  /** e.g. "gno.land/p/remixlab/core/v1" */
  core: string;
  policies?: string;
  forms?: string;
}

const str = { kind: "string" } as const;
const bool = { kind: "bool" } as const;
const int = { kind: "int", bits: 0 } as const;
const int64 = { kind: "int", bits: 64 } as const;
const uint64 = { kind: "uint64" } as const;
const address = { kind: "address" } as const;
const strings = (max: number) => ({ kind: "slice", elem: str, max }) as const;

export function viewSchemas(p: ViewPackages) {
  const core = (name: string) => `${p.core}.${name}`;
  const role = { kind: "enum", type: core("Role"), names: ["none", "member", "reviewer", "owner"] } as const;

  const member = {
    kind: "struct",
    type: core("MemberView"),
    fields: [
      ["address", address],
      ["role", role],
    ],
  } as const;

  const ballot = {
    kind: "struct",
    type: core("BallotView"),
    fields: [
      ["id", uint64],
      ["title", str],
      ["options", strings(20)],
      ["status", { kind: "enum", type: core("BallotStatus"), names: ["draft", "open", "finalized"] }],
      ["public", bool],
      ["electorateSize", int],
      ["quorumPercent", int],
      ["openedAt", int64],
      ["deadline", int64],
      ["counts", { kind: "slice", elem: int, max: 20 }],
      ["abstentions", int],
      ["turnout", int],
      ["outcome", { kind: "enum", type: core("BallotOutcome"), names: ["pending", "winner", "tie", "no-quorum", "no-votes"] }],
      ["winner", int],
    ],
  } as const;

  const submission = {
    kind: "struct",
    type: core("SubmissionView"),
    fields: [
      ["id", uint64],
      ["submitter", address],
      ["answers", strings(10)],
      ["status", { kind: "enum", type: core("SubmissionStatus"), names: ["submitted", "accepted", "rejected"] }],
    ],
  } as const;

  const descriptor = {
    kind: "struct",
    type: core("AppDescriptor"),
    fields: [
      ["recipe", str],
      ["recipeVersion", str],
      ["components", strings(32)],
      ["configDigest", str],
      ["viewSchemaVersion", int],
      ["bindings", strings(16)],
    ],
  } as const;

  const rule = (pkg: string) =>
    ({ kind: "enum", type: `${pkg}.Rule`, names: ["public", "member", "reviewer", "owner", "nobody"] }) as const;
  const ruleView = (pkg: string) =>
    ({
      kind: "struct",
      type: `${pkg}.RuleView`,
      fields: [
        ["op", str],
        ["rule", rule(pkg)],
        ["floor", rule(pkg)],
      ],
    }) as const;

  const field = (pkg: string) =>
    ({
      kind: "struct",
      type: `${pkg}.Field`,
      fields: [
        ["name", str],
        ["label", str],
        ["kind", { kind: "enum", type: `${pkg}.FieldKind`, names: ["text", "integer", "choice"] }],
        ["required", bool],
        ["maxBytes", int],
        ["multiline", bool],
        ["min", int64],
        ["max", int64],
        ["choices", strings(20)],
      ],
    }) as const;

  return {
    member,
    members: { kind: "slice", elem: member, max: 100 } as const,
    ballot,
    ballots: { kind: "slice", elem: ballot, max: 100 } as const,
    submission,
    submissions: { kind: "slice", elem: submission, max: 100 } as const,
    descriptor,
    rules: p.policies ? ({ kind: "slice", elem: ruleView(p.policies), max: 32 } as const) : undefined,
    fields: p.forms ? ({ kind: "slice", elem: field(p.forms), max: 10 } as const) : undefined,
    string: str,
    bool,
    int,
    uint64,
    uint64s: { kind: "slice", elem: uint64, max: 100 } as const,
  } satisfies Record<string, Schema | undefined>;
}

type Schemas = ReturnType<typeof viewSchemas>;
export type MemberView = Decoded<Schemas["member"]>;
export type BallotView = Decoded<Schemas["ballot"]>;
export type SubmissionView = Decoded<Schemas["submission"]>;
export type AppDescriptor = Decoded<Schemas["descriptor"]>;
export type RuleView = Decoded<NonNullable<Schemas["rules"]>>[number];
export type FieldView = Decoded<NonNullable<Schemas["fields"]>>[number];
