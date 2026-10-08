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
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) throw new TypeError(`${at}[${i}]: arrays may not have holes`);
          items.push(write(value[i], `${at}[${i}]`));
        }
        return "[" + items.join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`${at}: only plain objects are allowed`);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      for (const k of keys) {
        if (!k.isWellFormed()) throw new TypeError(`${at}: key contains a lone surrogate`);
      }
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

/** File names a Gno package may contain; they never include "/" or "\n". */
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;

/**
 * Digest of a package's files ("remixlab-bundle-v1"). Files are ordered by
 * name; each contributes "<name>\n<utf8 byte length>\n<content>\n".
 * gnomod.toml contributes only its normalized module and gno lines (see
 * normalizeGnomod), because the chain rewrites the file on deploy; the
 * digest of a deployed package read back from a node therefore equals the
 * digest of the files that were deployed.
 */
export function bundleDigest(files: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  for (const name of Object.keys(files).sort()) {
    if (!FILE_NAME.test(name)) throw new TypeError(`invalid file name ${JSON.stringify(name)}`);
    const content = name === "gnomod.toml" ? normalizeGnomod(files[name]!) : files[name]!;
    parts.push(`${name}\n${utf8ToBytes(content).length}\n${content}\n`);
  }
  return sha256Hex(parts.join(""));
}

/**
 * The module path and gno version of a gnomod.toml, as
 * 'module = "<path>"\ngno = "<version>"\n'. Only top-level keys before the
 * first table are read; anything else (such as the [addpkg] table the chain
 * appends) is ignored.
 */
export function normalizeGnomod(toml: string): string {
  let mod: string | undefined;
  let gno: string | undefined;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) break;
    const m = /^(module|gno)\s*=\s*"([^"\\]*)"\s*(#.*)?$/.exec(line);
    if (m?.[1] === "module") mod = m[2];
    if (m?.[1] === "gno") gno = m[2];
  }
  if (mod === undefined || gno === undefined) throw new TypeError("gnomod.toml needs module and gno");
  return `module = ${JSON.stringify(mod)}\ngno = ${JSON.stringify(gno)}\n`;
}
