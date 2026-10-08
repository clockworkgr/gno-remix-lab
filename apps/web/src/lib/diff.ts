// Line diff for showing what a configuration change did to the generated
// files. Longest-common-subsequence on lines, after trimming the common
// prefix and suffix, which keeps typical edits small.

export type DiffLine = { kind: "same" | "add" | "del"; text: string; a?: number; b?: number };

const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "same", text: a[i]!, a: i + 1, b: i + 1 });

  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length * mb.length > MAX_CELLS) {
    // Too large to align: show the middle as replaced.
    ma.forEach((t, i) => out.push({ kind: "del", text: t, a: start + i + 1 }));
    mb.forEach((t, j) => out.push({ kind: "add", text: t, b: start + j + 1 }));
  } else {
    const n = ma.length;
    const m = mb.length;
    const lcs = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[at(i, j)] = ma[i] === mb[j] ? lcs[at(i + 1, j + 1)]! + 1 : Math.max(lcs[at(i + 1, j)]!, lcs[at(i, j + 1)]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        out.push({ kind: "same", text: ma[i]!, a: start + i + 1, b: start + j + 1 });
        i++;
        j++;
      } else if (j < m && (i === n || lcs[at(i, j + 1)]! > lcs[at(i + 1, j)]!)) {
        // On a tie the deletion goes first, as unified diffs show it.
        out.push({ kind: "add", text: mb[j]!, b: start + j + 1 });
        j++;
      } else {
        out.push({ kind: "del", text: ma[i]!, a: start + i + 1 });
        i++;
      }
    }
  }
  for (let k = 0; k < a.length - endA; k++) out.push({ kind: "same", text: a[endA + k]!, a: endA + k + 1, b: endB + k + 1 });
  return out;
}

export interface FileChange {
  name: string;
  status: "added" | "removed" | "changed";
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Per-file changes between two file sets; unchanged files are left out. */
export function diffFiles(before: Record<string, string>, after: Record<string, string>): FileChange[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: FileChange[] = [];
  for (const name of names) {
    const x = before[name];
    const y = after[name];
    if (x === y) continue;
    const lines = diffLines(x ?? "", y ?? "");
    out.push({
      name,
      status: x === undefined ? "added" : y === undefined ? "removed" : "changed",
      lines,
      added: lines.filter((l) => l.kind === "add").length,
      removed: lines.filter((l) => l.kind === "del").length,
    });
  }
  return out;
}

/** Collapses unchanged runs longer than 2×context into a gap marker. */
export function hunks(lines: DiffLine[], context = 3): Array<DiffLine | { kind: "gap"; count: number }> {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind !== "same") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: Array<DiffLine | { kind: "gap"; count: number }> = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push({ kind: "gap", count: gap });
      gap = 0;
      out.push(l);
    } else gap++;
  });
  if (gap) out.push({ kind: "gap", count: gap });
  return out;
}
