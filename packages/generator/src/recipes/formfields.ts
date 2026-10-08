import { type FormField } from "@remixlab/spec";
import { gnoBool, gnoInt, gnoString } from "../gno.ts";

// Form-field code shared by the recipes built on the forms block.

/** A forms.Field composite literal line for the generated schema. */
export function fieldLiteral(f: FormField): string {
  const parts = [`Name: ${gnoString(f.name)}`, `Label: ${gnoString(f.label)}`];
  switch (f.kind) {
    case "text":
      parts.push("Kind: forms.KindText", `Required: ${gnoBool(f.required)}`, `MaxBytes: ${gnoInt(f.maxBytes)}`);
      if (f.multiline) parts.push("Multiline: true");
      break;
    case "integer":
      parts.push("Kind: forms.KindInteger", `Required: ${gnoBool(f.required)}`, `Min: ${gnoInt(f.min)}`, `Max: ${gnoInt(f.max)}`);
      break;
    case "choice":
      parts.push(
        "Kind: forms.KindChoice",
        `Required: ${gnoBool(f.required)}`,
        `Choices: []string{${f.choices.map(gnoString).join(", ")}}`,
      );
      break;
  }
  return `\t\t{${parts.join(", ")}},`;
}

/** A doc-comment list item describing the Submit parameter for f. */
export function fieldDoc(f: FormField): string {
  const req = f.required ? "required" : "optional";
  switch (f.kind) {
    case "text":
      return `//   - ${f.name}: ${req} ${f.multiline ? "multi-line " : ""}text, at most ${f.maxBytes} bytes`;
    case "integer":
      return `//   - ${f.name}: ${req} integer from ${f.min} to ${f.max}`;
    case "choice":
      return `//   - ${f.name}: ${req}, one of the field's ${f.choices.length} choices`;
  }
}

/** A valid answer for f, used by the generated scenario. */
export function sampleAnswer(f: FormField): string {
  switch (f.kind) {
    case "text":
      return "Example".slice(0, f.maxBytes);
    case "integer":
      return String(Math.min(Math.max(0, f.min), f.max));
    case "choice":
      return f.choices[0]!;
  }
}

