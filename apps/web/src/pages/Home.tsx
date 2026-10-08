import { catalog, recipeDemo, recipeList } from "../lib/catalog.ts";
import { href } from "../lib/router.ts";
import { useBrowseNetwork } from "../lib/store.ts";
import { LifecycleTag } from "../components/ui.tsx";
import { startDraft } from "./Drafts.tsx";

const STEPS = [
  ["Discover", "Browse recipes and the reviewed components inside them."],
  ["Configure", "Change membership, permissions, forms and voting rules."],
  ["Inspect", "Read the generated Gno, its tests and what each rule allows."],
  ["Deploy", "Review the exact bundle and costs, then sign in your wallet."],
  ["Use and remix", "Run the app here or on its native page, and copy its configuration."],
];

export function HomePage() {
  const net = useBrowseNetwork();
  return (
    <div className="stack-lg">
      <section className="hero">
        <h1>Assemble a Gno app from reviewed parts.</h1>
        <p>
          Pick a recipe, change its rules, read the Gno it generates, and deploy a realm you control. Every app shows its
          ingredients, and every ingredient links to its source.
        </p>
        <div className="row" style={{ marginTop: 18 }}>
          <a className="btn btn-primary btn-lg" href="#/catalog">
            Browse recipes
          </a>
          <a className="btn btn-lg" href="#/apps">
            Try a live app
          </a>
        </div>
      </section>

      <section className="journey" aria-label="How it works">
        {STEPS.map(([t, d]) => (
          <div key={t}>
            <strong>{t}</strong>
            {d}
          </div>
        ))}
      </section>

      <section className="section">
        <h2>Recipes</h2>
        <div className="grid grid-3">
          {recipeList().map((r) => {
            const demo = recipeDemo(r.id);
            return (
              <div className="card" key={r.id}>
                <div className="row-between">
                  <h3>{r.title}</h3>
                  <LifecycleTag lifecycle={r.lifecycle} />
                </div>
                <p className="muted small">{r.summary}</p>
                <p className="faint">
                  {r.components.map((c) => catalog.components.get(c.id)?.title ?? c.id).join(" · ")}
                </p>
                <div className="card-foot row">
                  <button className="btn btn-sm btn-primary" onClick={() => startDraft(r.id)}>
                    Configure
                  </button>
                  <a className="btn btn-sm" href={`#/recipes/${r.id}`}>
                    Details
                  </a>
                  {demo && (
                    <a className="btn btn-sm btn-ghost" href={href(`/apps/${demo.pkgPath}`, { net })}>
                      Live demo
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="section grid grid-2">
        <div className="card">
          <h3>Nothing to install to start</h3>
          <p className="muted small">
            Reading, configuring and inspecting a recipe needs no wallet and no account. Drafts are kept in this browser;
            export a project to keep it or share it.
          </p>
        </div>
        <div className="card">
          <h3>The realm is the boundary</h3>
          <p className="muted small">
            Buttons here are a convenience. Every write is checked again by the deployed Gno code, so an app behaves the
            same through this site, its native page or the command line.
          </p>
        </div>
      </section>
    </div>
  );
}
