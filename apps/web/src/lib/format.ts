export function gnot(ugnot: number | bigint): string {
  const n = Number(ugnot) / 1_000_000;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 })} GNOT`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KB`;
}

export function shortAddress(a: string): string {
  return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-5)}` : a;
}

export function shortDigest(d: string): string {
  return d.replace(/^sha256:/, "").slice(0, 12);
}

/** "3 days", "2 hours", "45 minutes" for a span in seconds. */
export function duration(seconds: number): string {
  const units: Array<[number, string]> = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [s, name] of units) {
    if (seconds >= s && seconds % s === 0) {
      const n = seconds / s;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${seconds} seconds`;
}

export function dateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "in 3 hours" / "5 minutes ago" relative to now. */
export function relative(unixSeconds: number, now = Date.now() / 1000): string {
  const d = Math.round(unixSeconds - now);
  const abs = Math.abs(d);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60) return rtf.format(d, "second");
  if (abs < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(d / 3600), "hour");
  return rtf.format(Math.round(d / 86400), "day");
}

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function download(name: string, data: string | Uint8Array<ArrayBuffer>, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
