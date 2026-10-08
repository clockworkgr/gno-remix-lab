import { useState, type ReactNode } from "react";
import type { Lifecycle } from "@remixlab/spec";
import { shortAddress } from "../lib/format.ts";

export function LifecycleTag({ lifecycle }: { lifecycle: Lifecycle }) {
  const label: Record<Lifecycle, string> = {
    draft: "Draft",
    reviewed: "Reviewed",
    published: "Published",
    deprecated: "Deprecated",
    withdrawn: "Withdrawn",
  };
  return <span className={`tag tag-${lifecycle}`}>{label[lifecycle]}</span>;
}

export function Tag({ tone, children }: { tone?: "ok" | "bad" | "info" | "accent" | "draft"; children: ReactNode }) {
  return <span className={`tag${tone ? ` tag-${tone}` : ""}`}>{children}</span>;
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "bad" | "ok"; title?: string; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "bad" ? "alert" : undefined}>
      {title && <p><strong>{title}</strong></p>}
      {children}
    </div>
  );
}

export const Spinner = ({ label = "Loading" }: { label?: string }) => <span className="spinner" role="status" aria-label={label} />;

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number | undefined }>;
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn btn-sm btn-ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Addr({ address, you }: { address: string; you?: string | undefined }) {
  return (
    <span className="addr" title={address}>
      {shortAddress(address)}
      {you === address && <span className="tag tag-accent" style={{ marginLeft: 6 }}>you</span>}
    </span>
  );
}

/** Shows loading and error states for a query, then its children. */
export function Loaded<T>({
  q,
  children,
  what = "data",
}: {
  q: { data: T | undefined; error: Error | undefined; loading: boolean; refresh(): void };
  children: (data: T) => ReactNode;
  what?: string;
}) {
  if (q.data !== undefined) return <>{children(q.data)}</>;
  if (q.error)
    return (
      <Notice tone="bad" title={`Could not read ${what}`}>
        <p className="break">{q.error.message}</p>
        <button className="btn btn-sm" onClick={q.refresh}>Try again</button>
      </Notice>
    );
  return (
    <div className="row muted">
      <Spinner /> Reading {what}…
    </div>
  );
}
