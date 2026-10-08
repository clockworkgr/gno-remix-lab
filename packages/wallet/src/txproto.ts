// A minimal protobuf reader for signed tm2 transactions, so the Lab can
// check what a wallet actually signed before broadcasting it. Field numbers
// follow tm2/tx.proto and gno/vm.proto as encoded by @gnolang/tm2-js-client
// 1.3 and @gnolang/gno-js-client 1.4 (the clients Adena signs with).
//
//   Tx          1 messages (Any, repeated)  2 fee  3 signatures (repeated)  4 memo
//   TxFee       1 gas_wanted (sint64)  2 gas_fee
//   Any         1 type_url  2 value
//   MsgCall     1 caller  2 send  3 max_deposit  4 pkg_path  5 func  6 args (repeated)
//   MsgAddPackage  1 creator  2 package  3 send  4 max_deposit
//   MemPackage  1 name  2 path  3 files (repeated)  4 type  5 info
//   MemFile     1 name  2 body

export interface DecodedCall {
  "@type": "/vm.m_call";
  caller: string;
  send: string;
  max_deposit: string;
  pkg_path: string;
  func: string;
  args: string[];
}

export interface DecodedAddPackage {
  "@type": "/vm.m_addpkg";
  creator: string;
  send: string;
  max_deposit: string;
  package: { name: string; path: string; files: Array<{ name: string; body: string }> };
  /** MemPackage type/info were set; the Lab never sets them. */
  extraPackageFields: boolean;
}

export type DecodedMessage = DecodedCall | DecodedAddPackage | { "@type": string; unknown: true };

export interface DecodedTx {
  messages: DecodedMessage[];
  fee: { gasWanted: bigint; gasFee: string };
  signatures: number;
  memo: string;
}

export class ProtoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtoError";
  }
}

type Field = { n: number; wire: 0; v: bigint } | { n: number; wire: 2; v: Uint8Array };

const MAX_FIELDS = 100_000;

/** Splits one message's bytes into fields. Only varint and bytes wire types occur in these messages. */
function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let shift = 0n;
    let v = 0n;
    for (let k = 0; k < 10; k++) {
      if (i >= b.length) throw new ProtoError("truncated varint");
      const byte = b[i++]!;
      v |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return v;
      shift += 7n;
    }
    throw new ProtoError("varint too long");
  };
  while (i < b.length) {
    if (out.length >= MAX_FIELDS) throw new ProtoError("too many fields");
    const key = varint();
    const n = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (n === 0) throw new ProtoError("field number 0");
    if (wire === 0) {
      out.push({ n, wire, v: varint() });
    } else if (wire === 2) {
      const len = varint();
      if (len > BigInt(b.length - i)) throw new ProtoError("truncated field");
      out.push({ n, wire, v: b.subarray(i, i + Number(len)) });
      i += Number(len);
    } else {
      throw new ProtoError(`unexpected wire type ${wire}`);
    }
  }
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function str(f: Field): string {
  if (f.wire !== 2) throw new ProtoError(`field ${f.n}: expected a string`);
  try {
    return utf8.decode(f.v);
  } catch {
    throw new ProtoError(`field ${f.n}: invalid UTF-8`);
  }
}

function bytes(f: Field): Uint8Array {
  if (f.wire !== 2) throw new ProtoError(`field ${f.n}: expected bytes`);
  return f.v;
}

/** The single value of a non-repeated field; protobuf's last-one-wins would hide a duplicate. */
function one(fs: Field[], n: number): Field | undefined {
  const m = fs.filter((f) => f.n === n);
  if (m.length > 1) throw new ProtoError(`field ${n} repeated`);
  return m[0];
}

function oneStr(fs: Field[], n: number): string {
  const f = one(fs, n);
  return f ? str(f) : "";
}

function known(fs: Field[], allowed: number[], what: string) {
  for (const f of fs) if (!allowed.includes(f.n)) throw new ProtoError(`${what}: unexpected field ${f.n}`);
}

function decodeCall(b: Uint8Array): DecodedCall {
  const fs = fields(b);
  known(fs, [1, 2, 3, 4, 5, 6], "MsgCall");
  return {
    "@type": "/vm.m_call",
    caller: oneStr(fs, 1),
    send: oneStr(fs, 2),
    max_deposit: oneStr(fs, 3),
    pkg_path: oneStr(fs, 4),
    func: oneStr(fs, 5),
    args: fs.filter((f) => f.n === 6).map(str),
  };
}

function decodeAddPackage(b: Uint8Array): DecodedAddPackage {
  const fs = fields(b);
  known(fs, [1, 2, 3, 4], "MsgAddPackage");
  const pkgField = one(fs, 2);
  const pfs = pkgField ? fields(bytes(pkgField)) : [];
  known(pfs, [1, 2, 3, 4, 5], "MemPackage");
  const files = pfs
    .filter((f) => f.n === 3)
    .map((f) => {
      const ffs = fields(bytes(f));
      known(ffs, [1, 2], "MemFile");
      return { name: oneStr(ffs, 1), body: oneStr(ffs, 2) };
    });
  return {
    "@type": "/vm.m_addpkg",
    creator: oneStr(fs, 1),
    send: oneStr(fs, 3),
    max_deposit: oneStr(fs, 4),
    package: { name: oneStr(pfs, 1), path: oneStr(pfs, 2), files },
    extraPackageFields: pfs.some((f) => f.n === 4 || f.n === 5),
  };
}

/** Decodes a signed transaction (the bytes a wallet returns, before base64). */
export function decodeTx(b: Uint8Array): DecodedTx {
  const fs = fields(b);
  known(fs, [1, 2, 3, 4], "Tx");
  const messages = fs
    .filter((f) => f.n === 1)
    .map((f): DecodedMessage => {
      const afs = fields(bytes(f));
      known(afs, [1, 2], "Any");
      const type = oneStr(afs, 1);
      const value = one(afs, 2);
      const v = value ? bytes(value) : new Uint8Array();
      if (type === "/vm.m_call") return decodeCall(v);
      if (type === "/vm.m_addpkg") return decodeAddPackage(v);
      return { "@type": type, unknown: true };
    });
  const feeField = one(fs, 2);
  const ffs = feeField ? fields(bytes(feeField)) : [];
  known(ffs, [1, 2], "TxFee");
  const gw = one(ffs, 1);
  if (gw && gw.wire !== 0) throw new ProtoError("gas_wanted: expected a varint");
  const z = gw ? (gw.v as bigint) : 0n;
  return {
    messages,
    // sint64: zigzag encoding.
    fee: { gasWanted: (z >> 1n) ^ -(z & 1n), gasFee: oneStr(ffs, 2) },
    signatures: fs.filter((f) => f.n === 3).length,
    memo: oneStr(fs, 4),
  };
}
