// Read side of the chain adapter: ABCI queries against the VM module,
// normalized errors, typed read functions and on-chain source readback.

import { base64ToUtf8, utf8ToBase64 } from "./encoding.ts";
import { isObject, type Transport } from "./rpc.ts";
import { decodeResults, type Decoded, type DecodeLimits, type Schema } from "./values.ts";

/** An application or VM error returned inside a query or transaction result. */
export class ChainError extends Error {
  /** Amino type of the error, e.g. "/vm.InvalidPkgPathError". */
  readonly type: string;
  /** "remix: <category>: <detail>" errors from Remix Lab realms, split. */
  readonly remix: { category: string; detail: string } | undefined;
  constructor(type: string, message: string) {
    super(message);
    this.name = "ChainError";
    this.type = type;
    this.remix = parseRemixError(message);
  }
}

export function parseRemixError(message: string): { category: string; detail: string } | undefined {
  const m = /^remix: ([a-z]+(?: [a-z]+)*): (.*)$/s.exec(message);
  return m ? { category: m[1]!, detail: m[2]! } : undefined;
}

/**
 * Turns a ResponseBase error into a ChainError. StringError carries the
 * message itself; other errors carry their message in the log's first
 * trace line ("0  file.go:88 - package not found: …").
 */
export function chainErrorFrom(error: unknown, log: unknown): ChainError {
  const type = isObject(error) && typeof error["@type"] === "string" ? error["@type"] : "unknown";
  if (isObject(error) && typeof error.value === "string") return new ChainError(type, error.value);
  const text = typeof log === "string" ? log : "";
  const trace = /^\s*0\s+\S+ - (.+)$/m.exec(text);
  const data = /^Data: (.+)$/m.exec(text);
  return new ChainError(type, trace?.[1] ?? data?.[1] ?? type);
}

export interface Observation<T> {
  value: T;
  /** Network profile id the value was read from. */
  network: string;
  /** Local time the response arrived; module queries carry no useful height. */
  observedAt: Date;
}

/** A value passed to a read function. Addresses are tagged to be quoted. */
export type ReadArg = string | number | bigint | boolean | { address: string };

const IDENT = /^[A-Z][A-Za-z0-9_]{0,63}$/;
const PKG_PATH = /^gno\.land\/[pr]\/[a-z0-9_]+(\/[a-z0-9_]+)*$/;
const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/;

/** Builds `pkg.Fn(arg, …)` with every argument encoded as a Gno literal. */
export function callExpr(pkgPath: string, fn: string, args: readonly ReadArg[]): string {
  if (!PKG_PATH.test(pkgPath)) throw new TypeError(`invalid package path ${pkgPath}`);
  if (!IDENT.test(fn)) throw new TypeError(`invalid exported function name ${fn}`);
  return `${pkgPath}.${fn}(${args.map(literal).join(", ")})`;
}

function literal(a: ReadArg): string {
  switch (typeof a) {
    case "string":
      if (!a.isWellFormed()) throw new TypeError("string argument contains a lone surrogate");
      return JSON.stringify(a); // JSON string escapes are valid Gno escapes
    case "number":
      if (!Number.isSafeInteger(a)) throw new TypeError(`not a safe integer: ${a}`);
      return String(a);
    case "bigint":
      return a.toString();
    case "boolean":
      return a ? "true" : "false";
    default:
      if (!ADDRESS.test(a.address)) throw new TypeError(`invalid address ${a.address}`);
      return JSON.stringify(a.address);
  }
}

export interface ChainReaderOptions {
  network: string;
  decodeLimits?: DecodeLimits;
  /** Maximum files read back from one package. */
  maxPackageFiles?: number;
  now?: () => Date;
}

export class ChainReader {
  private readonly rpc: Transport;
  private readonly opts: Required<Omit<ChainReaderOptions, "decodeLimits">> & { decodeLimits?: DecodeLimits };

  constructor(rpc: Transport, opts: ChainReaderOptions) {
    this.rpc = rpc;
    this.opts = { maxPackageFiles: 64, now: () => new Date(), ...opts };
  }

  /** Runs an ABCI query and returns its data as UTF-8 text. */
  async query(path: string, data: string): Promise<string> {
    const result = await this.rpc.call("abci_query", { path, data: utf8ToBase64(data), height: "0", prove: false });
    const base = isObject(result) && isObject(result.response) ? result.response.ResponseBase : undefined;
    if (!isObject(base)) throw new ChainError("malformed", "abci_query: missing ResponseBase");
    if (base.Error !== null && base.Error !== undefined) throw chainErrorFrom(base.Error, base.Log);
    if (base.Data === null || base.Data === undefined) return "";
    if (typeof base.Data !== "string") throw new ChainError("malformed", "abci_query: Data is not base64");
    return base64ToUtf8(base.Data);
  }

  /** Calls an exported read function and decodes its results. */
  async read<const S extends readonly Schema[]>(
    pkgPath: string,
    fn: string,
    args: readonly ReadArg[],
    schemas: S,
  ): Promise<Observation<{ [K in keyof S]: Decoded<S[K]> }>> {
    const json = await this.query("vm/qeval_json", callExpr(pkgPath, fn, args));
    return this.observe(decodeResults(json, schemas, this.opts.decodeLimits));
  }

  /** The realm's native page for renderPath. */
  async render(pkgPath: string, renderPath = ""): Promise<Observation<string>> {
    if (!PKG_PATH.test(pkgPath)) throw new TypeError(`invalid package path ${pkgPath}`);
    return this.observe(await this.query("vm/qrender", `${pkgPath}:${renderPath}`));
  }

  /** File names of a deployed package, or null if it does not exist. */
  async files(pkgPath: string): Promise<string[] | null> {
    if (!PKG_PATH.test(pkgPath)) throw new TypeError(`invalid package path ${pkgPath}`);
    try {
      const text = await this.query("vm/qfile", pkgPath);
      return text.split("\n").filter((l) => l !== "");
    } catch (e) {
      if (e instanceof ChainError && e.type === "/vm.InvalidPkgPathError") return null;
      throw e;
    }
  }

  /** Every file of a deployed package, for comparison with a bundle digest. */
  async readPackage(pkgPath: string): Promise<Record<string, string> | null> {
    const names = await this.files(pkgPath);
    if (names === null) return null;
    if (names.length > this.opts.maxPackageFiles) throw new ChainError("limit", `${pkgPath} has too many files`);
    const out: Record<string, string> = {};
    for (const name of names) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new ChainError("malformed", `unexpected file name ${name}`);
      out[name] = await this.query("vm/qfile", `${pkgPath}/${name}`);
    }
    return out;
  }

  private observe<T>(value: T): Observation<T> {
    return { value, network: this.opts.network, observedAt: this.opts.now() };
  }
}
