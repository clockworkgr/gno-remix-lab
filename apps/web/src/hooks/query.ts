import { useCallback, useEffect, useRef, useState } from "react";

export interface Query<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** When the current data was read. */
  at: Date | undefined;
  refresh(): void;
}

/**
 * Runs an async read keyed by `key`, discarding results of superseded runs.
 * With `everyMs`, refreshes in the background while the tab is visible and
 * on focus, as the plan proposes for live app state.
 */
export function useQuery<T>(key: string | null, fn: () => Promise<T>, opts: { everyMs?: number } = {}): Query<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean; at?: Date; key?: string | null }>({ loading: key !== null });
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const load = useCallback(() => {
    if (key === null) return;
    const n = ++seq.current;
    setState((s) => ({ ...(s.key === key ? s : {}), key, loading: true }));
    fnRef.current().then(
      (data) => n === seq.current && setState({ key, data, loading: false, at: new Date() }),
      (error: Error) => n === seq.current && setState((s) => ({ ...(s.key === key ? s : {}), key, error, loading: false })),
    );
  }, [key]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!opts.everyMs || key === null) return;
    const tick = () => document.visibilityState === "visible" && load();
    const t = setInterval(tick, opts.everyMs);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", tick);
    };
  }, [load, opts.everyMs, key]);

  const same = state.key === key;
  return {
    data: same ? state.data : undefined,
    error: same ? state.error : undefined,
    loading: key !== null && (!same || state.loading),
    at: same ? state.at : undefined,
    refresh: load,
  };
}
