import { PKG_PATH_RE, isPackageName } from "@remixlab/spec";

// Typed writers for values injected into generated Gno source. Generated code
// never contains configuration text that did not pass through one of these.

// Characters that would be invisible or reorder text in a reviewer's editor
// (Trojan Source): controls, every format character (Unicode 15.1 Cf),
// line/paragraph separators, private use and noncharacters. The list is
// fixed rather than a \p{...} class so output does not depend on the
// JavaScript engine's Unicode version.
const UNSAFE_IN_SOURCE = new RegExp(
  "[" +
    "\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u180e" +
    "\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ue000-\\uf8ff\\ufdd0-\\ufdef\\ufeff\\ufff9-\\ufffb\\ufffe\\uffff" +
    "\\u{110bd}\\u{110cd}\\u{13430}-\\u{1343f}\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0001}\\u{e0020}-\\u{e007f}" +
    "\\u{f0000}-\\u{10ffff}" +
    "]|[\\u{1fffe}\\u{1ffff}\\u{2fffe}\\u{2ffff}\\u{3fffe}\\u{3ffff}\\u{4fffe}\\u{4ffff}\\u{5fffe}\\u{5ffff}\\u{6fffe}\\u{6ffff}" +
    "\\u{7fffe}\\u{7ffff}\\u{8fffe}\\u{8ffff}\\u{9fffe}\\u{9ffff}\\u{afffe}\\u{affff}\\u{bfffe}\\u{bffff}\\u{cfffe}\\u{cffff}" +
    "\\u{dfffe}\\u{dffff}\\u{efffe}\\u{effff}]",
  "u",
);

/**
 * A Gno interpreted string literal. Every character that is not visible,
 * or could change how surrounding source displays, is written as an escape.
 */
export function gnoString(s: string): string {
  if (!s.isWellFormed()) throw new TypeError("string contains a lone surrogate");
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (UNSAFE_IN_SOURCE.test(ch)) {
      out += cp > 0xffff ? "\\U" + cp.toString(16).padStart(8, "0") : "\\u" + cp.toString(16).padStart(4, "0");
    } else out += ch;
  }
  return out + '"';
}

/** A Gno integer literal from a safe integer. */
export function gnoInt(n: number): string {
  if (!Number.isSafeInteger(n)) throw new TypeError(`not a safe integer: ${n}`);
  return String(n);
}

export function gnoBool(b: boolean): string {
  return b ? "true" : "false";
}

/** A Gno package name: lowercase letters, digits and underscores, not a keyword. */
export function gnoPackageName(name: string): string {
  if (!isPackageName(name)) {
    throw new TypeError(`invalid package name: ${name}`);
  }
  return name;
}

/** A gno.land package path, validated before use in imports or literals. */
export function gnoPkgPath(p: string): string {
  if (!PKG_PATH_RE.test(p) || p.length > 256) {
    throw new TypeError(`invalid package path: ${p}`);
  }
  return p;
}

/** A TOML basic string. */
export function tomlString(s: string): string {
  return gnoString(s);
}
