// Decoder for the typed values that vm/qeval_json returns:
//
//   {"results":[{"T":{"@type":"/gno.RefType","ID":"…BallotView"},
//                "V":{"@type":"/gno.StructValue","Fields":[…]}}]}
//
// Struct fields are positional, integers are 8-byte little-endian base64 in
// `N`, and zero values omit `N`/`V`. Decoding is driven by a schema for the
// exact view the caller expects: every type ID is checked, slices have a
// maximum length, and object references are rejected rather than followed.

import { decodeN } from "./encoding.ts";
import { isObject } from "./rpc.ts";

export type Schema =
  | { kind: "string" }
  | { kind: "bool" }
  /** int, int32 or int64; decoded to a number, rejected outside the safe range. */
  | { kind: "int"; bits: 32 | 64 | 0 }
  /** uint64, decoded to a decimal string so IDs never lose precision. */
  | { kind: "uint64" }
  | { kind: "address" }
  /** A named integer type; decoded to the name at that index. */
  | { kind: "enum"; type: string; names: readonly string[] }
  | { kind: "slice"; elem: Schema; max: number }
  | { kind: "struct"; type: string; fields: ReadonlyArray<readonly [string, Schema]> };

export type Decoded<S extends Schema> = S extends { kind: "string" | "address" | "uint64" }
  ? string
  : S extends { kind: "bool" }
    ? boolean
    : S extends { kind: "int" }
      ? number
      : S extends { kind: "enum"; names: readonly (infer N)[] }
        ? N
        : S extends { kind: "slice"; elem: infer E extends Schema }
          ? Decoded<E>[]
          : S extends { kind: "struct"; fields: ReadonlyArray<readonly [string, Schema]> }
            ? { [F in S["fields"][number] as F[0]]: Decoded<F[1]> }
            : never;

export class DecodeError extends Error {
  constructor(path: string, message: string) {
    super(`${path || "result"}: ${message}`);
    this.name = "DecodeError";
  }
}

export interface DecodeLimits {
  /** Total typed values visited across the whole result. */
  maxNodes: number;
}

export const DEFAULT_DECODE_LIMITS: DecodeLimits = { maxNodes: 50_000 };

// Gno primitive type codes (gnovm PrimitiveType bit flags) as they appear on
// the wire.
const PRIM = { bool: "4", string: "16", int: "32", int32: "512", int64: "1024", uint64: "65536" } as const;

/**
 * Decodes a qeval_json payload (the UTF-8 text of `{"results":[…]}`) into one
 * value per expected result.
 */
export function decodeResults<const S extends readonly Schema[]>(
  json: string,
  schemas: S,
  limits: DecodeLimits = DEFAULT_DECODE_LIMITS,
): { [K in keyof S]: Decoded<S[K]> } {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new DecodeError("", "not JSON");
  }
  const results = isObject(doc) ? doc.results : undefined;
  if (!Array.isArray(results)) throw new DecodeError("", "expected {results: [...]}");
  if (results.length !== schemas.length) {
    throw new DecodeError("", `expected ${schemas.length} results, got ${results.length}`);
  }
  const budget = { left: limits.maxNodes };
  return schemas.map((s, i) => decodeValue(results[i], s, `results[${i}]`, budget)) as {
    [K in keyof S]: Decoded<S[K]>;
  };
}

function decodeValue(tv: unknown, s: Schema, path: string, budget: { left: number }): unknown {
  if (--budget.left < 0) throw new DecodeError(path, "result is too large");
  if (!isObject(tv)) throw new DecodeError(path, "expected a typed value");
  const t = tv.T;
  const v = tv.V;
  if (isObject(v) && v["@type"] === "/gno.RefValue") throw new DecodeError(path, "object references are not followed");

  switch (s.kind) {
    case "string":
      expectPrim(t, PRIM.string, path);
      return stringValue(v, path);
    case "bool":
      expectPrim(t, PRIM.bool, path);
      return decodeN(optString(tv.N, path), false) !== 0n;
    case "int": {
      const code = s.bits === 32 ? PRIM.int32 : s.bits === 64 ? PRIM.int64 : PRIM.int;
      expectPrim(t, code, path);
      return safeNumber(decodeN(optString(tv.N, path), true), path);
    }
    case "uint64":
      expectPrim(t, PRIM.uint64, path);
      return decodeN(optString(tv.N, path), false).toString();
    case "address":
      expectRef(t, ".uverse.address", path);
      return stringValue(v, path);
    case "enum": {
      expectRef(t, s.type, path);
      const n = decodeN(optString(tv.N, path), true);
      const name = n >= 0n && n < BigInt(s.names.length) ? s.names[Number(n)] : undefined;
      if (name === undefined) throw new DecodeError(path, `unknown ${s.type} value ${n}`);
      return name;
    }
    case "slice": {
      if (!isObject(t) || t["@type"] !== "/gno.SliceType") throw new DecodeError(path, "expected a slice");
      if (v === undefined) return [];
      if (!isObject(v) || v["@type"] !== "/gno.SliceValue") throw new DecodeError(path, "expected a slice value");
      const base = v.Base;
      if (!isObject(base) || base["@type"] !== "/gno.ArrayValue" || !Array.isArray(base.List)) {
        throw new DecodeError(path, "unsupported slice backing");
      }
      const off = Number(v.Offset ?? "0");
      const len = Number(v.Length ?? "0");
      if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off < 0 || len < 0 || off + len > base.List.length) {
        throw new DecodeError(path, "slice bounds out of range");
      }
      if (len > s.max) throw new DecodeError(path, `more than ${s.max} items`);
      return base.List.slice(off, off + len).map((item, i) => decodeValue(item, s.elem, `${path}[${i}]`, budget));
    }
    case "struct": {
      expectRef(t, s.type, path);
      if (v === undefined) {
        // A zero struct: every field takes its zero value.
        return Object.fromEntries(s.fields.map(([name, fs]) => [name, zeroOf(fs)]));
      }
      if (!isObject(v) || v["@type"] !== "/gno.StructValue" || !Array.isArray(v.Fields)) {
        throw new DecodeError(path, "expected a struct value");
      }
      if (v.Fields.length !== s.fields.length) {
        throw new DecodeError(path, `${s.type} has ${v.Fields.length} fields, expected ${s.fields.length}`);
      }
      const fields = v.Fields as unknown[];
      return Object.fromEntries(s.fields.map(([name, fs], i) => [name, decodeValue(fields[i], fs, `${path}.${name}`, budget)]));
    }
  }
}

function zeroOf(s: Schema): unknown {
  switch (s.kind) {
    case "string":
    case "address":
      return "";
    case "bool":
      return false;
    case "int":
      return 0;
    case "uint64":
      return "0";
    case "enum":
      return s.names[0];
    case "slice":
      return [];
    case "struct":
      return Object.fromEntries(s.fields.map(([n, fs]) => [n, zeroOf(fs)]));
  }
}

function expectPrim(t: unknown, code: string, path: string) {
  if (!isObject(t) || t["@type"] !== "/gno.PrimitiveType" || t.value !== code) {
    throw new DecodeError(path, `expected primitive type ${code}, got ${JSON.stringify(t)}`);
  }
}

function expectRef(t: unknown, id: string, path: string) {
  if (!isObject(t) || t["@type"] !== "/gno.RefType" || t.ID !== id) {
    throw new DecodeError(path, `expected type ${id}, got ${JSON.stringify(t)}`);
  }
}

function stringValue(v: unknown, path: string): string {
  if (v === undefined) return "";
  if (!isObject(v) || v["@type"] !== "/gno.StringValue" || typeof v.value !== "string") {
    throw new DecodeError(path, "expected a string value");
  }
  return v.value;
}

function optString(n: unknown, path: string): string | undefined {
  if (n === undefined) return undefined;
  if (typeof n !== "string") throw new DecodeError(path, "expected base64 in N");
  return n;
}

function safeNumber(n: bigint, path: string): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DecodeError(path, "integer outside the safe range");
  }
  return Number(n);
}
