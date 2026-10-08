import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order, no
 * whitespace, integers only (configuration never needs floats), strings in
 * JSON.stringify form. Identical values always serialize to identical bytes.
 */
export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function write(value: unknown, at: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`${at}: canonical JSON allows only safe integers`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      if (!value.isWellFormed()) {
        throw new TypeError(`${at}: string contains a lone surrogate`);
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v, i) => write(v, `${at}[${i}]`)).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`${at}: only plain objects are allowed`);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + write(obj[k], `${at}.${k}`)).join(",") + "}";
    }
  }
  throw new TypeError(`${at}: unsupported value of type ${typeof value}`);
}

/** sha256 of the canonical JSON form, as "sha256:<hex>". */
export function configDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function sha256Hex(text: string | Uint8Array): string {
  const bytes = typeof text === "string" ? utf8ToBytes(text) : text;
  return "sha256:" + bytesToHex(sha256(bytes));
}

/**
 * Digest of a file bundle. Files are ordered by path; each contributes
 * "<path>\n<utf8 byte length>\n<content>\n". Version 1 of the bundle digest.
 */
export function bundleDigest(files: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  for (const path of Object.keys(files).sort()) {
    const content = files[path]!;
    parts.push(`${path}\n${utf8ToBytes(content).length}\n${content}\n`);
  }
  return sha256Hex(parts.join(""));
}
