import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AdenaWallet, WalletError, type Wallet, type WalletAccount } from "@remixlab/wallet";
import { network } from "../lib/catalog.ts";

interface WalletState {
  wallet: Wallet;
  account: WalletAccount | null;
  connecting: boolean;
  error: string;
  /** Connects (or switches) the wallet to the network; returns the account. */
  connect(networkId: string): Promise<WalletAccount | null>;
  disconnect(): void;
}

const Ctx = createContext<WalletState | null>(null);
const REMEMBER = "remixlab.wallet.connected";

const remembered = () => {
  try {
    return localStorage.getItem(REMEMBER) === "1";
  } catch {
    return false;
  }
};
const remember = (on: boolean) => {
  try {
    if (on) localStorage.setItem(REMEMBER, "1");
    else localStorage.removeItem(REMEMBER);
  } catch {
    /* storage unavailable */
  }
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useMemo(() => new AdenaWallet(), []);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState(remembered);

  const refresh = useCallback(async () => {
    try {
      setAccount(await wallet.account());
    } catch {
      setAccount(null);
    }
  }, [wallet]);

  useEffect(() => {
    if (!enabled) return;
    // Adena injects its API shortly after page load.
    const t = setTimeout(() => void refresh(), 400);
    const off = wallet.onChange(() => void refresh());
    return () => {
      clearTimeout(t);
      off();
    };
  }, [enabled, refresh, wallet]);

  const connect = useCallback(
    async (networkId: string) => {
      setConnecting(true);
      setError("");
      try {
        const n = network(networkId);
        const acc = await wallet.connect("Remix Lab", { chainId: n.chainId, rpc: n.rpc, title: n.title });
        setAccount(acc);
        setEnabled(true);
        remember(true);
        return acc;
      } catch (e) {
        setError(e instanceof WalletError ? e.message : `Could not connect: ${(e as Error).message}`);
        return null;
      } finally {
        setConnecting(false);
      }
    },
    [wallet],
  );

  const disconnect = useCallback(() => {
    setAccount(null);
    setEnabled(false);
    remember(false);
  }, []);

  const value = useMemo(
    () => ({ wallet, account: enabled ? account : null, connecting, error, connect, disconnect }),
    [wallet, account, enabled, connecting, error, connect, disconnect],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}
