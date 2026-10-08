// Byte encodings used on the wire. JSON-RPC carries bytes (query data, tx
// bytes, hashes) as standard base64; URI-style GET requests use 0x-hex.
// Keep the two apart: a hash shown to users is hex, a hash sent in a JSON-RPC
// request is base64.

// Works in browsers and Node alike (atob/btoa, no Buffer).

export function base64ToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new TypeError("invalid base64");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function utf8ToBase64(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s));
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function base64ToUtf8(s: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(s));
}

/** A transaction hash: 32 bytes. Accepts base64 (JSON-RPC) or hex. */
export class TxHash {
  readonly bytes: Uint8Array;
  private constructor(bytes: Uint8Array) {
    if (bytes.length !== 32) throw new TypeError("a transaction hash is 32 bytes");
    this.bytes = bytes;
  }
  static fromBase64(s: string): TxHash {
    return new TxHash(base64ToBytes(s));
  }
  static fromHex(s: string): TxHash {
    const h = s.startsWith("0x") ? s.slice(2) : s;
    if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new TypeError("invalid hex hash");
    return new TxHash(Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16)));
  }
  get base64(): string {
    return bytesToBase64(this.bytes);
  }
  get hex(): string {
    return bytesToHex(this.bytes).toUpperCase();
  }
}

/** Little-endian 8-byte value from a typed value's `N` field, as BigInt. */
export function decodeN(n: string | undefined, signed: boolean): bigint {
  if (n === undefined) return 0n;
  const b = base64ToBytes(n);
  if (b.length !== 8) throw new TypeError("numeric value is not 8 bytes");
  const v = new DataView(b.buffer, b.byteOffset, 8);
  return signed ? v.getBigInt64(0, true) : v.getBigUint64(0, true);
}
