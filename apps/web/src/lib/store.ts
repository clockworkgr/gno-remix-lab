// Drafts and deployment receipts live in this browser only. Storage can be
// unavailable (private mode, blocked site data), so every access is guarded
// and the app works without it; export/import is the durable route.
import { useSyncExternalStore } from "react";

const DRAFTS = "remixlab.drafts.v1";
const RECEIPTS = "remixlab.receipts.v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** A tiny observable store, so components re-render when drafts change. */
function createStore<T>(key: string, fallback: T) {
  let value = read(key, fallback);
  let persisted = true;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key === key) {
        value = read(key, fallback);
        notify();
      }
    });
  }
  return {
    get: () => value,
    set(next: T) {
      value = next;
      persisted = write(key, next);
      notify();
    },
    persisted: () => persisted,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export interface Draft {
  id: string;
  /** The project document, possibly invalid while being edited. */
  project: unknown;
  createdAt: string;
  updatedAt: string;
  /** The configuration the user last marked as reviewed, for showing changes. */
  baseline?: { project: unknown; at: string };
}

export interface Receipt {
  network: string;
  chainId: string;
  pkgPath: string;
  title: string;
  recipe: { id: string; version: string };
  deployer: string;
  txHash: string;
  height: number;
  gasUsed: number;
  runtimeDigest: string;
  configDigest: string;
  generatorVersion: string;
  components: Array<{ id: string; version: string; pkgPath: string; sourceDigest: string }>;
  /** Result of reading the package back after deployment. */
  verification: { digestMatches: boolean; creatorMatches: boolean; descriptorRead: boolean; checkedAt: string };
  createdAt: string;
}

const drafts = createStore<Draft[]>(DRAFTS, []);
const receipts = createStore<Receipt[]>(RECEIPTS, []);

export const useDrafts = () => useSyncExternalStore(drafts.subscribe, drafts.get);
export const useReceipts = () => useSyncExternalStore(receipts.subscribe, receipts.get);
export const storageWorks = () => drafts.persisted() && receipts.persisted();

export function getDraft(id: string): Draft | undefined {
  return drafts.get().find((d) => d.id === id);
}

export function newDraft(project: unknown): Draft {
  const now = new Date().toISOString();
  const d: Draft = { id: crypto.randomUUID(), project, createdAt: now, updatedAt: now };
  drafts.set([d, ...drafts.get()]);
  return d;
}

export function updateDraft(id: string, change: (d: Draft) => Draft) {
  drafts.set(drafts.get().map((d) => (d.id === id ? { ...change(d), updatedAt: new Date().toISOString() } : d)));
}

export function deleteDraft(id: string) {
  drafts.set(drafts.get().filter((d) => d.id !== id));
}

export function addReceipt(r: Receipt) {
  receipts.set([r, ...receipts.get().filter((x) => !(x.network === r.network && x.pkgPath === r.pkgPath))]);
}

export function receiptFor(networkId: string, pkgPath: string): Receipt | undefined {
  return receipts.get().find((r) => r.network === networkId && r.pkgPath === pkgPath);
}

const NETWORK = "remixlab.network.v1";
const network = createStore<string>(NETWORK, "onyx-1");
export const useBrowseNetwork = () => useSyncExternalStore(network.subscribe, network.get);
export const setBrowseNetwork = (id: string) => network.set(id);
