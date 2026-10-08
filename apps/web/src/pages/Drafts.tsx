import { useRef, useState } from "react";
import { parseProject, type Diagnostic, type ProjectSpec } from "@remixlab/spec";
import { catalog, exampleProjects, recipeList } from "../lib/catalog.ts";
import { navigate } from "../lib/router.ts";
import { deleteDraft, newDraft, storageWorks, useDrafts } from "../lib/store.ts";
import { Empty, Notice, Tag } from "../components/ui.tsx";

/** Starts a new draft from a recipe's default project and opens it. */
export function startDraft(recipeId: string) {
  const example = exampleProjects[recipeId];
  if (!example) return;
  const d = newDraft(structuredClone(example));
  navigate(`/compose/${d.id}`);
}

const MAX_IMPORT_BYTES = 256 * 1024;

export function DraftsPage() {
  const drafts = useDrafts();
  const file = useRef<HTMLInputElement>(null);
  const [importErrors, setImportErrors] = useState<Diagnostic[] | null>(null);

  async function importFile(f: File) {
    setImportErrors(null);
    if (f.size > MAX_IMPORT_BYTES) {
      setImportErrors([{ path: "", message: "The file is larger than 256 KB; a project document is much smaller." }]);
      return;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(await f.text());
    } catch (e) {
      setImportErrors([{ path: "", message: `Not valid JSON: ${(e as Error).message}` }]);
      return;
    }
    // Imported files are checked with the same schema as the editor.
    const r = parseProject(doc);
    if (!r.ok) {
      setImportErrors(r.diagnostics);
      return;
    }
    const d = newDraft(r.value);
    navigate(`/compose/${d.id}`);
  }

  return (
    <div>
      <div className="page-head">
        <h1>Compose</h1>
        <p>
          Start from a recipe, or import a project file (remix.project.json) that you or someone else exported. Drafts are
          saved in this browser as you edit.
        </p>
      </div>

      {!storageWorks() && (
        <Notice tone="warn" title="This browser is not saving drafts">
          <p>Site storage is unavailable, so drafts last only until you close the tab. Export your project to keep it.</p>
        </Notice>
      )}

      <section className="grid grid-3">
        {recipeList().map((r) => (
          <button key={r.id} className="card card-link" style={{ textAlign: "left", cursor: "pointer", font: "inherit" }} onClick={() => startDraft(r.id)}>
            <p className="panel-title">New from recipe</p>
            <h3>{r.title}</h3>
            <p className="muted small" style={{ marginBottom: 0 }}>
              {r.summary}
            </p>
          </button>
        ))}
        <div className="card">
          <p className="panel-title">Import</p>
          <h3>Open a project file</h3>
          <p className="muted small">A remix.project.json from an export.</p>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = "";
            }}
          />
          <button className="btn btn-sm" onClick={() => file.current?.click()}>
            Choose file…
          </button>
        </div>
      </section>

      {importErrors && (
        <div style={{ marginTop: 16 }}>
          <Notice tone="bad" title="That project could not be imported">
            <ul>
              {importErrors.slice(0, 12).map((d, i) => (
                <li key={i}>
                  {d.path && <code>{d.path}</code>} {d.message}
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      <section className="section">
        <h2>Your drafts</h2>
        {drafts.length === 0 ? (
          <Empty>No drafts yet. Pick a recipe above to start.</Empty>
        ) : (
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Recipe</th>
                  <th>Network</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => {
                  const p = d.project as Partial<ProjectSpec>;
                  const valid = parseProject(d.project).ok;
                  return (
                    <tr key={d.id}>
                      <td>
                        <a href={`#/compose/${d.id}`}>{p.app?.title ?? "Untitled"}</a>
                        <div className="faint mono break">{p.app?.pkgPath}</div>
                      </td>
                      <td>
                        {catalog.recipes.get(p.recipe?.id ?? "")?.title ?? p.recipe?.id}
                        {!valid && (
                          <>
                            {" "}
                            <Tag tone="bad">needs fixes</Tag>
                          </>
                        )}
                      </td>
                      <td>{catalog.networks.get(p.network ?? "")?.title ?? p.network}</td>
                      <td className="faint nowrap">{new Date(d.updatedAt).toLocaleString()}</td>
                      <td className="nowrap">
                        <button
                          className="btn btn-sm btn-ghost btn-danger"
                          onClick={() => {
                            if (confirm(`Delete the draft "${p.app?.title ?? "Untitled"}"? Export it first if you want to keep it.`)) deleteDraft(d.id);
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
