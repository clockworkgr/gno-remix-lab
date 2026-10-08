// Inputs bound to a path in the project document, with the schema's
// diagnostics for that path shown inline.
import { useId, useState, type ReactNode } from "react";
import type { Diagnostic, FormField, Rule } from "@remixlab/spec";
import { RULE_ORDER } from "@remixlab/spec";
import { RULE_LABEL, ruleWho } from "../lib/permissions.ts";
import { duration } from "../lib/format.ts";

export type Path = Array<string | number>;
export type Edit = (path: Path, value: unknown) => void;

export function errorsAt(diags: Diagnostic[], path: Path): string[] {
  const p = path.join(".");
  return diags.filter((d) => d.path === p).map((d) => d.message);
}

/** Immutable set of a nested value. */
export function setIn<T>(obj: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const base = (obj ?? (typeof head === "number" ? [] : {})) as Record<string | number, unknown>;
  const copy = (Array.isArray(base) ? [...base] : { ...base }) as Record<string | number, unknown>;
  copy[head!] = setIn(base[head!], rest, value);
  return copy as T;
}

export function getIn(obj: unknown, path: Path): unknown {
  return path.reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string | number, unknown>)[k]), obj);
}

function Field({ label, hint, errors, children, id }: { label: ReactNode; hint?: ReactNode; errors: string[]; children: ReactNode; id: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {errors.map((e) => (
        <span className="err" key={e}>
          {e}
        </span>
      ))}
      {hint && errors.length === 0 && <span className="hint">{hint}</span>}
    </div>
  );
}

interface Bound {
  doc: unknown;
  path: Path;
  edit: Edit;
  diags: Diagnostic[];
  label: ReactNode;
  hint?: ReactNode;
}

export function TextInput({ doc, path, edit, diags, label, hint, multiline }: Bound & { multiline?: boolean }) {
  const id = useId();
  const errors = errorsAt(diags, path);
  const v = getIn(doc, path);
  const props = {
    id,
    className: `${multiline ? "textarea" : "input"}${errors.length ? " invalid" : ""}`,
    value: typeof v === "string" ? v : "",
    "aria-invalid": errors.length > 0,
    onChange: (e: { target: { value: string } }) => edit(path, e.target.value),
  };
  return (
    <Field id={id} label={label} hint={hint} errors={errors}>
      {multiline ? <textarea {...props} rows={3} /> : <input {...props} spellCheck={false} />}
    </Field>
  );
}

/** Integer input. Keeps the typed text while it is not a number, so the schema can report it. */
export function NumberInput({ doc, path, edit, diags, label, hint, min, max }: Bound & { min?: number; max?: number }) {
  const id = useId();
  const errors = errorsAt(diags, path);
  const v = getIn(doc, path);
  return (
    <Field id={id} label={label} hint={hint} errors={errors}>
      <input
        id={id}
        className={`input${errors.length ? " invalid" : ""}`}
        inputMode="numeric"
        value={typeof v === "number" ? String(v) : typeof v === "string" ? v : ""}
        aria-invalid={errors.length > 0}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        onChange={(e) => {
          const t = e.target.value.trim();
          edit(path, /^-?\d+$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : t);
        }}
      />
    </Field>
  );
}

const UNITS: Array<[string, number]> = [
  ["days", 86400],
  ["hours", 3600],
  ["minutes", 60],
  ["seconds", 1],
];

export function DurationInput({ doc, path, edit, diags, label, hint }: Bound) {
  const id = useId();
  const errors = errorsAt(diags, path);
  const v = getIn(doc, path);
  const seconds = typeof v === "number" ? v : NaN;
  const initial = UNITS.find(([, s]) => Number.isFinite(seconds) && seconds % s === 0 && seconds >= s) ?? UNITS[3]!;
  const [unit, setUnit] = useState(initial[1]);
  const amount = Number.isFinite(seconds) ? String(seconds / unit) : typeof v === "string" ? v : "";
  return (
    <Field id={id} label={label} hint={hint ?? (Number.isFinite(seconds) ? duration(seconds) : undefined)} errors={errors}>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input
          id={id}
          className={`input${errors.length ? " invalid" : ""}`}
          inputMode="numeric"
          value={amount}
          onChange={(e) => {
            const t = e.target.value.trim();
            const n = Number(t);
            edit(path, t !== "" && Number.isFinite(n) && Number.isSafeInteger(Math.round(n * unit)) ? Math.round(n * unit) : t);
          }}
        />
        <select className="select" style={{ width: "auto" }} value={unit} aria-label="Unit" onChange={(e) => setUnit(Number(e.target.value))}>
          {UNITS.map(([name, s]) => (
            <option key={s} value={s}>
              {name}
            </option>
          ))}
        </select>
      </div>
    </Field>
  );
}

export function Choice<T extends string>({
  doc,
  path,
  edit,
  diags,
  label,
  hint,
  options,
}: Bound & { options: Array<{ value: T; label: string }> }) {
  const id = useId();
  const errors = errorsAt(diags, path);
  const v = getIn(doc, path);
  return (
    <div className="field">
      <span className="label" id={id}>
        {label}
      </span>
      <div className="segmented" role="group" aria-labelledby={id}>
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={v === o.value} onClick={() => edit(path, o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      {errors.map((e) => (
        <span className="err" key={e}>
          {e}
        </span>
      ))}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Toggle({ doc, path, edit, label }: Omit<Bound, "diags"> & { diags?: Diagnostic[] }) {
  return (
    <label className="check">
      <input type="checkbox" checked={getIn(doc, path) === true} onChange={(e) => edit(path, e.target.checked)} />
      {label}
    </label>
  );
}

export function RuleSelect({
  value,
  floor,
  onChange,
  errors,
  id,
}: {
  value: Rule;
  floor: Rule;
  onChange: (r: Rule) => void;
  errors: string[];
  id: string;
}) {
  const allowed = RULE_ORDER.filter((r) => RULE_ORDER.indexOf(r) >= RULE_ORDER.indexOf(floor) && !(floor === "owner" && r === "nobody"));
  return (
    <>
      <select id={id} className={`select${errors.length ? " invalid" : ""}`} value={value} onChange={(e) => onChange(e.target.value as Rule)} title={ruleWho(value)}>
        {allowed.map((r) => (
          <option key={r} value={r}>
            {RULE_LABEL[r]}
          </option>
        ))}
      </select>
      {errors.map((e) => (
        <span className="err" key={e}>
          {e}
        </span>
      ))}
    </>
  );
}

/** A fresh field of the given kind, keeping name, label and required. Strict schemas reject leftover keys. */
export function fieldOfKind(f: Partial<FormField>, kind: FormField["kind"]): FormField {
  const base = { name: f.name ?? "", label: f.label ?? "", required: f.required ?? false };
  switch (kind) {
    case "text":
      return { ...base, kind, maxBytes: 200, multiline: false };
    case "integer":
      return { ...base, kind, min: 0, max: 100 };
    case "choice":
      return { ...base, kind, choices: ["Yes", "No"] };
  }
}
