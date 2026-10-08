import { useState } from "react";
import { catalog, referenceApps } from "../lib/catalog.ts";
import { nativeUrl } from "../lib/chain.ts";
import { href, navigate } from "../lib/router.ts";
import { useBrowseNetwork, useReceipts } from "../lib/store.ts";
import { Empty, Tag } from "../components/ui.tsx";

export function AppsPage() {
  const net = useBrowseNetwork();
  const receipts = useReceipts().filter((r) => r.network === net);
  const [path, setPath] = useState("");
  const normalized = path.trim().replace(/^https?:\/\/[^/]+\//, "gno.land/").replace(/^\/?(r|p)\//, "gno.land/$1/").replace(/:.*$/, "");
  const valid = /^gno\.land\/[rp]\/[a-z0-9_\-/]+$/.test(normalized);
  const netTitle = catalog.networks.get(net)?.title ?? net;

  return (
    <div>
      <div className="page-head">
        <h1>Apps</h1>
        <p>
          Open any deployed app to use it, read its native page, and check its source against what was reviewed. Showing{" "}
          {netTitle}; change the network in the header.
        </p>
      </div>

      <form
        className="card row"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) navigate(`/apps/${normalized}`, { net });
        }}
      >
        <input
          className="input grow mono"
          style={{ minWidth: 220 }}
          placeholder="gno.land/r/… or a gnoweb URL"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          aria-label="Realm path"
          spellCheck={false}
        />
        <button className="btn btn-primary" disabled={!valid}>
          Open
        </button>
      </form>

      <section className="section">
        <h2>Your deployments</h2>
        {receipts.length === 0 ? (
          <Empty>
            Apps you deploy from this browser appear here, with their receipts. <a href="#/compose">Compose one</a>.
          </Empty>
        ) : (
          <div className="grid grid-3">
            {receipts.map((r) => (
              <a key={r.pkgPath} className="card card-link" href={href(`/apps/${r.pkgPath}`, { net })}>
                <div className="row-between">
                  <h3>{r.title}</h3>
                  {r.verification.digestMatches ? <Tag tone="ok">verified</Tag> : <Tag tone="draft">unverified</Tag>}
                </div>
                <p className="faint mono break">{r.pkgPath}</p>
                <p className="faint" style={{ marginBottom: 0 }}>
                  {catalog.recipes.get(r.recipe.id)?.title} · block {r.height} · {new Date(r.createdAt).toLocaleDateString()}
                </p>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Reference apps</h2>
        <p className="muted">The maintainer's deployments of each recipe's default configuration and of the shared membership example.</p>
        <div className="grid grid-3">
          {referenceApps.map((a) => {
            const native = nativeUrl(net, a.pkgPath);
            return (
              <div className="card" key={a.pkgPath}>
                <h3>{a.title}</h3>
                <p className="muted small">{a.summary}</p>
                <p className="faint mono break">{a.pkgPath.replace(/^gno\.land/, "")}</p>
                <div className="card-foot row">
                  <a className="btn btn-sm btn-primary" href={href(`/apps/${a.pkgPath}`, { net })}>
                    Open
                  </a>
                  {native && (
                    <a className="btn btn-sm btn-ghost" href={native} target="_blank" rel="noopener noreferrer">
                      Native ↗
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
