// Adena (https://adena.app) adapter. Checked against the extension source
// (adena-wallet, April 2026): it injects `window.adena`, validates that a
// /vm.m_call value has an `args` key (even when empty) and accepts
// /vm.m_addpkg values of {creator, package: {name, path, files}, send,
// max_deposit}. SignTx returns the protobuf-encoded signed Tx as base64.

import { WalletError, type NetworkTarget, type SignRequest, type VmMessage, type Wallet, type WalletAccount } from "./index.ts";

export interface AdenaResponse<T = unknown> {
  code: number;
  status: "success" | "failure";
  type: string;
  message: string;
  data: T;
}

export interface AdenaApi {
  AddEstablish(name: string): Promise<AdenaResponse>;
  GetAccount(): Promise<AdenaResponse<{ address: string; chainId: string; status?: string }>>;
  GetNetwork(): Promise<AdenaResponse<{ chainId: string; networkName: string; rpcUrl: string }>>;
  AddNetwork(p: { chainId: string; chainName: string; rpcUrl: string }): Promise<AdenaResponse>;
  SwitchNetwork(chainId: string): Promise<AdenaResponse>;
  SignTx(params: {
    messages: Array<{ type: string; value: Record<string, unknown> }>;
    memo?: string;
    gasFee?: number;
    gasWanted?: number;
  }): Promise<AdenaResponse<{ encodedTransaction: string }>>;
  On(event: "changedAccount" | "changedNetwork", cb: (data: unknown) => void): unknown;
}

const REJECTED = new Set(["TRANSACTION_REJECTED", "CONNECTION_REJECTED", "SIGN_REJECTED", "ADD_NETWORK_REJECTED", "SWITCH_NETWORK_REJECTED"]);

/** Adena's message shape: the amino value without "@type", and `args` always present on calls. */
export function toAdenaMessage(m: VmMessage): { type: string; value: Record<string, unknown> } {
  const { "@type": type, ...value } = m;
  if (type === "/vm.m_call") return { type, value: { ...value, args: (m as { args?: string[] }).args ?? [] } };
  return { type, value };
}

export class AdenaWallet implements Wallet {
  readonly id = "adena";
  readonly name = "Adena";
  readonly installUrl = "https://adena.app";
  private readonly listeners = new Set<() => void>();
  private subscribed = false;
  private readonly getApi: () => AdenaApi | undefined;

  constructor(getApi: () => AdenaApi | undefined = () => (globalThis as { adena?: AdenaApi }).adena) {
    this.getApi = getApi;
  }

  available(): boolean {
    return this.getApi() !== undefined;
  }

  private api(): AdenaApi {
    const a = this.getApi();
    if (!a) throw new WalletError("unavailable", "Adena is not installed in this browser. Install it from adena.app and reload the page.");
    return a;
  }

  private fail(r: AdenaResponse, fallback: string): never {
    if (REJECTED.has(r.type)) throw new WalletError("rejected", "You declined the request in Adena.");
    throw new WalletError("failure", r.message || fallback);
  }

  async connect(app: string, net: NetworkTarget): Promise<WalletAccount> {
    const a = this.api();
    const est = await a.AddEstablish(app);
    if (est.code !== 0 && est.type !== "ALREADY_CONNECTED") this.fail(est, "Adena refused the connection.");
    const current = await a.GetNetwork();
    if (current.code !== 0 || current.data?.chainId !== net.chainId) {
      const sw = await a.SwitchNetwork(net.chainId);
      if (sw.code !== 0) {
        if (REJECTED.has(sw.type)) this.fail(sw, "");
        const add = await a.AddNetwork({ chainId: net.chainId, chainName: net.title, rpcUrl: net.rpc });
        if (add.code !== 0) this.fail(add, `Add the ${net.chainId} network to Adena, then try again.`);
        const again = await a.SwitchNetwork(net.chainId);
        if (again.code !== 0) this.fail(again, `Switch Adena to ${net.chainId}, then try again.`);
      }
    }
    const acc = await this.account();
    if (!acc) throw new WalletError("failure", "Adena did not return an account.");
    return acc;
  }

  async account(): Promise<WalletAccount | null> {
    const a = this.getApi();
    if (!a) return null;
    const r = await a.GetAccount();
    if (r.code !== 0 || !r.data?.address) return null;
    return { address: r.data.address, chainId: r.data.chainId };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    const a = this.getApi();
    // Adena has no way to remove a listener, so subscribe once and fan out.
    if (a && !this.subscribed) {
      this.subscribed = true;
      const fire = () => this.listeners.forEach((l) => l());
      a.On("changedAccount", fire);
      a.On("changedNetwork", fire);
    }
    return () => this.listeners.delete(cb);
  }

  async signTx(req: SignRequest): Promise<string> {
    const r = await this.api().SignTx({
      messages: req.messages.map(toAdenaMessage),
      memo: req.memo ?? "",
      gasFee: req.gasFeeUgnot,
      gasWanted: req.gasWanted,
    });
    if (r.code !== 0) this.fail(r, "Adena could not sign the transaction.");
    if (typeof r.data?.encodedTransaction !== "string") throw new WalletError("failure", "Adena returned no signed transaction.");
    return r.data.encodedTransaction;
  }
}
