// Transaction outcomes. The UI may only show success for a committed
// successful result: mempool acceptance is "pending", a lookup that finds
// nothing is "unknown", and a timeout never triggers re-signing.

import { base64ToBytes, base64ToUtf8Lossy, TxHash } from "./encoding.ts";
import { chainErrorFrom, type ChainError } from "./query.ts";
import { isObject, RpcError, TransportError, type Transport } from "./rpc.ts";

export type TxOutcome =
  /** Accepted by the node's mempool check; not yet in a block. */
  | { status: "pending"; hash: TxHash }
  /** Refused before inclusion (decode, signature, fee); never on chain. */
  | { status: "rejected"; hash: TxHash | undefined; error: ChainError }
  | { status: "committed-success"; hash: TxHash; height: number; gasUsed: number; gasWanted: number; data: string; events: unknown[] }
  /** Included in a block but the message failed; fees were charged. */
  | { status: "committed-failure"; hash: TxHash; height: number; gasUsed: number; gasWanted: number; error: ChainError }
  /** Not found (yet): still pending, dropped, or on another node. */
  | { status: "unknown"; hash: TxHash };

/** Normalizes a broadcast_tx_sync result. */
export function normalizeBroadcast(result: unknown): TxOutcome {
  if (!isObject(result)) throw new TypeError("broadcast: malformed result");
  const hash = typeof result.hash === "string" && result.hash !== "" ? TxHash.fromBase64(result.hash) : undefined;
  if (result.error !== null && result.error !== undefined) {
    return { status: "rejected", hash, error: chainErrorFrom(result.error, result.log) };
  }
  if (!hash) throw new TypeError("broadcast: accepted without a hash");
  return { status: "pending", hash };
}

/**
 * Normalizes a `tx` lookup result. With expected, a result for any other
 * transaction is refused rather than reported.
 */
export function normalizeTxResult(result: unknown, expected?: TxHash): TxOutcome {
  if (!isObject(result) || typeof result.hash !== "string" || !isObject(result.tx_result)) {
    throw new TypeError("tx: malformed result");
  }
  const hash = TxHash.fromBase64(result.hash);
  if (expected && !hash.equals(expected)) throw new TypeError("tx: result is for a different transaction");
  const r = result.tx_result;
  const base = r.ResponseBase;
  if (!isObject(base)) throw new TypeError("tx: missing ResponseBase");
  const common = {
    hash,
    height: safeInt(result.height, "height"),
    gasUsed: safeInt(r.GasUsed, "GasUsed"),
    gasWanted: safeInt(r.GasWanted, "GasWanted"),
  };
  if (base.Error !== null && base.Error !== undefined) {
    return { status: "committed-failure", ...common, error: chainErrorFrom(base.Error, base.Log) };
  }
  return {
    status: "committed-success",
    ...common,
    // Realm return values are usually text; never fail a committed success
    // over bytes that are not.
    data: typeof base.Data === "string" ? base64ToUtf8Lossy(base.Data) : "",
    events: Array.isArray(base.Events) ? base.Events : [],
  };
}

/**
 * Broadcasts signed transaction bytes. The hash is computed locally first,
 * so the caller can always track the transaction: a transport failure
 * yields "unknown" (it may still be included) and a duplicate yields
 * "pending", never an error that invites signing again.
 */
export async function broadcastSync(rpc: Transport, txBase64: string): Promise<TxOutcome> {
  const hash = await TxHash.ofTx(base64ToBytes(txBase64));
  let result: unknown;
  try {
    result = await rpc.call("broadcast_tx_sync", { tx: txBase64 });
  } catch (e) {
    if (e instanceof TransportError) return { status: "unknown", hash };
    if (e instanceof RpcError && /already exists in cache/i.test(`${e.message} ${e.data ?? ""}`)) {
      return { status: "pending", hash };
    }
    throw e;
  }
  const out = normalizeBroadcast(result);
  if (out.hash && !out.hash.equals(hash)) throw new TypeError("broadcast: node reported a different hash");
  return out.status === "rejected" ? { ...out, hash } : out;
}

export async function lookupTx(rpc: Transport, hash: TxHash): Promise<TxOutcome> {
  try {
    return normalizeTxResult(await rpc.call("tx", { hash: hash.base64 }), hash);
  } catch (e) {
    if (e instanceof RpcError && /could not find tx/i.test(e.data ?? e.message)) return { status: "unknown", hash };
    throw e;
  }
}

export interface TrackOptions {
  /** First poll delay; doubles up to maxIntervalMs. */
  intervalMs: number;
  maxIntervalMs: number;
  /** Give up and report "unknown" after this long. */
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

export const DEFAULT_TRACK: TrackOptions = { intervalMs: 2_000, maxIntervalMs: 10_000, timeoutMs: 120_000 };

/**
 * Polls until the transaction is committed or the timeout passes. Transport
 * errors during polling are retried; the result is never inferred from them.
 */
export async function trackTx(rpc: Transport, hash: TxHash, opts: TrackOptions = DEFAULT_TRACK): Promise<TxOutcome> {
  const sleep = opts.sleep ?? ((ms) => abortableSleep(ms, opts.signal));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  let interval = opts.intervalMs;
  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      const out = await lookupTx(rpc, hash);
      if (out.status === "committed-success" || out.status === "committed-failure") return out;
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "TransportError") throw e;
    }
    if (now() + interval > deadline) return { status: "unknown", hash };
    await sleep(interval);
    opts.signal?.throwIfAborted();
    interval = Math.min(interval * 2, opts.maxIntervalMs);
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function safeInt(v: unknown, what: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new TypeError(`tx: ${what} is not a safe integer`);
  return n;
}
