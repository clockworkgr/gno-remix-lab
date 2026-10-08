import { useCallback, useMemo, useState } from "react";
import { ChainError, type AppDescriptor, type BallotView } from "@remixlab/chain";
import { bundleDigest } from "@remixlab/spec";
import { catalog, referenceApp, sourceFiles } from "../lib/catalog.ts";
import { nativeUrl, reader, schemas } from "../lib/chain.ts";
import { shortDigest } from "../lib/format.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { href, navigate } from "../lib/router.ts";
import { receiptFor, useBrowseNetwork, useReceipts } from "../lib/store.ts";
import { useQuery } from "../hooks/query.ts";
import { useTx, type TxOptions } from "../hooks/tx.ts";
import { useWallet } from "../hooks/wallet.tsx";
import {
  AppProvider,
  callMsg,
  can,
  EntryCard,
  MembersView,
  PollCard,
  PollsView,
  QueueView,
  RulesView,
  SubmitForm,
  useApp,
  useEntriesPage,
  useFields,
  useRead,
  type AppCtx,
  type Role,
} from "../components/appviews.tsx";
import { FileBrowser } from "../components/CodeView.tsx";
import { TxStatus } from "../components/TxStatus.tsx";
import { Empty, Loaded, Notice, Spinner, Tabs, Tag } from "../components/ui.tsx";
import { startDraft } from "./Drafts.tsx";

type Kind = "club-poll" | "community-directory" | "demo-contest" | "shared-poll-demo" | "shared-membership" | "unknown";
type Tab = "app" | "page" | "source" | "about";

function isNotFound(e: unknown) {
  return e instanceof ChainError;
}

async function readDescriptor(net: string, pkgPath: string): Promise<AppDescriptor | null> {
  try {
    return (await reader(net).read(pkgPath, "Descriptor", [], [schemas(net).descriptor])).value[0];
  } catch (e) {
    // Realms without a descriptor (e.g. the shared membership service) answer with a VM error.
    if (isNotFound(e)) return null;
    throw e;
  }
}

function kindOf(net: string, pkgPath: string, d: AppDescriptor | null): Kind {
  if (d && ["club-poll", "community-directory", "demo-contest", "shared-poll-demo"].includes(d.recipe)) return d.recipe as Kind;
  const adapter = [...catalog.components.values()].find((c) => c.kind === "adapter" && c.packages[net] === pkgPath);
  if (adapter?.id === "shared-membership") return "shared-membership";
  return "unknown";
}

async function readRole(net: string, pkgPath: string, kind: Kind, me: string): Promise<Role> {
  const r = reader(net);
  const s = schemas(net);
  if (kind === "shared-membership") {
    const role = { kind: "enum", type: `${catalog.components.get("core")!.packages[net]}.Role`, names: ["none", "member", "reviewer", "owner"] } as const;
    return (await r.read(pkgPath, "RoleOf", [{ address: me }], [role])).value[0];
  }
  const fn = kind === "shared-poll-demo" ? "AdminRole" : "RoleOf";
  const [v] = (await r.read(pkgPath, fn, [{ address: me }], [s.string])).value;
  return (["none", "member", "reviewer", "owner"].includes(v) ? v : "none") as Role;
}

export function InspectorPage({ pkgPath, query }: { pkgPath: string; query: URLSearchParams }) {
  const browseNet = useBrowseNetwork();
  const net = query.get("net") && catalog.networks.has(query.get("net")!) ? query.get("net")! : browseNet;
  const renderPath = query.get("path") ?? "";
  const tab = (["app", "page", "source", "about"].includes(query.get("tab") ?? "") ? query.get("tab") : "app") as Tab;
  const setTab = (t: Tab) => navigate(`/apps/${pkgPath}`, { net, tab: t, ...(t === "page" && renderPath ? { path: renderPath } : {}) }, true);
  useReceipts();

  const { account } = useWallet();
  const chainId = catalog.networks.get(net)?.chainId;
  const me = account && account.chainId === chainId ? account.address : undefined;
  const [version, setVersion] = useState(0);
  const tx = useTx(net);

  const validPath = /^gno\.land\/[rp]\/[a-z0-9_\-/]+$/.test(pkgPath);
  const exists = useQuery(validPath ? `${net}|${pkgPath}|exists` : null, async () => (await reader(net).files(pkgPath)) !== null);
  const desc = useQuery(exists.data ? `${net}|${pkgPath}|desc` : null, () => readDescriptor(net, pkgPath));
  const kind: Kind | undefined = desc.data !== undefined ? kindOf(net, pkgPath, desc.data) : undefined;
  const role = useQuery(kind && me && kind !== "unknown" ? `${net}|${pkgPath}|role|${me}|${version}` : null, () => readRole(net, pkgPath, kind!, me!));
  const hasRules = kind === "club-poll" || kind === "community-directory" || kind === "demo-contest";
  const rules = useQuery(hasRules ? `${net}|${pkgPath}|rules|${version}` : null, async () => (await reader(net).read(pkgPath, "Rules", [], [schemas(net).rules!])).value[0]);

  const act = useCallback(
    (func: string, args: Array<string | number | bigint>, opts: TxOptions = {}) => {
      const ctxStub = { pkgPath } as AppCtx;
      void tx.run(callMsg(ctxStub, func, args), {
        ...opts,
        onSuccess: async (o) => {
          setVersion((v) => v + 1);
          await opts.onSuccess?.(o);
        },
      });
    },
    [pkgPath, tx],
  );

  const app: AppCtx = useMemo(
    () => ({ net, pkgPath, me, role: role.data ?? "none", rules: hasRules ? rules.data : undefined, version, busy: tx.busy, act }),
    [net, pkgPath, me, role.data, hasRules, rules.data, version, tx.busy, act],
  );

  const ref = referenceApp(pkgPath);
  const receipt = receiptFor(net, pkgPath);
  const native = nativeUrl(net, pkgPath, renderPath);
  const title = receipt?.title ?? ref?.title ?? pkgPath.split("/").pop();

  if (!validPath) return <Notice tone="bad" title="That is not a gno.land package path" />;

  return (
    <div>
      <div className="crumbs">
        <a href="#/apps">Apps</a> / <span className="mono">{pkgPath.replace(/^gno\.land/, "")}</span>
      </div>
      <div className="page-head row-between">
        <div>
          <div className="row">
            <h1 style={{ margin: 0 }}>{title}</h1>
            {desc.data && <Tag tone="info">{desc.data.recipe}@{desc.data.recipeVersion}</Tag>}
            {me && role.data && role.data !== "none" && <Tag tone="accent">you: {role.data}</Tag>}
          </div>
          <p className="faint break" style={{ marginTop: 6 }}>
            <span className="mono">{pkgPath}</span> · {catalog.networks.get(net)?.title}
          </p>
        </div>
        <div className="row">
          {native && (
            <a className="btn" href={native} target="_blank" rel="noopener noreferrer">
              Native page ↗
            </a>
          )}
        </div>
      </div>

      {exists.loading && (
        <div className="row muted">
          <Spinner /> Looking up the package on {catalog.networks.get(net)?.title}…
        </div>
      )}
      {exists.error && (
        <Notice tone="bad" title="Could not reach the network">
          <p className="break">{exists.error.message}</p>
          <button className="btn btn-sm" onClick={exists.refresh}>
            Try again
          </button>
        </Notice>
      )}
      {exists.data === false && (
        <Notice tone="warn" title={`Nothing is deployed at this path on ${catalog.networks.get(net)?.title}`}>
          <p>Check the path and the network selector in the header.</p>
        </Notice>
      )}

      {exists.data && (
        <AppProvider value={app}>
          <Tabs
            tabs={[
              { id: "app", label: "App" },
              { id: "page", label: "Native page" },
              { id: "source", label: "Source" },
              { id: "about", label: "Composition" },
            ]}
            value={tab}
            onChange={setTab}
          />
          <div style={{ marginBottom: 16 }}>
            <TxStatus state={tx.state} onDismiss={tx.reset} />
          </div>
          {tab === "app" &&
            (desc.loading || kind === undefined ? (
              <Loaded q={desc} what="the app">
                {() => null}
              </Loaded>
            ) : (
              <AppView kind={kind} />
            ))}
          {tab === "page" && <NativePage net={net} pkgPath={pkgPath} renderPath={renderPath} version={version} />}
          {tab === "source" && <SourceTab net={net} pkgPath={pkgPath} />}
          {tab === "about" && <About net={net} pkgPath={pkgPath} desc={desc.data ?? null} kind={kind} />}
        </AppProvider>
      )}
    </div>
  );
}

function AppView({ kind }: { kind: Kind }) {
  const app = useApp();
  const [section, setSection] = useState<string>("main");
  const sections: Record<Kind, Array<{ id: string; label: string }>> = {
    "club-poll": [
      { id: "main", label: "Polls" },
      { id: "members", label: "Members" },
      { id: "rules", label: "Rules" },
    ],
    "shared-poll-demo": [{ id: "main", label: "Polls" }],
    "community-directory": [
      { id: "main", label: "Directory" },
      { id: "queue", label: "Review queue" },
      { id: "members", label: "Members" },
      { id: "rules", label: "Rules" },
    ],
    "demo-contest": [
      { id: "main", label: "Contest" },
      { id: "queue", label: "Review queue" },
      { id: "members", label: "Members" },
      { id: "rules", label: "Rules" },
    ],
    "shared-membership": [{ id: "main", label: "Members" }],
    unknown: [],
  };
  if (kind === "unknown") {
    return (
      <Notice title="Not a Remix Lab app">
        <p>This package has no Remix Lab descriptor, so there is no Lab view. Its native page and source are still available in the other tabs.</p>
      </Notice>
    );
  }
  const current = sections[kind].some((s) => s.id === section) ? section : "main";
  return (
    <div className="stack-lg">
      {!app.me && <Notice>Connect a wallet on this network to take part. Reading needs no wallet.</Notice>}
      {sections[kind].length > 1 && (
        <div className="segmented" role="group" aria-label="Section">
          {sections[kind].map((s) => (
            <button key={s.id} aria-pressed={s.id === current} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      {current === "members" && <MembersView invitations={!!app.rules?.some((r) => r.op === "members.invite")} />}
      {current === "rules" && <RulesView />}
      {current === "main" && kind === "club-poll" && <PollsView ops={{ create: "poll.create", open: "poll.open" }} />}
      {current === "main" && kind === "shared-poll-demo" && <SharedPoll />}
      {current === "main" && kind === "shared-membership" && <MembersView invitations />}
      {kind === "community-directory" && current !== "members" && current !== "rules" && <Directory section={current} />}
      {kind === "demo-contest" && current !== "members" && current !== "rules" && <Contest section={current} />}
    </div>
  );
}

function SharedPoll() {
  const app = useApp();
  const desc = useQuery(`${app.net}|${app.pkgPath}|desc`, () => readDescriptor(app.net, app.pkgPath));
  const binding = desc.data?.bindings.find((b) => b.startsWith("membership.read/v1="))?.split("=")[1];
  return (
    <div className="stack-lg">
      <Notice>
        <p>
          The electorate comes from a shared membership service
          {binding && (
            <>
              {" "}
              (<a href={href(`/apps/${binding}`, { net: app.net })}>{binding.split("/").pop()}</a>)
            </>
          )}
          . Join there to vote in polls opened afterwards. Poll administration here is limited to this app's own admins.
        </p>
      </Notice>
      <PollsView ops={{ create: "poll.create", open: "poll.open" }} />
    </div>
  );
}

function Directory({ section }: { section: string }) {
  const app = useApp();
  const fields = useFields(app);
  const entries = useEntriesPage(app, true);
  return (
    <Loaded q={fields} what="the form">
      {(fs) =>
        section === "queue" ? (
          <QueueView fields={fs} reviewOp="entry.review" />
        ) : (
          <div className="split">
            <div className="stack">
              <p className="panel-title">Listed entries</p>
              <Loaded q={entries} what="entries">
                {(list) =>
                  list.length === 0 ? (
                    <Empty>Nothing has been accepted yet.</Empty>
                  ) : (
                    <>
                      {list.map((e) => (
                        <EntryCard key={e.id} e={e} fields={fs} />
                      ))}
                    </>
                  )
                }
              </Loaded>
            </div>
            <div>{can(app, "entry.submit") || !app.me ? <SubmitForm fields={fs} /> : <Notice>Submitting is limited by this app's rules.</Notice>}</div>
          </div>
        )
      }
    </Loaded>
  );
}

function Contest({ section }: { section: string }) {
  const app = useApp();
  const fields = useFields(app);
  const s = schemas(app.net);
  const state = useRead(app, "contest", async () => {
    const r = reader(app.net);
    const [ballot, hasBallot] = (await r.read(app.pkgPath, "Ballot", [], [s.ballot, s.bool])).value;
    const [ids] = (await r.read(app.pkgPath, "BallotEntries", [], [s.uint64s])).value;
    return { ballot: hasBallot ? (ballot as BallotView) : null, ids };
  });
  const entries = useEntriesPage(app, false);
  const [seconds, setSeconds] = useState(86400);

  return (
    <Loaded q={fields} what="the form">
      {(fs) => (
        <Loaded q={state} what="the contest">
          {({ ballot, ids }) =>
            section === "queue" ? (
              <>
                {ballot && <Notice>Voting has opened, so the entries are fixed and review is closed.</Notice>}
                <QueueView fields={fs} reviewOp="entry.review" locked={!!ballot} />
              </>
            ) : (
              <div className="split">
                <div className="stack">
                  {ballot ? (
                    <PollCard b={ballot} ops={{ open: "contest.open", create: "contest.open" }} entries={ids} />
                  ) : (
                    <Notice>Voting has not opened yet. Accepted entries below will be on the ballot.</Notice>
                  )}
                  <p className="panel-title" style={{ marginTop: 12 }}>
                    Accepted entries
                  </p>
                  <Loaded q={entries} what="entries">
                    {(list) => (list.length === 0 ? <Empty>No accepted entries yet.</Empty> : <>{list.map((e) => <EntryCard key={e.id} e={e} fields={fs} />)}</>)}
                  </Loaded>
                </div>
                <div className="stack">
                  {!ballot && (can(app, "entry.submit") || !app.me) && <SubmitForm fields={fs} title="Enter the contest" />}
                  {!ballot && can(app, "contest.open") && (
                    <div className="card">
                      <h3>Open voting</h3>
                      <p className="faint">Freezes the accepted entries (at least two) and the electorate.</p>
                      <div className="row" style={{ flexWrap: "nowrap" }}>
                        <input className="input" inputMode="numeric" value={String(seconds / 3600)} onChange={(e) => setSeconds(Math.round(Number(e.target.value) * 3600) || 0)} aria-label="Hours" />
                        <span className="faint nowrap">hours</span>
                        <button className="btn btn-primary" disabled={app.busy || seconds < 60} onClick={() => app.act("OpenVoting", [seconds])}>
                          Open voting
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          }
        </Loaded>
      )}
    </Loaded>
  );
}

function NativePage({ net, pkgPath, renderPath, version }: { net: string; pkgPath: string; renderPath: string; version: number }) {
  const page = useQuery(`${net}|${pkgPath}|render|${renderPath}|${version}`, async () => (await reader(net).render(pkgPath, renderPath)).value);
  const html = useMemo(() => (page.data !== undefined ? renderMarkdown(page.data, net) : ""), [page.data, net]);
  return (
    <div className="card">
      <div className="row-between faint" style={{ marginBottom: 12 }}>
        <span>
          Render(<span className="mono">{JSON.stringify(renderPath)}</span>) as the realm returns it, read {page.at?.toLocaleTimeString() ?? "…"}
        </span>
        {renderPath && (
          <a href={href(`/apps/${pkgPath}`, { net, tab: "page" })} className="small">
            Home
          </a>
        )}
      </div>
      <Loaded q={page} what="the page">
        {() => <div className="md" dangerouslySetInnerHTML={{ __html: html }} />}
      </Loaded>
    </div>
  );
}

function SourceTab({ net, pkgPath }: { net: string; pkgPath: string }) {
  const files = useQuery(`${net}|${pkgPath}|source`, () => reader(net).readPackage(pkgPath));
  const ref = referenceApp(pkgPath);
  const local = useQuery(ref ? ref.source : null, () => sourceFiles(ref!.source));
  const receipt = receiptFor(net, pkgPath);
  return (
    <Loaded q={files} what="the source">
      {(f) => {
        if (!f) return <Empty>Not deployed.</Empty>;
        const digest = bundleDigest(f);
        const creator = /^\[addpkg\][\s\S]*?^\s*creator\s*=\s*"([^"]*)"/m.exec(f["gnomod.toml"] ?? "")?.[1];
        const localRuntime = local.data
          ? Object.fromEntries(Object.entries(local.data).filter(([n]) => n === "gnomod.toml" || (n.endsWith(".gno") && !n.endsWith("_test.gno") && !n.endsWith("_filetest.gno"))))
          : undefined;
        return (
          <div className="stack-lg">
            <div className="card">
              <dl className="kv">
                <dt>Digest on chain</dt>
                <dd className="digest">{digest}</dd>
                <dt>Deployed by</dt>
                <dd className="mono">{creator ?? "unknown"}</dd>
                {receipt && (
                  <>
                    <dt>Your receipt</dt>
                    <dd>{receipt.runtimeDigest === digest ? <Tag tone="ok">matches what you reviewed</Tag> : <Tag tone="bad">differs from your receipt</Tag>}</dd>
                  </>
                )}
                {localRuntime && (
                  <>
                    <dt>Repository source</dt>
                    <dd>{bundleDigest(localRuntime) === digest ? <Tag tone="ok">matches this build</Tag> : <Tag tone="bad">differs from this build</Tag>}</dd>
                  </>
                )}
              </dl>
              <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
                Read from the node configured for this network. Agreement with one node is an observation, not a proof.
              </p>
            </div>
            <div className="card">
              <FileBrowser files={f} />
            </div>
          </div>
        );
      }}
    </Loaded>
  );
}

function About({ net, pkgPath, desc, kind }: { net: string; pkgPath: string; desc: AppDescriptor | null; kind: Kind | undefined }) {
  const receipt = receiptFor(net, pkgPath);
  const ref = referenceApp(pkgPath);
  const recipeId = desc?.recipe && catalog.recipes.has(desc.recipe) ? desc.recipe : undefined;
  return (
    <div className="split">
      <div className="stack-lg">
        <div className="card">
          <p className="panel-title">Composition</p>
          {desc ? (
            <>
              <dl className="kv" style={{ marginBottom: 12 }}>
                <dt>Recipe</dt>
                <dd>{recipeId ? <a href={`#/recipes/${recipeId}`}>{catalog.recipes.get(recipeId)!.title}</a> : desc.recipe} @{desc.recipeVersion}</dd>
                <dt>Config digest</dt>
                <dd className="digest">{desc.configDigest}</dd>
                <dt>View schema</dt>
                <dd>v{desc.viewSchemaVersion}</dd>
              </dl>
              {desc.components.map((c) => {
                const [id] = c.split("@");
                return (
                  <div className="ingredient" key={c}>
                    <div className="grow">{catalog.components.has(id!) ? <a href={`#/components/${id}`}>{catalog.components.get(id!)!.title}</a> : id}</div>
                    <span className="faint mono">{c}</span>
                  </div>
                );
              })}
              {desc.bindings.length > 0 && (
                <>
                  <p className="panel-title" style={{ marginTop: 16 }}>
                    Shared services
                  </p>
                  {desc.bindings.map((b) => {
                    const [iface, path] = b.split("=");
                    return (
                      <div key={b} className="ingredient">
                        <Tag tone="info">{iface}</Tag>
                        {path === pkgPath ? <span className="faint">provided by this app itself</span> : <a href={href(`/apps/${path}`, { net })} className="mono small break">{path}</a>}
                      </div>
                    );
                  })}
                </>
              )}
            </>
          ) : (
            <p className="muted">{kind === "shared-membership" ? "The shared membership service: other apps read its members to build electorates." : "No Remix Lab descriptor."}</p>
          )}
        </div>
      </div>
      <div className="stack-lg">
        {receipt && (
          <div className="card">
            <p className="panel-title">Your deployment receipt</p>
            <dl className="kv">
              <dt>Deployed</dt>
              <dd>{new Date(receipt.createdAt).toLocaleString()}</dd>
              <dt>Transaction</dt>
              <dd className="mono small break">{receipt.txHash}</dd>
              <dt>Block</dt>
              <dd>{receipt.height}</dd>
              <dt>Gas used</dt>
              <dd>{receipt.gasUsed.toLocaleString()}</dd>
              <dt>Runtime digest</dt>
              <dd className="digest">{shortDigest(receipt.runtimeDigest)}</dd>
              <dt>Verified</dt>
              <dd>
                {receipt.verification.digestMatches && receipt.verification.creatorMatches ? <Tag tone="ok">files and creator</Tag> : <Tag tone="draft">partly</Tag>}
              </dd>
            </dl>
          </div>
        )}
        <div className="card">
          <p className="panel-title">Remix</p>
          <p className="small muted">
            {recipeId ? "Start a new app from the same recipe and change its rules." : "This app was not made from a catalog recipe."}
            {ref && " This is a reference deployment of the default configuration."}
          </p>
          {recipeId && (
            <button className="btn btn-primary" onClick={() => startDraft(recipeId)}>
              Remix this recipe
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
