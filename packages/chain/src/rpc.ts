// JSON-RPC transport for a gno.land (tm2) node. Bounded: every request has a
// timeout and every response a byte limit, and errors keep the node's code
// and data instead of collapsing into a string.

export interface RpcLimits {
  timeoutMs: number;
  maxResponseBytes: number;
}

export const DEFAULT_RPC_LIMITS: RpcLimits = { timeoutMs: 15_000, maxResponseBytes: 4 * 1024 * 1024 };

/** A JSON-RPC level error, e.g. -32601 method not found. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: string | undefined;
  constructor(code: number, message: string, data?: string) {
    super(data ? `${message}: ${data}` : message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** The request never produced a JSON-RPC response (network, timeout, size). */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportError";
  }
}

export interface Transport {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** HTTP JSON-RPC transport. `url` is the node's RPC endpoint. */
export class HttpTransport implements Transport {
  private nextId = 1;
  private readonly url: string;
  private readonly limits: RpcLimits;
  private readonly fetch: FetchLike;

  constructor(url: string, limits: RpcLimits = DEFAULT_RPC_LIMITS, fetchImpl: FetchLike = globalThis.fetch) {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new TypeError(`unsupported RPC URL ${url}`);
    this.url = u.toString();
    this.limits = limits;
    this.fetch = fetchImpl;
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    let res: Response;
    try {
      res = await this.fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(this.limits.timeoutMs),
      });
    } catch (e) {
      throw new TransportError(`${method}: request failed`, { cause: e });
    }
    let text: string;
    try {
      text = await readLimited(res, this.limits.maxResponseBytes, method);
    } catch (e) {
      // A dropped connection, a body timeout or a non-UTF-8 body: the
      // request may or may not have been processed.
      if (e instanceof TransportError) throw e;
      throw new TransportError(`${method}: reading the response failed`, { cause: e });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TransportError(`${method}: HTTP ${res.status}, response is not JSON`);
    }
    if (isObject(body) && body.id !== id && body.id !== String(id)) {
      throw new TransportError(`${method}: response id does not match the request`);
    }
    return parseEnvelope(body, method);
  }
}

/** Extracts `result` from a JSON-RPC envelope or throws its error. */
export function parseEnvelope(body: unknown, method: string): unknown {
  if (!isObject(body)) throw new TransportError(`${method}: malformed JSON-RPC response`);
  if (body.error !== undefined && body.error !== null) {
    const e = body.error;
    if (!isObject(e) || typeof e.code !== "number") throw new TransportError(`${method}: malformed JSON-RPC error`);
    throw new RpcError(e.code, typeof e.message === "string" ? e.message : "error", typeof e.data === "string" ? e.data : undefined);
  }
  if (!("result" in body)) throw new TransportError(`${method}: response has neither result nor error`);
  return body.result;
}

async function readLimited(res: Response, max: number, method: string): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new TransportError(`${method}: response exceeds ${max} bytes`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new TransportError(`${method}: response exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(concat(chunks, size));
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
