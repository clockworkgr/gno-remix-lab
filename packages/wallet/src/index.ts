// Wallet adapters. A wallet only signs: the Lab decodes the signed bytes,
// checks they carry exactly the messages the user reviewed, then broadcasts
// and tracks them itself through the chain adapter. A wallet that rewrote a
// message (or an extension that injected one) is caught before broadcast.

import { base64ToBytes, broadcastSync, type MsgAddPackage, type MsgCall, type Transport, type TxOutcome } from "@remixlab/chain";
import { decodeTx, type DecodedTx } from "./txproto.ts";

export { decodeTx, ProtoError, type DecodedTx, type DecodedMessage } from "./txproto.ts";
export { AdenaWallet, type AdenaApi, type AdenaResponse } from "./adena.ts";

export type VmMessage = MsgCall | MsgAddPackage;

export interface WalletAccount {
  address: string;
  chainId: string;
}

export interface NetworkTarget {
  chainId: string;
  rpc: string;
  title: string;
}

export interface SignRequest {
  chainId: string;
  /** The account every message must be from; checked before and after signing. */
  signer: string;
  messages: VmMessage[];
  memo?: string;
  /** Hints for the wallet's fee screen; the user may change them there. */
  gasWanted: number;
  gasFeeUgnot: number;
}

export type WalletErrorKind =
  /** No such wallet in this browser. */
  | "unavailable"
  /** The user declined (connection or signature). */
  | "rejected"
  /** The wallet's account or network is not the one the plan was prepared for. */
  | "mismatch"
  /** The signed transaction differs from the prepared one. */
  | "tampered"
  | "failure";

export class WalletError extends Error {
  readonly kind: WalletErrorKind;
  constructor(kind: WalletErrorKind, message: string) {
    super(message);
    this.name = "WalletError";
    this.kind = kind;
  }
}

export interface Wallet {
  readonly id: string;
  readonly name: string;
  readonly installUrl: string;
  available(): boolean;
  /** Asks for access and switches the wallet to the target network. */
  connect(app: string, network: NetworkTarget): Promise<WalletAccount>;
  /** The current account, or null when not connected. */
  account(): Promise<WalletAccount | null>;
  /** Calls cb on account or network changes. Returns an unsubscribe function. */
  onChange(cb: () => void): () => void;
  /** Signs without broadcasting. Returns the signed transaction as base64. */
  signTx(req: SignRequest): Promise<string>;
}

export interface SubmitLimits {
  /** Largest fee the user agreed to, in ugnot. */
  maxFeeUgnot: bigint;
}

/**
 * Signs with the wallet, verifies the signed transaction against the
 * request, and broadcasts it. Never retries: a failure after broadcast is
 * reported as an outcome to track, not an error that invites signing again.
 */
export async function signAndSubmit(
  wallet: Wallet,
  rpc: Transport,
  req: SignRequest,
  limits: SubmitLimits,
): Promise<{ outcome: TxOutcome; signed: DecodedTx }> {
  const before = await wallet.account();
  checkAccount(before, req);
  const txBase64 = await wallet.signTx(req);
  let signed: DecodedTx;
  try {
    signed = decodeTx(base64ToBytes(txBase64));
  } catch (e) {
    throw new WalletError("tampered", `the wallet returned a transaction the Lab cannot read: ${(e as Error).message}`);
  }
  const problems = compareSigned(req, signed, limits);
  if (problems.length > 0) throw new WalletError("tampered", `not broadcast: ${problems.join("; ")}`);
  return { outcome: await broadcastSync(rpc, txBase64), signed };
}

function checkAccount(a: WalletAccount | null, req: SignRequest) {
  if (!a) throw new WalletError("mismatch", "the wallet is not connected");
  if (a.chainId !== req.chainId) throw new WalletError("mismatch", `the wallet is on ${a.chainId}, not ${req.chainId}`);
  if (a.address !== req.signer) throw new WalletError("mismatch", `the wallet account changed to ${a.address}; review the plan again`);
}

const FEE = /^([0-9]+)ugnot$/;

/** Differences between what was prepared and what was signed. Empty when they match. */
export function compareSigned(req: SignRequest, signed: DecodedTx, limits: SubmitLimits): string[] {
  const out: string[] = [];
  if (signed.signatures !== 1) out.push(`expected one signature, found ${signed.signatures}`);
  if (signed.memo !== (req.memo ?? "")) out.push("the memo was changed");
  const fee = FEE.exec(signed.fee.gasFee);
  if (!fee) out.push(`unexpected fee ${JSON.stringify(signed.fee.gasFee)}`);
  else if (BigInt(fee[1]!) > limits.maxFeeUgnot) out.push(`fee ${fee[1]} ugnot is above the agreed maximum of ${limits.maxFeeUgnot} ugnot`);
  if (signed.messages.length !== req.messages.length) {
    out.push(`expected ${req.messages.length} message(s), found ${signed.messages.length}`);
    return out;
  }
  req.messages.forEach((want, i) => {
    const got = signed.messages[i]!;
    const at = `message ${i + 1}`;
    if ("unknown" in got || got["@type"] !== want["@type"]) {
      out.push(`${at}: type ${got["@type"]} instead of ${want["@type"]}`);
      return;
    }
    if (want["@type"] === "/vm.m_call" && got["@type"] === "/vm.m_call") {
      const same =
        got.caller === want.caller &&
        got.send === want.send &&
        got.max_deposit === want.max_deposit &&
        got.pkg_path === want.pkg_path &&
        got.func === want.func &&
        got.args.length === (want.args ?? []).length &&
        got.args.every((a, j) => a === want.args![j]);
      if (!same) out.push(`${at}: the call differs from the reviewed one`);
    } else if (want["@type"] === "/vm.m_addpkg" && got["@type"] === "/vm.m_addpkg") {
      if (got.creator !== want.creator) out.push(`${at}: creator differs`);
      if (got.send !== want.send) out.push(`${at}: send differs`);
      if (got.max_deposit !== want.max_deposit) out.push(`${at}: max deposit differs`);
      if (got.package.name !== want.package.name || got.package.path !== want.package.path) out.push(`${at}: package name or path differs`);
      if (got.extraPackageFields) out.push(`${at}: unexpected package metadata`);
      const g = got.package.files;
      const w = want.package.files;
      if (g.length !== w.length || g.some((f, j) => f.name !== w[j]!.name || f.body !== w[j]!.body)) {
        out.push(`${at}: package files differ from the reviewed bundle`);
      }
    }
  });
  return out;
}
