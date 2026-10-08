import type { TxState } from "../hooks/tx.ts";
import { Notice, Spinner } from "./ui.tsx";

/** One line of feedback for a transaction, honest about what is known. */
export function TxStatus({ state, onDismiss, success = "Done." }: { state: TxState; onDismiss?: () => void; success?: string }) {
  const dismiss = onDismiss && (
    <button className="btn btn-sm btn-ghost" onClick={onDismiss}>
      Dismiss
    </button>
  );
  switch (state.phase) {
    case "idle":
      return null;
    case "signing":
      return (
        <div className="row muted small" aria-live="polite">
          <Spinner /> Waiting for your signature in the wallet…
        </div>
      );
    case "pending":
      return (
        <div className="row muted small" aria-live="polite">
          <Spinner /> Submitted. Waiting for the transaction to be included in a block…
          <span className="mono faint">{state.hash.slice(0, 12)}</span>
        </div>
      );
    case "success":
      return (
        <Notice tone="ok">
          <div className="row-between">
            <span>
              {success} <span className="faint">Block {state.height}, {state.gasUsed.toLocaleString()} gas.</span>
            </span>
            {dismiss}
          </div>
        </Notice>
      );
    case "failed":
      return (
        <Notice tone="bad">
          <div className="row-between">
            <span className="break">
              {state.message}
              {state.height !== undefined && <span className="faint"> (committed in block {state.height}; the fee was charged)</span>}
            </span>
            {dismiss}
          </div>
        </Notice>
      );
    case "rejected":
      return (
        <Notice tone="warn">
          <div className="row-between">
            <span>{state.message}</span>
            {dismiss}
          </div>
        </Notice>
      );
    case "unknown":
      return (
        <Notice tone="warn" title="Outcome not known yet">
          <p className="break">
            The node has not reported transaction <span className="mono">{state.hash}</span> within 90 seconds. It may
            still be included. Refresh the page data before trying again, so the action is not repeated.
          </p>
          {dismiss}
        </Notice>
      );
  }
}
