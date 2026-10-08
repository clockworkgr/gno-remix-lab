import { isPackageName } from "@remixlab/spec";

// Typed writers for values injected into generated Gno source. Generated code
// never contains configuration text that did not pass through one of these.

/** A Gno interpreted string literal. Non-printable characters are escaped. */
export function gnoString(s: string): string {
  if (!s.isWellFormed()) throw new TypeError("string contains a lone surrogate");
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0) || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff) {
      out += "\\u" + cp.toString(16).padStart(4, "0");
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
  if (!/^gno\.land\/[pr]\/[a-z0-9_]+(\/[a-z0-9_]+)*$/.test(p) || p.length > 256) {
    throw new TypeError(`invalid package path: ${p}`);
  }
  return p;
}

/** A TOML basic string. */
export function tomlString(s: string): string {
  return gnoString(s);
}
