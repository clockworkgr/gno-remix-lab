// Amino JSON for the VM messages the Lab asks a wallet to sign. Field names
// follow gno.land/pkg/sdk/vm/msgs.go at the pinned toolchain; the wallet
// adapter verifies them against the wallet it supports.

export interface MsgCall {
  "@type": "/vm.m_call";
  caller: string;
  send: string;
  max_deposit: string;
  pkg_path: string;
  func: string;
  /** Omitted when empty, as the chain's amino JSON (`args,omitempty`) does. */
  args?: string[];
}

export interface MsgAddPackage {
  "@type": "/vm.m_addpkg";
  creator: string;
  package: { name: string; path: string; files: Array<{ name: string; body: string }> };
  send: string;
  max_deposit: string;
}

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/;
const REALM_PATH = /^gno\.land\/r\/[a-z0-9_]+(\/[a-z0-9_]+)*$/;
const COIN = /^([1-9][0-9]*)([a-z][a-z0-9/]{2,127})$/;

export function msgCall(m: { caller: string; pkgPath: string; func: string; args: string[]; send?: string; maxDeposit?: string }): MsgCall {
  if (!ADDRESS.test(m.caller)) throw new TypeError("invalid caller address");
  if (!REALM_PATH.test(m.pkgPath)) throw new TypeError("calls target /r/ realms");
  if (!/^[A-Z][A-Za-z0-9_]{0,63}$/.test(m.func)) throw new TypeError("invalid function name");
  const msg: MsgCall = {
    "@type": "/vm.m_call",
    caller: m.caller,
    send: coins(m.send ?? ""),
    max_deposit: coins(m.maxDeposit ?? ""),
    pkg_path: m.pkgPath,
    func: m.func,
  };
  if (m.args.length > 0) msg.args = [...m.args];
  return msg;
}

/**
 * Builds an add-package message from a generator runtime bundle. Only
 * gnomod.toml and non-test .gno files are accepted, because every file in
 * the message goes on chain.
 */
export function msgAddPackage(m: {
  creator: string;
  pkgPath: string;
  packageName: string;
  files: Record<string, string>;
  maxDeposit?: string;
}): MsgAddPackage {
  if (!ADDRESS.test(m.creator)) throw new TypeError("invalid creator address");
  if (!REALM_PATH.test(m.pkgPath)) throw new TypeError("generated apps deploy to /r/ paths");
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(m.packageName)) throw new TypeError("invalid package name");
  const names = Object.keys(m.files).sort();
  for (const n of names) {
    const runtime = n === "gnomod.toml" || (n.endsWith(".gno") && !n.endsWith("_test.gno") && !n.endsWith("_filetest.gno"));
    if (!runtime || !/^[A-Za-z0-9_.-]+$/.test(n)) throw new TypeError(`${n} is not a runtime file`);
  }
  if (!names.includes("gnomod.toml") || !names.some((n) => n.endsWith(".gno"))) {
    throw new TypeError("a package needs gnomod.toml and at least one .gno file");
  }
  return {
    "@type": "/vm.m_addpkg",
    creator: m.creator,
    package: { name: m.packageName, path: m.pkgPath, files: names.map((name) => ({ name, body: m.files[name]! })) },
    send: "",
    max_deposit: coins(m.maxDeposit ?? ""),
  };
}

/**
 * Validates a std.Coins string the way the chain does: positive amounts
 * without leading zeros, denominations strictly increasing (sorted, no
 * duplicates). "" is the empty set.
 */
function coins(s: string): string {
  if (s === "") return s;
  let prev = "";
  for (const part of s.split(",")) {
    const m = COIN.exec(part);
    if (!m) throw new TypeError(`invalid coins ${s}`);
    if (prev !== "" && m[2]! <= prev) throw new TypeError(`coins must be sorted by denomination without duplicates: ${s}`);
    prev = m[2]!;
  }
  return s;
}
