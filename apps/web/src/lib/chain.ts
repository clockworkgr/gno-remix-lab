import { ChainReader, HttpTransport, viewSchemas, type Transport } from "@remixlab/chain";
import { network, viewPackages } from "./catalog.ts";

// gnoweb front ends that serve each network's native realm pages. Not part
// of the network profile schema: they are presentation links only.
const GNOWEB: Record<string, string> = {
  "onyx-1": "https://onyx.testnets.gno.land",
  "local-dev": "http://127.0.0.1:8888",
};

const transports = new Map<string, HttpTransport>();
const readers = new Map<string, ChainReader>();

export function transport(networkId: string): Transport {
  let t = transports.get(networkId);
  if (!t) {
    t = new HttpTransport(network(networkId).rpc);
    transports.set(networkId, t);
  }
  return t;
}

export function reader(networkId: string): ChainReader {
  let r = readers.get(networkId);
  if (!r) {
    r = new ChainReader(transport(networkId), { network: networkId });
    readers.set(networkId, r);
  }
  return r;
}

export function schemas(networkId: string) {
  const p = viewPackages(networkId);
  if (!p) throw new Error(`the catalog lists no Remix Lab core package on ${networkId}`);
  return viewSchemas(p);
}

/** The native gnoweb page for a realm path and render path, if the network has one. */
export function nativeUrl(networkId: string, pkgPath: string, renderPath = ""): string | undefined {
  const base = GNOWEB[networkId];
  if (!base) return undefined;
  return `${base}/${pkgPath.replace(/^gno\.land\//, "")}${renderPath ? `:${renderPath}` : ""}`;
}

/** Storage price on the supported networks (Onyx: 100 ugnot per byte). */
export const STORAGE_UGNOT_PER_BYTE = 100;

/**
 * Bytes a generated app realm occupies after deployment, per byte of
 * runtime source. Measured on onyx-1 (docs/compat): the reference realms
 * store 4.3 to 5.0 bytes per source byte.
 */
export const STORAGE_PER_SOURCE_BYTE = { estimate: 5, cap: 7 };
