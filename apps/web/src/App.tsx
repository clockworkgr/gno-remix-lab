import { useEffect } from "react";
import { networkList } from "./lib/catalog.ts";
import { match, useRoute } from "./lib/router.ts";
import { setBrowseNetwork, useBrowseNetwork } from "./lib/store.ts";
import { shortAddress } from "./lib/format.ts";
import { useWallet } from "./hooks/wallet.tsx";
import { HomePage } from "./pages/Home.tsx";
import { CatalogPage } from "./pages/Catalog.tsx";
import { RecipePage } from "./pages/Recipe.tsx";
import { ComponentPage } from "./pages/Component.tsx";
import { DraftsPage } from "./pages/Drafts.tsx";
import { ComposerPage } from "./pages/Composer.tsx";
import { DeployPage } from "./pages/Deploy.tsx";
import { AppsPage } from "./pages/Apps.tsx";
import { InspectorPage } from "./pages/Inspector.tsx";

function WalletButton() {
  const { wallet, account, connecting, error, connect, disconnect } = useWallet();
  const net = useBrowseNetwork();
  if (account) {
    return (
      <div className="row">
        <span className="tag" title={`${account.address} on ${account.chainId}`}>
          <span className="dot" style={{ color: "var(--ok)" }} /> {shortAddress(account.address)}
          <span className="faint">· {account.chainId}</span>
        </span>
        <button className="btn btn-sm btn-ghost" onClick={disconnect}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="row">
      {error && <span className="faint" title={error} style={{ color: "var(--bad)" }}>Wallet error</span>}
      <button
        className="btn btn-sm"
        disabled={connecting}
        onClick={() => (wallet.available() ? void connect(net) : window.open(wallet.installUrl, "_blank", "noopener"))}
        title={wallet.available() ? "Connect Adena" : "Adena is not installed"}
      >
        {connecting ? "Connecting…" : wallet.available() ? "Connect wallet" : "Get Adena"}
      </button>
    </div>
  );
}

function NetworkPicker() {
  const net = useBrowseNetwork();
  return (
    <label className="row small" title="Network used for browsing and inspecting apps">
      <span className="faint">Network</span>
      <select className="select" style={{ width: "auto", padding: "4px 8px" }} value={net} onChange={(e) => setBrowseNetwork(e.target.value)}>
        {networkList().map((n) => (
          <option key={n.id} value={n.id}>
            {n.title}
          </option>
        ))}
      </select>
    </label>
  );
}

const NAV = [
  { href: "#/catalog", label: "Catalog", match: ["/catalog", "/recipes", "/components"] },
  { href: "#/compose", label: "Compose", match: ["/compose", "/deploy"] },
  { href: "#/apps", label: "Apps", match: ["/apps"] },
];

function Page() {
  const { path, query } = useRoute();
  let m: Record<string, string> | null;
  if (path === "/" || path === "") return <HomePage />;
  if (path === "/catalog") return <CatalogPage />;
  if ((m = match("/recipes/:id", path))) return <RecipePage id={m.id!} />;
  if ((m = match("/components/:id", path))) return <ComponentPage id={m.id!} />;
  if (path === "/compose") return <DraftsPage />;
  if ((m = match("/compose/:id", path))) return <ComposerPage id={m.id!} />;
  if ((m = match("/deploy/:id", path))) return <DeployPage id={m.id!} />;
  if (path === "/apps") return <AppsPage />;
  if ((m = match("/apps/*", path))) return <InspectorPage pkgPath={m.rest!} query={query} />;
  return (
    <div className="page-head">
      <h1>Page not found</h1>
      <p>
        <a href="#/">Go to the start page</a>
      </p>
    </div>
  );
}

export function App() {
  const { path } = useRoute();
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollTo, which React would treat as a cleanup.
    window.scrollTo(0, 0);
  }, [path]);
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/">
            <span className="brand-mark" aria-hidden>
              RL
            </span>
            Remix Lab
          </a>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className={n.match.some((p) => path.startsWith(p)) ? "active" : undefined}>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="topbar-right">
            <NetworkPicker />
            <WalletButton />
          </div>
        </div>
      </header>
      <main>
        <Page />
      </main>
      <footer>
        <div className="inner">
          <span>Remix Lab · apps assembled from reviewed Gno components</span>
          <span>Drafts stay in this browser until you export them.</span>
        </div>
      </footer>
    </div>
  );
}
