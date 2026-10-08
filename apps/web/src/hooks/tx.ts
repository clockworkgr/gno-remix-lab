// Runs one transaction from the UI: sign in the wallet, verify, broadcast,
// then track the hash until it is committed. The states mirror the plan's
// outcomes; only a committed success is shown as success, and a timeout
// is "unknown", never a prompt to sign again.
import { useCallback, useEffect, useRef, useState } from "react";
import { trackTx, type TxOutcome } from "@remixlab/chain";
import { signAndSubmit, WalletError, type VmMessage } from "@remixlab/wallet";
import { network } from "../lib/catalog.ts";
import { transport } from "../lib/chain.ts";
import { useWallet } from "./wallet.tsx";

export type TxState =
  | { phase: "idle" }
  | { phase: "signing" }
  | { phase: "pending"; hash: string }
  | { phase: "success"; hash: string; height: number; gasUsed: number; data: string }
  | { phase: "failed"; hash?: string; height?: number; message: string }
  | { phase: "rejected"; message: string }
  | { phase: "unknown"; hash: string };

export interface TxOptions {
  gasWanted?: number;
  gasFeeUgnot?: number;
  /** Highest fee the user accepts, in ugnot. */
  maxFeeUgnot?: bigint;
  onSuccess?: (o: Extract<TxOutcome, { status: "committed-success" }>) => void | Promise<void>;
}

const DEFAULTS = { gasWanted: 30_000_000, gasFeeUgnot: 100_000, maxFeeUgnot: 2_000_000n };

/** A realm's own panic text, without the "remix: <category>:" prefix. */
export function errorText(e: { message: string; remix?: { category: string; detail: string } | undefined }): string {
  return e.remix ? `${e.remix.detail} (${e.remix.category})` : e.message;
}

export function useTx(networkId: string) {
  const { wallet, account, connect } = useWallet();
  const [state, setState] = useState<TxState>({ phase: "idle" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(
    async (build: (caller: string) => VmMessage[], opts: TxOptions = {}) => {
      if (state.phase === "signing" || state.phase === "pending") return;
      const chainId = network(networkId).chainId;
      let acc = account;
      if (!acc || acc.chainId !== chainId) acc = await connect(networkId);
      if (!acc) {
        setState({ phase: "rejected", message: "Connect a wallet on this network first." });
        return;
      }
      setState({ phase: "signing" });
      const rpc = transport(networkId);
      let outcome: TxOutcome;
      try {
        ({ outcome } = await signAndSubmit(
          wallet,
          rpc,
          {
            chainId,
            signer: acc.address,
            messages: build(acc.address),
            gasWanted: opts.gasWanted ?? DEFAULTS.gasWanted,
            gasFeeUgnot: opts.gasFeeUgnot ?? DEFAULTS.gasFeeUgnot,
          },
          { maxFeeUgnot: opts.maxFeeUgnot ?? DEFAULTS.maxFeeUgnot },
        ));
      } catch (e) {
        if (e instanceof WalletError && e.kind === "rejected") setState({ phase: "rejected", message: e.message });
        else setState({ phase: "failed", message: (e as Error).message });
        return;
      }
      if (outcome.status === "rejected") {
        setState({ phase: "failed", ...(outcome.hash ? { hash: outcome.hash.hex } : {}), message: errorText(outcome.error) });
        return;
      }
      setState({ phase: "pending", hash: outcome.hash.hex });
      abort.current?.abort();
      abort.current = new AbortController();
      let final: TxOutcome;
      try {
        final = await trackTx(rpc, outcome.hash, { intervalMs: 1500, maxIntervalMs: 6000, timeoutMs: 90_000, signal: abort.current.signal });
      } catch {
        return; // unmounted
      }
      switch (final.status) {
        case "committed-success":
          setState({ phase: "success", hash: final.hash.hex, height: final.height, gasUsed: final.gasUsed, data: final.data });
          await opts.onSuccess?.(final);
          break;
        case "committed-failure":
          setState({ phase: "failed", hash: final.hash.hex, height: final.height, message: errorText(final.error) });
          break;
        default:
          setState({ phase: "unknown", hash: outcome.hash.hex });
      }
    },
    [wallet, account, connect, networkId, state.phase],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, run, reset, busy: state.phase === "signing" || state.phase === "pending" };
}
