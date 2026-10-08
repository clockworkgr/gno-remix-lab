import { useMemo, useState, type ReactNode } from "react";
import { msgAddPackage } from "@remixlab/chain";
import { generate, GENERATOR_VERSION, type Generated } from "@remixlab/generator";
import { bundleDigest, expectedPackageName } from "@remixlab/spec";
import { catalog, network } from "../lib/catalog.ts";
import { reader, schemas, STORAGE_PER_SOURCE_BYTE, STORAGE_UGNOT_PER_BYTE } from "../lib/chain.ts";
import { bytes, gnot, shortDigest, utf8Length } from "../lib/format.ts";
import { href } from "../lib/router.ts";
import { addReceipt, getDraft, useDrafts, type Receipt } from "../lib/store.ts";
import { useQuery } from "../hooks/query.ts";
import { useTx } from "../hooks/tx.ts";
import { useWallet } from "../hooks/wallet.tsx";
import { FileBrowser } from "../components/CodeView.tsx";
import { TxStatus } from "../components/TxStatus.tsx";
import { Notice, Spinner, Tag } from "../components/ui.tsx";

type Check = { status: "ok" | "bad" | "warn"; title: string; detail: ReactNode };

const GAS_WANTED = 80_000_000;
const GAS_FEE_HINT = 100_000;

async function runChecks(g: Generated, signer: string): Promise<Check[]> {
  const net = g.lock.network.id;
  const r = reader(net);
  const pkgPath = g.spec.app.pkgPath;
  const out: Check[] = [];

  const ns = `gno.land/r/${signer}/`;
  out.push(
    pkgPath.startsWith(ns)
      ? { status: "ok", title: "The path is in your namespace", detail: <span className="mono break">{ns}</span> }
      : {
          status: network(net).kind === "local" ? "warn" : "bad",
          title: "The path is not in your address namespace",
          detail:
            network(net).kind === "local"
              ? "A local node may accept it. Public networks only accept your own address namespace or a username you registered."
              : `Change the realm path to start with ${ns}, or use a username you have registered on this network.`,
        },
  );

  const existing = await r.files(pkgPath);
  out.push(
    existing === null
      ? { status: "ok", title: "The realm path is free", detail: <span className="mono break">{pkgPath}</span> }
      : { status: "bad", title: "A package already exists at this path", detail: "Packages cannot be replaced. Choose a different app name." },
  );

  const deps = await Promise.all(
    g.lock.components.map(async (c) => {
      const files = await r.readPackage(c.pkgPath);
      if (files === null) return { c, state: "missing" as const };
      return { c, state: bundleDigest(files) === c.sourceDigest ? ("ok" as const) : ("different" as const) };
    }),
  );
  const third = await Promise.all(g.lock.thirdParty.map(async (p) => ({ p, ok: (await r.files(p)) !== null })));
  const badDeps = deps.filter((d) => d.state !== "ok");
  const badThird = third.filter((t) => !t.ok);
  out.push(
    badDeps.length + badThird.length === 0
      ? {
          status: "ok",
          title: `All ${deps.length + third.length} imported packages are on chain`,
          detail: "Each Remix Lab package matches the source digest in its catalog manifest.",
        }
      : {
          status: "bad",
          title: "Some imported packages are missing or different",
          detail: (
            <ul>
              {badDeps.map((d) => (
                <li key={d.c.id} className="break">
                  <span className="mono">{d.c.pkgPath}</span>: {d.state === "missing" ? "not deployed" : "source differs from the catalog digest"}
                </li>
              ))}
              {badThird.map((t) => (
                <li key={t.p} className="mono break">
                  {t.p}: not deployed
                </li>
              ))}
            </ul>
          ),
        },
  );
  return out;
}

export function DeployPage({ id }: { id: string }) {
  useDrafts();
  const draft = getDraft(id);
  const { wallet, account, connect, connecting } = useWallet();
  const result = useMemo(() => (draft ? generate(draft.project, catalog) : undefined), [draft]);
  const g = result?.ok ? result.value : undefined;
  const net = g ? network(g.lock.network.id) : undefined;
  const onNetwork = !!(account && net && account.chainId === net.chainId);
  const signer = onNetwork ? account!.address : undefined;

  // Any change to the signer, network or bundle re-runs the checks and invalidates the review.
  const planKey = g && signer ? `${signer}|${g.lock.network.id}|${g.runtimeDigest}|${g.spec.app.pkgPath}` : null;
  const checks = useQuery(planKey, () => runChecks(g!, signer!));
  const [reviewedKey, setReviewedKey] = useState<string | null>(null);
  const size = g ? Object.values(g.runtime).reduce((n, s) => n + utf8Length(s), 0) : 0;
  const estimate = size * STORAGE_PER_SOURCE_BYTE.estimate * STORAGE_UGNOT_PER_BYTE;
  const [depositGnot, setDepositGnot] = useState<string | null>(null);
  const [feeGnot, setFeeGnot] = useState("1");
  const depositCap = depositGnot !== null ? Math.round(Number(depositGnot) * 1e6) : size * STORAGE_PER_SOURCE_BYTE.cap * STORAGE_UGNOT_PER_BYTE;
  const feeCap = Math.round(Number(feeGnot) * 1e6);
  const tx = useTx(g?.lock.network.id ?? "local-dev");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [verifying, setVerifying] = useState(false);

  if (!draft) return <Notice tone="bad" title="This draft is not in this browser" />;
  if (!result?.ok || !g || !net) {
    return (
      <Notice tone="bad" title="This configuration cannot be deployed yet">
        <p>
          <a href={`#/compose/${id}`}>Go back to the composer</a> and fix the problems it lists.
        </p>
      </Notice>
    );
  }

  const blocking = checks.data?.some((c) => c.status === "bad") ?? true;
  const validCaps = Number.isFinite(depositCap) && depositCap > 0 && Number.isFinite(feeCap) && feeCap > 0;
  const reviewed = reviewedKey === planKey;
  const canSign = !!signer && !!checks.data && !blocking && validCaps && reviewed && !tx.busy && tx.state.phase !== "success";

  async function deploy() {
    const pkgPath = g!.spec.app.pkgPath;
    await tx.run(
      (caller) => [
        msgAddPackage({
          creator: caller,
          pkgPath,
          packageName: expectedPackageName(pkgPath),
          files: g!.runtime,
          maxDeposit: `${depositCap}ugnot`,
        }),
      ],
      {
        gasWanted: GAS_WANTED,
        gasFeeUgnot: GAS_FEE_HINT,
        maxFeeUgnot: BigInt(feeCap),
        onSuccess: async (o) => {
          setVerifying(true);
          const r = reader(g!.lock.network.id);
          let digestMatches = false;
          let creatorMatches = false;
          let descriptorRead = false;
          try {
            const files = await r.readPackage(pkgPath);
            if (files) {
              digestMatches = bundleDigest(files) === g!.runtimeDigest;
              const creator = /^\[addpkg\][\s\S]*?^\s*creator\s*=\s*"([^"]*)"/m.exec(files["gnomod.toml"] ?? "")?.[1];
              creatorMatches = creator === signer;
            }
            const [d] = (await r.read(pkgPath, "Descriptor", [], [schemas(g!.lock.network.id).descriptor])).value;
            descriptorRead = d.configDigest === g!.configDigest;
          } catch {
            // recorded as unverified below
          }
          const rec: Receipt = {
            network: g!.lock.network.id,
            chainId: g!.lock.network.chainId,
            pkgPath,
            title: g!.spec.app.title,
            recipe: g!.lock.recipe,
            deployer: signer!,
            txHash: o.hash.hex,
            height: o.height,
            gasUsed: o.gasUsed,
            runtimeDigest: g!.runtimeDigest,
            configDigest: g!.configDigest,
            generatorVersion: GENERATOR_VERSION,
            components: g!.lock.components.map((c) => ({ id: c.id, version: c.version, pkgPath: c.pkgPath, sourceDigest: c.sourceDigest })),
            verification: { digestMatches, creatorMatches, descriptorRead, checkedAt: new Date().toISOString() },
            createdAt: new Date().toISOString(),
          };
          addReceipt(rec);
          setReceipt(rec);
          setVerifying(false);
        },
      },
    );
  }

  return (
    <div>
      <div className="crumbs">
        <a href="#/compose">Compose</a> / <a href={`#/compose/${id}`}>{g.spec.app.title}</a> / Deploy
      </div>
      <div className="page-head">
        <h1>Review and deploy</h1>
        <p>Everything below is exactly what your wallet will be asked to sign. If the wallet's account or network changes, the review starts again.</p>
      </div>

      {!g.supported && (
        <Notice tone="warn" title="Not a supported public release">
          <p>This project uses draft components or an unverified network. Deploy it for testing only.</p>
        </Notice>
      )}

      <div className="split-side" style={{ marginTop: 16 }}>
        <div className="stack-lg">
          <section className="card">
            <h2>1. Wallet</h2>
            {!wallet.available() ? (
              <Notice tone="warn" title="Adena is not installed">
                <p>
                  Install <a href={wallet.installUrl} target="_blank" rel="noopener noreferrer">Adena</a> and reload this page,
                  or download the project and follow DEPLOY.md to deploy with gnokey.
                </p>
              </Notice>
            ) : onNetwork ? (
              <p>
                Signing as <span className="mono break">{account!.address}</span> on <strong>{net.title}</strong> ({net.chainId}).
              </p>
            ) : (
              <div className="row">
                <button className="btn btn-primary" disabled={connecting} onClick={() => void connect(net.id)}>
                  {account ? `Switch wallet to ${net.title}` : `Connect to ${net.title}`}
                </button>
                {account && <span className="faint">The wallet is on {account.chainId}.</span>}
              </div>
            )}
          </section>

          <section className="card">
            <h2>2. Checks against {net.title}</h2>
            {!signer ? (
              <p className="muted">Connect the wallet to run the checks.</p>
            ) : checks.loading && !checks.data ? (
              <div className="row muted">
                <Spinner /> Checking the path and dependencies on chain…
              </div>
            ) : checks.error ? (
              <Notice tone="bad" title="The checks could not run">
                <p className="break">{checks.error.message}</p>
                <button className="btn btn-sm" onClick={checks.refresh}>
                  Try again
                </button>
              </Notice>
            ) : (
              <>
                <ul className="steps">
                  {checks.data!.map((c) => (
                    <li key={c.title}>
                      <span className={`step-icon step-${c.status}`}>{c.status === "ok" ? "✓" : c.status === "bad" ? "✕" : "!"}</span>
                      <div>
                        <div className="step-title">{c.title}</div>
                        <div className="step-detail">{c.detail}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                <button className="btn btn-sm btn-ghost" onClick={checks.refresh} style={{ marginTop: 8 }}>
                  Check again {checks.at && <span className="faint">· last {checks.at.toLocaleTimeString()}</span>}
                </button>
              </>
            )}
          </section>

          <section className="card">
            <h2>3. The package</h2>
            <dl className="kv" style={{ marginBottom: 16 }}>
              <dt>Realm path</dt>
              <dd className="mono">{g.spec.app.pkgPath}</dd>
              <dt>Package name</dt>
              <dd className="mono">{expectedPackageName(g.spec.app.pkgPath)}</dd>
              <dt>Runtime digest</dt>
              <dd className="digest">{g.runtimeDigest}</dd>
              <dt>Files</dt>
              <dd>
                {Object.keys(g.runtime).length} files, {bytes(size)}. Tests and project metadata are not uploaded.
              </dd>
              <dt>Imports</dt>
              <dd>
                {g.lock.components.map((c) => (
                  <div key={c.id} className="mono small break">
                    {c.pkgPath} <span className="faint">{shortDigest(c.sourceDigest)}</span>
                  </div>
                ))}
                {g.lock.thirdParty.map((p) => (
                  <div key={p} className="mono small break">
                    {p}
                  </div>
                ))}
              </dd>
            </dl>
            <FileBrowser files={g.runtime} />
          </section>
        </div>

        <aside className="stack-lg sticky">
          <section className="card">
            <p className="panel-title">Transaction</p>
            <p className="small">
              One <strong>add-package</strong> transaction. When it runs, the app's <code>init</code> makes{" "}
              {signer ? <span className="mono">{signer.slice(0, 10)}…</span> : "your address"} its first owner.
            </p>
            <dl className="kv">
              <dt>Storage</dt>
              <dd>
                about {gnot(estimate)}
                <div className="faint">locked as a deposit, {STORAGE_UGNOT_PER_BYTE} ugnot per byte stored</div>
              </dd>
              <dt>Gas</dt>
              <dd>up to {(GAS_WANTED / 1e6).toFixed(0)}M; your wallet shows the exact fee</dd>
            </dl>
            <div className="fields" style={{ marginTop: 14 }}>
              <div className="field">
                <label htmlFor="dep">Deposit limit (GNOT)</label>
                <input id="dep" className="input" inputMode="decimal" value={depositGnot ?? String(depositCap / 1e6)} onChange={(e) => setDepositGnot(e.target.value)} />
                <span className="hint">The chain refuses to take more than this.</span>
              </div>
              <div className="field">
                <label htmlFor="fee">Fee limit (GNOT)</label>
                <input id="fee" className="input" inputMode="decimal" value={feeGnot} onChange={(e) => setFeeGnot(e.target.value)} />
                <span className="hint">The Lab will not broadcast a costlier transaction.</span>
              </div>
            </div>
            {!validCaps && <p className="err small">Enter positive limits.</p>}
            <label className="check" style={{ marginTop: 14 }}>
              <input type="checkbox" checked={reviewed} disabled={!planKey} onChange={(e) => setReviewedKey(e.target.checked ? planKey : null)} />
              I reviewed the path, the files and the limits.
            </label>
            <div className="stack" style={{ marginTop: 14 }}>
              <button className="btn btn-primary btn-lg" disabled={!canSign} onClick={() => void deploy()}>
                Sign and deploy
              </button>
              <TxStatus state={tx.state} success="Deployed." onDismiss={tx.state.phase === "success" ? undefined : tx.reset} />
              {verifying && (
                <div className="row muted small">
                  <Spinner /> Reading the package back to verify it…
                </div>
              )}
              {receipt && (
                <Notice tone={receipt.verification.digestMatches && receipt.verification.creatorMatches ? "ok" : "warn"} title="Deployment receipt">
                  <ul className="small">
                    <li>{receipt.verification.digestMatches ? "On-chain files match the reviewed bundle." : "Could not confirm the on-chain files match; check the inspector."}</li>
                    <li>{receipt.verification.creatorMatches ? "The chain records you as the creator." : "Could not confirm the creator."}</li>
                    <li>{receipt.verification.descriptorRead ? "The app answers reads with this configuration." : "The app's descriptor could not be read yet."}</li>
                  </ul>
                  <a className="btn btn-primary" href={href(`/apps/${receipt.pkgPath}`, { net: receipt.network })}>
                    Open the app
                  </a>
                </Notice>
              )}
            </div>
          </section>
          <section className="card">
            <p className="panel-title">Prefer the command line?</p>
            <p className="small muted">
              The <a href={`#/compose/${id}`}>Export tab</a> downloads the project with DEPLOY.md: the same bundle, deployed with gnokey.
            </p>
            {tx.state.phase === "unknown" && <Tag tone="draft">Check the path before deploying again</Tag>}
          </section>
        </aside>
      </div>
    </div>
  );
}
