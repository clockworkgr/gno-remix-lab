// Hash routing: works on any static host and keeps realm paths, which
// contain slashes, readable in the URL ("#/apps/gno.land/r/...").
import { useSyncExternalStore } from "react";

export interface Route {
  path: string;
  query: URLSearchParams;
}

function current(): string {
  return location.hash.replace(/^#/, "") || "/";
}

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): Route {
  const raw = useSyncExternalStore(subscribe, current);
  const i = raw.indexOf("?");
  return { path: i < 0 ? raw : raw.slice(0, i), query: new URLSearchParams(i < 0 ? "" : raw.slice(i + 1)) };
}

export function href(path: string, query: Record<string, string> = {}): string {
  const q = new URLSearchParams(query).toString();
  return `#${path}${q ? `?${q}` : ""}`;
}

export function navigate(path: string, query: Record<string, string> = {}, replace = false) {
  const h = href(path, query);
  if (replace) history.replaceState(null, "", h);
  else location.hash = h;
  if (replace) window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Matches "/compose/:id" style patterns; "*" captures the rest. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const s = path.split("/");
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    if (part === "*") {
      out.rest = s.slice(i).map(decodeURIComponent).join("/");
      return out;
    }
    if (i >= s.length) return null;
    if (part.startsWith(":")) out[part.slice(1)] = decodeURIComponent(s[i]!);
    else if (part !== s[i]) return null;
  }
  return p.length === s.length ? out : null;
}
