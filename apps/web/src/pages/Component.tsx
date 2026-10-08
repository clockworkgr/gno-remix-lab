import { useState } from "react";
import { bundleDigest } from "@remixlab/spec";
import { catalog, recipeList, sourceFiles } from "../lib/catalog.ts";
import { nativeUrl, reader } from "../lib/chain.ts";
import { shortDigest } from "../lib/format.ts";
import { useQuery } from "../hooks/query.ts";
import { FileBrowser } from "../components/CodeView.tsx";
import { LifecycleTag, Loaded, Notice, Spinner, Tabs, Tag } from "../components/ui.tsx";

const isRuntime = (n: string) => n === "gnomod.toml" || (n.endsWith(".gno") && !n.endsWith("_test.gno") && !n.endsWith("_filetest.gno"));

function ChainCheck({ networkId, pkgPath, expected }: { networkId: string; pkgPath: string; expected: string }) {
  const [run, setRun] = useState(false);
  const q = useQuery(run ? `${networkId}:${pkgPath}` : null, async () => {
    const files = await reader(networkId).readPackage(pkgPath);
    return files === null ? null : bundleDigest(files);
  });
  if (!run)
    return (
      <button className="btn btn-sm" onClick={() => setRun(true)}>
        Verify on chain
      </button>
    );
  if (q.loading) return <Spinner label="Reading the package" />;
  if (q.error) return <Tag tone="bad">Could not read: {q.error.message}</Tag>;
  if (q.data === null) return <Tag tone="bad">Not deployed</Tag>;
  return q.data === expected ? (
    <Tag tone="ok">Matches the manifest digest</Tag>
  ) : (
    <Tag tone="bad">Different source: {shortDigest(q.data!)}</Tag>
  );
}

export function ComponentPage({ id }: { id: string }) {
  const c = catalog.components.get(id);
  const [tab, setTab] = useState<"runtime" | "tests">("runtime");
  const src = useQuery(c ? c.source : null, () => sourceFiles(c!.source));
  if (!c) return <Notice tone="bad" title={`No component called ${id}`} />;

  const usedBy = recipeList().filter((r) => r.components.some((x) => x.id === id));
  const dependents = [...catalog.components.values()].filter((x) => x.componentDependencies.includes(id));

  return (
    <div>
      <div className="crumbs">
        <a href="#/catalog">Catalog</a> / Components
      </div>
      <div className="page-head">
        <div className="row">
          <h1 style={{ margin: 0 }}>{c.title}</h1>
          <LifecycleTag lifecycle={c.lifecycle} />
          <Tag>
            {c.id}@{c.catalogVersion}
          </Tag>
        </div>
        <p style={{ marginTop: 8 }}>{c.summary}</p>
      </div>

      <div className="split-side">
        <div className="stack-lg">
          <section className="card">
            <h2>Published packages</h2>
            <p className="muted small">
              Apps import these exact paths. A package's runtime files (its gnomod.toml module line and non-test .gno
              files) must hash to the manifest digest:
            </p>
            <p className="digest">{c.sourceDigest}</p>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {Object.entries(c.packages).map(([net, path]) => {
                    const native = nativeUrl(net, path);
                    return (
                      <tr key={net}>
                        <td className="nowrap">{catalog.networks.get(net)?.title ?? net}</td>
                        <td className="break">
                          {native ? (
                            <a href={native} target="_blank" rel="noopener noreferrer" className="mono">
                              {path}
                            </a>
                          ) : (
                            <span className="mono">{path}</span>
                          )}
                        </td>
                        <td className="nowrap">
                          <ChainCheck networkId={net} pkgPath={path} expected={c.sourceDigest} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <h2>Source</h2>
            <Loaded q={src} what="the source">
              {(files) => {
                const runtime = Object.fromEntries(Object.entries(files).filter(([n]) => isRuntime(n)));
                const tests = Object.fromEntries(Object.entries(files).filter(([n]) => !isRuntime(n)));
                const local = bundleDigest(runtime);
                return (
                  <>
                    {local !== c.sourceDigest && (
                      <Notice tone="warn" title="This build's source differs from the manifest digest">
                        <p>The catalog needs regenerating (pnpm regen:fixtures).</p>
                      </Notice>
                    )}
                    <Tabs
                      tabs={[
                        { id: "runtime", label: "Runtime", count: Object.keys(runtime).length },
                        { id: "tests", label: "Tests", count: Object.keys(tests).length },
                      ]}
                      value={tab}
                      onChange={setTab}
                    />
                    <FileBrowser files={tab === "runtime" ? runtime : tests} />
                  </>
                );
              }}
            </Loaded>
          </section>
        </div>

        <aside className="stack-lg">
          <section className="card">
            <p className="panel-title">Details</p>
            <dl className="kv">
              <dt>Type</dt>
              <dd>{c.kind === "library" ? "Library (state lives in the app)" : "Adapter to a shared realm"}</dd>
              <dt>State</dt>
              <dd>{{ none: "None", "host-realm": "Owned by the host app", "shared-realm": "Owned by a shared realm" }[c.stateOwner]}</dd>
              <dt>License</dt>
              <dd>{c.license}</dd>
              <dt>Maintainer</dt>
              <dd>{c.maintainer}</dd>
              <dt>Source</dt>
              <dd className="mono small">{c.source}</dd>
            </dl>
          </section>
          <section className="card">
            <p className="panel-title">Review</p>
            <div className="row" style={{ marginBottom: 8 }}>
              <Tag tone={c.review.status === "independent" ? "ok" : c.review.status === "internal" ? "info" : "bad"}>
                {{ unreviewed: "Unreviewed", internal: "Internal review", independent: "Independent review" }[c.review.status]}
              </Tag>
            </div>
            <p className="small muted">{c.review.scope}</p>
          </section>
          <section className="card">
            <p className="panel-title">Interfaces</p>
            <dl className="kv">
              <dt>Provides</dt>
              <dd>{c.provides.length ? c.provides.map((p) => <Tag key={p} tone="info">{p}</Tag>) : "—"}</dd>
              <dt>Requires</dt>
              <dd>{c.requires.length ? c.requires.map((p) => <Tag key={p}>{p}</Tag>) : "—"}</dd>
              <dt>Imports</dt>
              <dd>
                {c.componentDependencies.map((d) => (
                  <div key={d}>
                    <a href={`#/components/${d}`}>{d}</a>
                  </div>
                ))}
                {c.dependencies.map((d) => (
                  <div key={d} className="mono small">
                    {d}
                  </div>
                ))}
                {c.componentDependencies.length + c.dependencies.length === 0 && "—"}
              </dd>
            </dl>
          </section>
          <section className="card">
            <p className="panel-title">Used by</p>
            {usedBy.map((r) => (
              <div key={r.id}>
                <a href={`#/recipes/${r.id}`}>{r.title}</a> <span className="faint">recipe</span>
              </div>
            ))}
            {dependents.map((d) => (
              <div key={d.id}>
                <a href={`#/components/${d.id}`}>{d.title}</a> <span className="faint">component</span>
              </div>
            ))}
            {usedBy.length + dependents.length === 0 && <p className="faint">Nothing in this catalog yet.</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}
