import { useMemo, useState, type ReactNode } from "react";
import { hunks, type FileChange } from "../lib/diff.ts";
import { bytes, utf8Length } from "../lib/format.ts";

const KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto",
  "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
  "realm", "cross", "nil", "true", "false",
]);

/** Light Go/Gno highlighting: comments, strings, keywords, numbers. */
function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\/\/.*$)|("(?:[^"\\]|\\.)*"?|`[^`]*`?)|\b([A-Za-z_][A-Za-z0-9_]*)\b|\b(\d[\d_]*)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[1]) out.push(<span key={k++} className="tok-c">{m[1]}</span>);
    else if (m[2]) out.push(<span key={k++} className="tok-s">{m[2]}</span>);
    else if (m[3]) out.push(KEYWORDS.has(m[3]) ? <span key={k++} className="tok-k">{m[3]}</span> : m[3]);
    else if (m[4]) out.push(<span key={k++} className="tok-n">{m[4]}</span>);
    last = re.lastIndex;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function Source({ text }: { text: string }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  return (
    <div className="code">
      <pre>
        {lines.map((l, i) => (
          <div className="ln" key={i}>
            <span className="ln-no">{i + 1}</span>
            <span className="ln-text">{highlight(l)}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

/** A file picker over a set of files, showing one at a time. */
export function FileBrowser({ files, note }: { files: Record<string, string>; note?: (name: string) => ReactNode }) {
  const names = Object.keys(files).sort((a, b) => (a === "gnomod.toml" ? -1 : b === "gnomod.toml" ? 1 : a.localeCompare(b)));
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const current = picked !== undefined && picked in files ? picked : names[0];
  if (!current) return <p className="muted">No files.</p>;
  return (
    <div>
      <div className="file-list">
        {names.map((n) => (
          <button key={n} aria-pressed={n === current} onClick={() => setPicked(n)}>
            {n}
          </button>
        ))}
      </div>
      <div className="row-between faint" style={{ marginBottom: 6 }}>
        <span>{note?.(current)}</span>
        <span>{bytes(utf8Length(files[current]!))}</span>
      </div>
      <Source text={files[current]!} />
    </div>
  );
}

export function DiffView({ change }: { change: FileChange }) {
  const rows = useMemo(() => hunks(change.lines), [change]);
  return (
    <div className="code">
      <pre>
        {rows.map((r, i) =>
          r.kind === "gap" ? (
            <div className="ln gap" key={i}>
              <span className="ln-no" />
              <span className="ln-text">  {r.count} unchanged line{r.count === 1 ? "" : "s"}</span>
            </div>
          ) : (
            <div className={`ln ${r.kind}`} key={i}>
              <span className="ln-no">{r.kind === "del" ? r.a : r.b}</span>
              <span className="ln-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
              <span className="ln-text">{highlight(r.text)}</span>
            </div>
          ),
        )}
      </pre>
    </div>
  );
}
