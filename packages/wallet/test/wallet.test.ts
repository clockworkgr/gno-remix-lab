import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { base64ToBytes, bytesToBase64, msgAddPackage, msgCall, TxHash, type Transport } from "@remixlab/chain";
import { AdenaWallet, compareSigned, decodeTx, signAndSubmit, WalletError, type AdenaApi, type SignRequest, type Wallet } from "@remixlab/wallet";
import { toAdenaMessage } from "../src/adena.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "../../chain/test/fixtures", `${name}.json`), "utf8"));

const CALLER = "g1sw4h2x6rksar4vzpzz2dkm5u9cj4dz6508uud0";
const CLUBPOLL = "gno.land/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/clubpoll";
// A transaction signed by gnokey and executed by the node (tx_success.json).
const SIGNED_VOTE: string = fixture("tx_success").response.result.tx;

const voteRequest = (args = ["1", "1"]): SignRequest => ({
  chainId: "dev",
  signer: CALLER,
  messages: [msgCall({ caller: CALLER, pkgPath: CLUBPOLL, func: "Vote", args })],
  gasWanted: 20_000_000,
  gasFeeUgnot: 1_000_000,
});

// Protobuf writer for test transactions the fixtures do not cover.
const enc = new TextEncoder();
function varint(n: bigint): number[] {
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return out;
}
const field = (n: number, v: Uint8Array | string) => {
  const b = typeof v === "string" ? enc.encode(v) : v;
  return [...varint(BigInt((n << 3) | 2)), ...varint(BigInt(b.length)), ...b];
};
const msg = (...parts: number[][]) => new Uint8Array(parts.flat());
function addPkgTx(files: Array<[string, string]>, opts: { creator?: string; extra?: boolean } = {}) {
  const pkg = msg(
    field(1, "app"),
    field(2, "gno.land/r/g1sw4h2x6rksar4vzpzz2dkm5u9cj4dz6508uud0/app"),
    ...files.map(([name, body]) => field(3, msg(field(1, name), field(2, body)))),
    ...(opts.extra ? [field(5, msg(field(1, "x")))] : []),
  );
  const value = msg(field(1, opts.creator ?? CALLER), field(2, pkg), field(4, "50000000ugnot"));
  const fee = msg([8, ...varint(2n * 60_000_000n)], field(2, "2000000ugnot"));
  return msg(field(1, msg(field(1, "/vm.m_addpkg"), field(2, value))), field(2, fee), field(3, msg(field(2, "sig"))));
}

const FILES = { "gnomod.toml": 'module = "x"\ngno = "0.9"\n', "app.gno": "package app\n" };
const addPkgRequest = (): SignRequest => ({
  chainId: "dev",
  signer: CALLER,
  messages: [
    msgAddPackage({
      creator: CALLER,
      pkgPath: "gno.land/r/g1sw4h2x6rksar4vzpzz2dkm5u9cj4dz6508uud0/app",
      packageName: "app",
      files: FILES,
      maxDeposit: "50000000ugnot",
    }),
  ],
  gasWanted: 60_000_000,
  gasFeeUgnot: 2_000_000,
});

const limits = { maxFeeUgnot: 5_000_000n };

describe("decodeTx", () => {
  it("reads a transaction signed by gnokey", () => {
    const tx = decodeTx(base64ToBytes(SIGNED_VOTE));
    expect(tx.messages).toEqual([
      { "@type": "/vm.m_call", caller: CALLER, send: "", max_deposit: "", pkg_path: CLUBPOLL, func: "Vote", args: ["1", "1"] },
    ]);
    expect(tx.fee).toEqual({ gasWanted: 20_000_000n, gasFee: "1000000ugnot" });
    expect(tx.signatures).toBe(1);
  });
  it("reads add-package messages", () => {
    const tx = decodeTx(addPkgTx([["app.gno", "package app\n"], ["gnomod.toml", FILES["gnomod.toml"]]]));
    expect(tx.messages[0]).toMatchObject({ "@type": "/vm.m_addpkg", creator: CALLER, max_deposit: "50000000ugnot", extraPackageFields: false });
    expect(tx.fee.gasWanted).toBe(60_000_000n);
  });
  it("rejects malformed and ambiguous input", () => {
    expect(() => decodeTx(new Uint8Array([0x0a, 0x05, 0x01]))).toThrow(/truncated/);
    expect(() => decodeTx(new Uint8Array([0x0d, 0, 0, 0, 0]))).toThrow(/wire type/);
    // memo twice: protobuf keeps the last one, the Lab refuses
    expect(() => decodeTx(msg(field(4, "a"), field(4, "b")))).toThrow(/repeated/);
    expect(() => decodeTx(msg(field(9, "a")))).toThrow(/unexpected field 9/);
  });
});

describe("compareSigned", () => {
  const signedVote = decodeTx(base64ToBytes(SIGNED_VOTE));
  it("accepts exactly the reviewed call", () => {
    expect(compareSigned(voteRequest(), signedVote, limits)).toEqual([]);
  });
  it("catches a changed argument, an extra message and a high fee", () => {
    expect(compareSigned(voteRequest(["1", "0"]), signedVote, limits)).toEqual(["message 1: the call differs from the reviewed one"]);
    const two = { ...voteRequest(), messages: [...voteRequest().messages, ...voteRequest().messages] };
    expect(compareSigned(two, signedVote, limits)[0]).toMatch(/expected 2 message/);
    expect(compareSigned(voteRequest(), signedVote, { maxFeeUgnot: 999_999n })[0]).toMatch(/above the agreed maximum/);
  });
  it("accepts the reviewed bundle and refuses any change to it", () => {
    const ok = decodeTx(addPkgTx([["app.gno", FILES["app.gno"]], ["gnomod.toml", FILES["gnomod.toml"]]]));
    expect(compareSigned(addPkgRequest(), ok, limits)).toEqual([]);
    const edited = decodeTx(addPkgTx([["app.gno", "package app\n// injected\n"], ["gnomod.toml", FILES["gnomod.toml"]]]));
    expect(compareSigned(addPkgRequest(), edited, limits)).toEqual(["message 1: package files differ from the reviewed bundle"]);
    const extraFile = decodeTx(addPkgTx([["app.gno", FILES["app.gno"]], ["evil.gno", "package app\n"], ["gnomod.toml", FILES["gnomod.toml"]]]));
    expect(compareSigned(addPkgRequest(), extraFile, limits)).toEqual(["message 1: package files differ from the reviewed bundle"]);
    const meta = decodeTx(addPkgTx([["app.gno", FILES["app.gno"]], ["gnomod.toml", FILES["gnomod.toml"]]], { extra: true }));
    expect(compareSigned(addPkgRequest(), meta, limits)).toContain("message 1: unexpected package metadata");
  });
});

describe("signAndSubmit", () => {
  const wallet = (tx: string, account = { address: CALLER, chainId: "dev" }): Wallet => ({
    id: "fake",
    name: "Fake",
    installUrl: "",
    available: () => true,
    connect: async () => account,
    account: async () => account,
    onChange: () => () => {},
    signTx: async () => tx,
  });
  const rpc = (): Transport & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push(method);
        const hash = await TxHash.ofTx(base64ToBytes(params.tx as string));
        return { error: null, hash: hash.base64, log: "" };
      },
    };
  };

  it("broadcasts a matching transaction and reports it pending under its own hash", async () => {
    const t = rpc();
    const { outcome } = await signAndSubmit(wallet(SIGNED_VOTE), t, voteRequest(), limits);
    expect(outcome.status).toBe("pending");
    expect(outcome.hash?.base64).toBe(fixture("tx_success").response.result.hash);
    expect(t.calls).toEqual(["broadcast_tx_sync"]);
  });
  it("never broadcasts a transaction that differs from the plan", async () => {
    const t = rpc();
    await expect(signAndSubmit(wallet(SIGNED_VOTE), t, voteRequest(["2", "0"]), limits)).rejects.toMatchObject({ kind: "tampered" });
    await expect(signAndSubmit(wallet(bytesToBase64(new Uint8Array([0xff]))), t, voteRequest(), limits)).rejects.toMatchObject({ kind: "tampered" });
    expect(t.calls).toEqual([]);
  });
  it("refuses to sign when the account or network changed after review", async () => {
    const t = rpc();
    await expect(signAndSubmit(wallet(SIGNED_VOTE, { address: CALLER, chainId: "onyx-1" }), t, voteRequest(), limits)).rejects.toMatchObject({ kind: "mismatch" });
    const other = "g1aea9jjk68vzzx6gwmrj5a46qm03wwm4dntk78m";
    await expect(signAndSubmit(wallet(SIGNED_VOTE, { address: other, chainId: "dev" }), t, voteRequest(), limits)).rejects.toBeInstanceOf(WalletError);
    expect(t.calls).toEqual([]);
  });
});

describe("AdenaWallet", () => {
  const ok = <T>(data: T) => ({ code: 0, status: "success" as const, type: "SUCCESS", message: "", data });
  const fail = (type: string) => ({ code: 4000, status: "failure" as const, type, message: type, data: {} as never });
  const api = (over: Partial<AdenaApi> = {}): AdenaApi => ({
    AddEstablish: vi.fn(async () => ok({})),
    GetAccount: vi.fn(async () => ok({ address: CALLER, chainId: "onyx-1" })),
    GetNetwork: vi.fn(async () => ok({ chainId: "onyx-1", networkName: "", rpcUrl: "" })),
    AddNetwork: vi.fn(async () => ok({})),
    SwitchNetwork: vi.fn(async () => ok({})),
    SignTx: vi.fn(async () => ok({ encodedTransaction: SIGNED_VOTE })),
    On: vi.fn(),
    ...over,
  });
  const net = { chainId: "onyx-1", rpc: "https://rpc.onyx.testnets.gno.land:443", title: "Onyx testnet" };

  it("always sends args on calls, as Adena's validator requires", () => {
    const join = msgCall({ caller: CALLER, pkgPath: CLUBPOLL, func: "Join", args: [] });
    expect("args" in join).toBe(false);
    expect(toAdenaMessage(join)).toEqual({
      type: "/vm.m_call",
      value: { caller: CALLER, send: "", max_deposit: "", pkg_path: CLUBPOLL, func: "Join", args: [] },
    });
    expect(toAdenaMessage(addPkgRequest().messages[0]!).value).not.toHaveProperty("@type");
  });
  it("adds and switches to an unknown network", async () => {
    const a = api({
      GetNetwork: vi.fn(async () => ok({ chainId: "gnoland1", networkName: "", rpcUrl: "" })),
      SwitchNetwork: vi.fn().mockResolvedValueOnce(fail("UNADDED_NETWORK")).mockResolvedValue(ok({})),
    });
    expect(await new AdenaWallet(() => a).connect("Remix Lab", net)).toEqual({ address: CALLER, chainId: "onyx-1" });
    expect(a.AddNetwork).toHaveBeenCalledWith({ chainId: "onyx-1", chainName: "Onyx testnet", rpcUrl: net.rpc });
  });
  it("reports a declined signature as rejected and a missing extension as unavailable", async () => {
    const w = new AdenaWallet(() => api({ SignTx: vi.fn(async () => fail("TRANSACTION_REJECTED")) }));
    await expect(w.signTx(voteRequest())).rejects.toMatchObject({ kind: "rejected" });
    const none = new AdenaWallet(() => undefined);
    expect(none.available()).toBe(false);
    expect(await none.account()).toBeNull();
    await expect(none.connect("Remix Lab", net)).rejects.toMatchObject({ kind: "unavailable" });
  });
  it("subscribes to Adena events once and supports unsubscribing", () => {
    const a = api();
    const w = new AdenaWallet(() => a);
    const cb = vi.fn();
    const off = w.onChange(cb);
    w.onChange(() => {});
    expect(a.On).toHaveBeenCalledTimes(2);
    const fire = (a.On as ReturnType<typeof vi.fn>).mock.calls[0]![1] as () => void;
    fire();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    fire();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
