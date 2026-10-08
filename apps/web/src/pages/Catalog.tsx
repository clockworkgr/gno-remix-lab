import { useMemo, useState } from "react";
import type { Lifecycle } from "@remixlab/spec";
import { catalog, componentList, networkList, recipeList } from "../lib/catalog.ts";
import { LifecycleTag, Tag, Empty } from "../components/ui.tsx";
import { startDraft } from "./Drafts.tsx";

const LIFECYCLES: Lifecycle[] = ["draft", "reviewed", "published", "deprecated", "withdrawn"];

export function CatalogPage() {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "library" | "adapter">("all");
  const [net, setNet] = useState("all");
  const [life, setLife] = useState<"all" | Lifecycle>("all");

  const text = q.trim().toLowerCase();
  const components = useMemo(
    () =>
      componentList().filter(
        (c) =>
          (kind === "all" || c.kind === kind) &&
          (net === "all" || Object.hasOwn(c.packages, net)) &&
          (life === "all" || c.lifecycle === life) &&
          (!text || [c.id, c.title, c.summary, ...c.provides, ...c.requires].some((s) => s.toLowerCase().includes(text))),
      ),
    [kind, net, life, text],
  );
  const recipes = recipeList().filter(
    (r) =>
      (life === "all" || r.lifecycle === life) &&
      (!text || [r.id, r.title, r.summary, ...r.components.map((c) => c.id)].some((s) => s.toLowerCase().includes(text))),
  );

  return (
    <div>
      <div className="page-head">
        <h1>Catalog</h1>
        <p>
          Recipes are complete apps. Components are the reviewed Gno packages they are built from. Everything here is
          versioned in the repository, with exact package paths and source digests per network.
        </p>
      </div>

      <div className="card row" style={{ marginBottom: 24 }}>
        <input
          className="input grow"
          style={{ minWidth: 200 }}
          placeholder="Search by name or capability, e.g. membership.read"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search"
        />
        <select className="select" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Component type">
          <option value="all">All types</option>
          <option value="library">Libraries</option>
          <option value="adapter">Shared-service adapters</option>
        </select>
        <select className="select" style={{ width: "auto" }} value={net} onChange={(e) => setNet(e.target.value)} aria-label="Network">
          <option value="all">Any network</option>
          {networkList().map((n) => (
            <option key={n.id} value={n.id}>
              Published on {n.title}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: "auto" }} value={life} onChange={(e) => setLife(e.target.value as typeof life)} aria-label="Review status">
          <option value="all">Any status</option>
          {LIFECYCLES.map((l) => (
            <option key={l} value={l}>
              {l[0]!.toUpperCase() + l.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <section>
        <h2>Recipes</h2>
        {recipes.length === 0 ? (
          <Empty>No recipes match.</Empty>
        ) : (
          <div className="grid grid-3">
            {recipes.map((r) => (
              <div className="card" key={r.id}>
                <div className="row-between">
                  <a href={`#/recipes/${r.id}`}>
                    <h3>{r.title}</h3>
                  </a>
                  <LifecycleTag lifecycle={r.lifecycle} />
                </div>
                <p className="muted small">{r.summary}</p>
                <p className="faint">
                  v{r.version} · {r.components.length} components · {r.operations.length} permission rules
                </p>
                <div className="card-foot row">
                  <button className="btn btn-sm btn-primary" onClick={() => startDraft(r.id)}>
                    Configure
                  </button>
                  <a className="btn btn-sm" href={`#/recipes/${r.id}`}>
                    Details
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Components</h2>
        {components.length === 0 ? (
          <Empty>No components match these filters.</Empty>
        ) : (
          <div className="grid grid-3">
            {components.map((c) => (
              <a className="card card-link" key={c.id} href={`#/components/${c.id}`}>
                <div className="row-between">
                  <h3>{c.title}</h3>
                  <LifecycleTag lifecycle={c.lifecycle} />
                </div>
                <p className="muted small">{c.summary}</p>
                <div className="row">
                  <Tag>{c.kind === "library" ? "Library" : "Shared-service adapter"}</Tag>
                  {c.provides.map((p) => (
                    <Tag key={p} tone="info">
                      {p}
                    </Tag>
                  ))}
                </div>
                <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
                  {c.id}@{c.catalogVersion} · on {Object.keys(c.packages).map((n) => catalog.networks.get(n)?.title ?? n).join(", ")}
                </p>
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
