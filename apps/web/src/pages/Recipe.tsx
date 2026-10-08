import { parseProject } from "@remixlab/spec";
import { catalog, exampleProjects, recipeDemo } from "../lib/catalog.ts";
import { nativeUrl } from "../lib/chain.ts";
import { behaviour, RULE_LABEL } from "../lib/permissions.ts";
import { href } from "../lib/router.ts";
import { useBrowseNetwork } from "../lib/store.ts";
import { LifecycleTag, Notice, Tag } from "../components/ui.tsx";
import { startDraft } from "./Drafts.tsx";

export function RecipePage({ id }: { id: string }) {
  const net = useBrowseNetwork();
  const recipe = catalog.recipes.get(id);
  if (!recipe) return <Notice tone="bad" title={`No recipe called ${id}`} />;
  const example = parseProject(exampleProjects[id]);
  const demo = recipeDemo(id);
  const native = demo && nativeUrl(net, demo.pkgPath);

  return (
    <div>
      <div className="crumbs">
        <a href="#/catalog">Catalog</a> / Recipes
      </div>
      <div className="page-head row-between">
        <div>
          <div className="row">
            <h1 style={{ margin: 0 }}>{recipe.title}</h1>
            <LifecycleTag lifecycle={recipe.lifecycle} />
            <Tag>v{recipe.version}</Tag>
          </div>
          <p style={{ marginTop: 8 }}>{recipe.summary}</p>
        </div>
        <div className="row">
          <button className="btn btn-primary btn-lg" onClick={() => startDraft(id)}>
            Configure this recipe
          </button>
        </div>
      </div>

      <div className="split-side">
        <div className="stack-lg">
          {example.ok && (
            <section className="card">
              <h2>How the default configuration behaves</h2>
              <ul className="muted">
                {behaviour(example.value).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <h2>Permission rules</h2>
            <p className="muted small">
              Each operation has a default rule and a floor. You can make a rule stricter freely, but never more
              permissive than its floor. Owner-level operations cannot be disabled, so an app can always be administered.
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Operation</th>
                    <th>Default</th>
                    <th>Most permissive allowed</th>
                  </tr>
                </thead>
                <tbody>
                  {recipe.operations.map((o) => (
                    <tr key={o.op}>
                      <td>
                        <div>{o.description}</div>
                        <code className="faint">{o.op}</code>
                      </td>
                      <td>{RULE_LABEL[o.default]}</td>
                      <td>{RULE_LABEL[o.floor]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="stack-lg">
          <section className="card">
            <p className="panel-title">Ingredients</p>
            {recipe.components.map((ref) => {
              const c = catalog.components.get(ref.id);
              return (
                <div className="ingredient" key={ref.id}>
                  <div className="grow">
                    <a href={`#/components/${ref.id}`}>{c?.title ?? ref.id}</a>
                    <div className="faint">
                      {ref.id}@{ref.version}
                    </div>
                  </div>
                  {c && <LifecycleTag lifecycle={c.lifecycle} />}
                </div>
              );
            })}
          </section>
          {demo && (
            <section className="card">
              <p className="panel-title">Live demo</p>
              <p className="small muted">The maintainer's deployment of this recipe, with its default configuration.</p>
              <div className="row">
                <a className="btn btn-sm" href={href(`/apps/${demo.pkgPath}`, { net })}>
                  Open in the inspector
                </a>
                {native && (
                  <a className="btn btn-sm btn-ghost" href={native} target="_blank" rel="noopener noreferrer">
                    Native page ↗
                  </a>
                )}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
