import { useId, useMemo, useState } from "react";
import { activeOperations, expectedPackageName, parseProject, type Diagnostic, type FormField, type ProjectSpec, type Rule } from "@remixlab/spec";
import { exportProject, generate, GENERATOR_VERSION, type Generated } from "@remixlab/generator";
import { catalog, exampleProjects, networkList } from "../lib/catalog.ts";
import { diffFiles } from "../lib/diff.ts";
import { bytes, download, shortDigest, utf8Length } from "../lib/format.ts";
import { behaviour, permissionLines } from "../lib/permissions.ts";
import { navigate } from "../lib/router.ts";
import { getDraft, updateDraft, useDrafts } from "../lib/store.ts";
import { zip } from "../lib/zip.ts";
import { useWallet } from "../hooks/wallet.tsx";
import { DiffView, FileBrowser, Source } from "../components/CodeView.tsx";
import {
  Choice,
  DurationInput,
  errorsAt,
  fieldOfKind,
  getIn,
  NumberInput,
  RuleSelect,
  setIn,
  TextInput,
  Toggle,
  type Edit,
} from "../components/editors.tsx";
import { LifecycleTag, Notice, Tabs, Tag } from "../components/ui.tsx";

type Project = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function generateSafely(project: unknown): ReturnType<typeof generate> {
  try {
    return generate(project, catalog);
  } catch (e) {
    return { ok: false, diagnostics: [{ path: "", message: `Generation failed: ${(e as Error).message}` }] };
  }
}

/** Keeps the rules map in step with the operations the configuration enables. */
function syncRules(p: Project): Project {
  const parsed = parseProject(p);
  const recipe = catalog.recipes.get(p?.recipe?.id);
  if (!recipe || !p?.config) return p;
  const active = parsed.ok
    ? activeOperations(parsed.value, recipe)
    : recipe.operations.filter((o) => !(o.op === "members.invite" && p.config.membership?.joinMode !== "invitation"));
  const rules: Record<string, Rule> = {};
  for (const o of active) rules[o.op] = (p.config.rules?.[o.op] as Rule | undefined) ?? o.default;
  return setIn(p, ["config", "rules"], rules);
}

export function ComposerPage({ id }: { id: string }) {
  useDrafts(); // re-render on store changes
  const draft = getDraft(id);
  const { account } = useWallet();
  const [tab, setTab] = useState<"summary" | "code" | "changes" | "tests" | "export">("summary");

  const project = (draft?.project ?? {}) as Project;
  const result = useMemo(() => generateSafely(project), [project]);
  const parsed = useMemo(() => parseProject(project), [project]);
  const diags: Diagnostic[] = result.ok ? [] : result.diagnostics;

  if (!draft) {
    return (
      <Notice tone="bad" title="This draft is not in this browser">
        <p>
          Drafts are stored per browser. <a href="#/compose">Start a new one</a> or import an exported project.
        </p>
      </Notice>
    );
  }

  const recipe = catalog.recipes.get(project.recipe?.id);
  const edit: Edit = (path, value) => {
    updateDraft(id, (d) => {
      let next = setIn(d.project as Project, path, value);
      if (path.join(".") === "config.membership.joinMode") next = syncRules(next);
      return { ...d, project: next };
    });
  };
  const bound = { doc: project, edit, diags };

  const namespace = account ? `gno.land/r/${account.address}/` : undefined;
  const appName = typeof project.app?.pkgPath === "string" ? expectedPackageName(project.app.pkgPath) : "app";
  const ownsPath = namespace && typeof project.app?.pkgPath === "string" && project.app.pkgPath.startsWith(namespace);

  return (
    <div>
      <div className="crumbs">
        <a href="#/compose">Compose</a> / {recipe?.title ?? "Draft"}
      </div>
      <div className="page-head row-between">
        <div>
          <div className="row">
            <h1 style={{ margin: 0 }}>{project.app?.title || "Untitled app"}</h1>
            {recipe && <LifecycleTag lifecycle={recipe.lifecycle} />}
          </div>
          <p className="faint" style={{ marginTop: 6 }}>
            {recipe?.title} recipe · saved in this browser {new Date(draft.updatedAt).toLocaleTimeString()}
          </p>
        </div>
        <div className="row">
          <button className="btn btn-primary" disabled={!result.ok} onClick={() => navigate(`/deploy/${id}`)} title={result.ok ? "" : "Fix the problems first"}>
            Review and deploy
          </button>
        </div>
      </div>

      <div className="split">
        {/* Editor */}
        <div className="card">
          <section className="form-section">
            <h3>App</h3>
            <div className="stack">
              <TextInput {...bound} path={["app", "title"]} label="Title" hint="Shown on the app's pages. Up to 60 bytes." />
              <TextInput
                {...bound}
                path={["app", "pkgPath"]}
                label="Realm path"
                hint="Where the app is deployed. It must be in a namespace you control: gno.land/r/<your address>/<name>."
              />
              {namespace && !ownsPath && (
                <div className="row">
                  <button className="btn btn-sm" onClick={() => edit(["app", "pkgPath"], `${namespace}${appName}`)}>
                    Use my namespace
                  </button>
                  <span className="faint mono break">
                    {namespace}
                    {appName}
                  </span>
                </div>
              )}
              <div className="field">
                <label htmlFor={`${id}-net`}>Network</label>
                <select id={`${id}-net`} className="select" value={project.network ?? ""} onChange={(e) => edit(["network"], e.target.value)}>
                  {networkList().map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title} ({n.chainId})
                    </option>
                  ))}
                </select>
                {errorsAt(diags, ["network"]).map((e) => (
                  <span className="err" key={e}>
                    {e}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="form-section">
            <h3>Membership</h3>
            <div className="stack">
              <Choice
                {...bound}
                path={["config", "membership", "joinMode"]}
                label="How people join"
                options={[
                  { value: "invitation", label: "By invitation" },
                  { value: "open", label: "Anyone can join" },
                ]}
              />
              <div className="fields">
                <NumberInput {...bound} path={["config", "membership", "maxMembers"]} label="Maximum members" hint="1 to 1000" />
              </div>
            </div>
          </section>

          {project.recipe?.id === "club-poll" && <BallotSection bound={bound} />}
          {(project.recipe?.id === "community-directory" || project.recipe?.id === "demo-contest") && (
            <FormSection bound={bound} project={project} />
          )}
          {project.recipe?.id === "demo-contest" && <ContestSection bound={bound} />}

          {recipe && (
            <section className="form-section">
              <h3>Permissions</h3>
              <p className="faint">Who may perform each operation. Rules can be made stricter, never looser than the recipe allows.</p>
              <div className="stack">
                {Object.keys(project.config?.rules ?? {}).map((op) => {
                  const o = recipe.operations.find((x) => x.op === op);
                  const path = ["config", "rules", op];
                  return (
                    <RuleRow
                      key={op}
                      op={op}
                      description={o?.description ?? op}
                      value={project.config.rules[op] as Rule}
                      floor={o?.floor ?? "owner"}
                      errors={errorsAt(diags, path)}
                      onChange={(r) => edit(path, r)}
                    />
                  );
                })}
              </div>
            </section>
          )}
        </div>

        {/* Output */}
        <div className="sticky stack">
          <Status result={result} />
          <div className="card">
            <Tabs
              tabs={[
                { id: "summary", label: "Summary" },
                { id: "code", label: "Generated code", count: result.ok ? Object.keys(result.value.runtime).length : undefined },
                { id: "changes", label: "Changes" },
                { id: "tests", label: "Tests" },
                { id: "export", label: "Export" },
              ]}
              value={tab}
              onChange={setTab}
            />
            {tab === "summary" && <Summary result={result} parsed={parsed.ok ? parsed.value : undefined} />}
            {tab === "code" && (result.ok ? <FileBrowser files={result.value.runtime} note={(n) => (n === "gnomod.toml" ? "Package metadata" : "Deployed on chain")} /> : <Blocked />)}
            {tab === "tests" && <TestsTab result={result} />}
            {tab === "changes" && <ChangesTab draftId={id} project={project} baseline={draft.baseline} result={result} />}
            {tab === "export" && <ExportTab project={project} result={result} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Blocked() {
  return <p className="muted">Fix the problems listed above to see the generated code.</p>;
}

// Problems in the app, network and config sections appear next to their fields.
const shownInline = (path: string) => path === "network" || path.startsWith("app.") || path.startsWith("config.");

function Status({ result }: { result: ReturnType<typeof generate> }) {
  if (result.ok) {
    const g = result.value;
    return (
      <Notice tone={g.supported ? "ok" : "info"}>
        <div className="row-between">
          <span>
            <strong>Valid configuration.</strong>{" "}
            {g.supported ? "Ready for review and deployment." : "Uses draft components or an unverified network: fine for testing, not a supported public release."}
          </span>
        </div>
        {g.warnings.length > 0 && <Warnings list={g.warnings} />}
      </Notice>
    );
  }
  const other = result.diagnostics.filter((d) => !shownInline(d.path));
  const count = result.diagnostics.length;
  return (
    <Notice tone="bad" title={`${count} problem${count === 1 ? "" : "s"} to fix`}>
      {other.length > 0 ? (
        <ul className="small">
          {other.slice(0, 10).map((d, i) => (
            <li key={i}>
              {d.path && <code>{d.path}</code>} {d.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small">They are marked next to the fields on the left.</p>
      )}
    </Notice>
  );
}

/** Folds the per-component "is a draft release" warnings into one line. */
function Warnings({ list }: { list: Diagnostic[] }) {
  const drafts = list.map((w) => /^(?:recipe )?(\S+@\S+) is a draft release$/.exec(w.message)?.[1]).filter((x): x is string => !!x);
  const other = list.filter((w) => !/ is a draft release$/.test(w.message));
  return (
    <ul className="small" style={{ marginTop: 6, marginBottom: 0 }}>
      {drafts.length > 0 && <li>Draft releases: {drafts.join(", ")}.</li>}
      {other.map((w, i) => (
        <li key={i}>{w.message}</li>
      ))}
    </ul>
  );
}

function RuleRow({ op, description, value, floor, errors, onChange }: { op: string; description: string; value: Rule; floor: Rule; errors: string[]; onChange: (r: Rule) => void }) {
  const id = useId();
  return (
    <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
      <label htmlFor={id} className="grow small">
        {description}
        <div className="faint mono">{op}</div>
      </label>
      <div className="field" style={{ width: 150, flex: "none" }}>
        <RuleSelect id={id} value={value} floor={floor} onChange={onChange} errors={errors} />
      </div>
    </div>
  );
}

type Bound = { doc: unknown; edit: Edit; diags: Diagnostic[] };

function BallotSection({ bound }: { bound: Bound }) {
  const p = (k: string) => ["config", "ballots", k];
  return (
    <section className="form-section">
      <h3>Polls</h3>
      <div className="stack">
        <Choice
          {...bound}
          path={p("eligibility")}
          label="Who may vote"
          options={[
            { value: "members", label: "Members" },
            { value: "public", label: "Any address" },
          ]}
          hint="Member polls freeze their electorate when they open."
        />
        <Toggle {...bound} path={p("allowAbstain")} label="Allow an explicit abstain vote" />
        <div className="fields">
          <NumberInput {...bound} path={p("quorumPercent")} label="Quorum (%)" hint="0 for none; member polls only" />
          <NumberInput {...bound} path={p("maxOptions")} label="Options per poll" hint="2 to 20" />
          <NumberInput {...bound} path={p("maxBallots")} label="Active polls" hint="Drafts and open polls at once" />
          <DurationInput {...bound} path={p("minDurationSeconds")} label="Shortest poll" />
          <DurationInput {...bound} path={p("maxDurationSeconds")} label="Longest poll" />
          <NumberInput {...bound} path={p("maxTitleBytes")} label="Title length (bytes)" />
          <NumberInput {...bound} path={p("maxOptionBytes")} label="Option length (bytes)" />
        </div>
      </div>
    </section>
  );
}

function ContestSection({ bound }: { bound: Bound }) {
  const p = (k: string) => ["config", "contest", k];
  return (
    <section className="form-section">
      <h3>Voting</h3>
      <div className="stack">
        <Choice
          {...bound}
          path={p("eligibility")}
          label="Who may vote"
          options={[
            { value: "members", label: "Members" },
            { value: "public", label: "Any address" },
          ]}
        />
        <div className="fields">
          <NumberInput {...bound} path={p("maxEntries")} label="Entries on the ballot" hint="2 to 20" />
          <NumberInput {...bound} path={p("quorumPercent")} label="Quorum (%)" />
          <DurationInput {...bound} path={p("minDurationSeconds")} label="Shortest voting period" />
          <DurationInput {...bound} path={p("maxDurationSeconds")} label="Longest voting period" />
        </div>
      </div>
    </section>
  );
}

function FormSection({ bound, project }: { bound: Bound; project: Project }) {
  const fields = (project.config?.form?.fields ?? []) as FormField[];
  const base = ["config", "form"];
  const setFields = (next: FormField[]) => bound.edit([...base, "fields"], next);
  const move = (i: number, d: number) => {
    const next = [...fields];
    const [f] = next.splice(i, 1);
    next.splice(i + d, 0, f!);
    setFields(next);
  };
  return (
    <section className="form-section">
      <h3>Submission form</h3>
      <p className="faint">Each field becomes a parameter of the app's Submit function, in this order.</p>
      <div className="stack">
        {fields.map((f, i) => {
          const at = [...base, "fields", i];
          return (
            <div key={i} className="card" style={{ padding: 14, boxShadow: "none", background: "var(--surface-2)" }}>
              <div className="row-between" style={{ marginBottom: 10 }}>
                <strong className="small">Field {i + 1}</strong>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn btn-sm btn-ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                    ↑
                  </button>
                  <button className="btn btn-sm btn-ghost" disabled={i === fields.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                    ↓
                  </button>
                  <button className="btn btn-sm btn-ghost btn-danger" disabled={fields.length <= 1} onClick={() => setFields(fields.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              </div>
              <div className="fields">
                <TextInput {...bound} path={[...at, "name"]} label="Name" hint="lowercase identifier" />
                <TextInput {...bound} path={[...at, "label"]} label="Label" />
                <div className="field">
                  <label>Kind</label>
                  <select className="select" value={f.kind} onChange={(e) => bound.edit(at, fieldOfKind(f, e.target.value as FormField["kind"]))}>
                    <option value="text">Text</option>
                    <option value="integer">Integer</option>
                    <option value="choice">Choice</option>
                  </select>
                </div>
                {f.kind === "text" && <NumberInput {...bound} path={[...at, "maxBytes"]} label="Max bytes" />}
                {f.kind === "integer" && (
                  <>
                    <NumberInput {...bound} path={[...at, "min"]} label="Minimum" />
                    <NumberInput {...bound} path={[...at, "max"]} label="Maximum" />
                  </>
                )}
              </div>
              {f.kind === "choice" && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>Choices, one per line</label>
                  <textarea
                    className={`textarea${errorsAt(bound.diags, [...at, "choices"]).length ? " invalid" : ""}`}
                    value={(f.choices ?? []).join("\n")}
                    onChange={(e) => bound.edit([...at, "choices"], e.target.value.split("\n"))}
                    rows={4}
                  />
                  {bound.diags
                    .filter((d) => d.path.startsWith([...at, "choices"].join(".")))
                    .map((d, k) => (
                      <span className="err" key={k}>
                        {d.message}
                      </span>
                    ))}
                </div>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                <Toggle {...bound} path={[...at, "required"]} label="Required" />
                {f.kind === "text" && <Toggle {...bound} path={[...at, "multiline"]} label="Multi-line" />}
              </div>
            </div>
          );
        })}
        {errorsAt(bound.diags, [...base, "fields"]).map((e) => (
          <span className="err small" key={e}>
            {e}
          </span>
        ))}
        <div>
          <button
            className="btn btn-sm"
            disabled={fields.length >= 10}
            onClick={() => setFields([...fields, fieldOfKind({ name: `field${fields.length + 1}`, label: `Field ${fields.length + 1}`, required: false }, "text")])}
          >
            Add field
          </button>
        </div>
        <div className="fields">
          <div className="field">
            <label>Title field</label>
            <select
              className={`select${errorsAt(bound.diags, [...base, "titleField"]).length ? " invalid" : ""}`}
              value={String(getIn(project, [...base, "titleField"]) ?? "")}
              onChange={(e) => bound.edit([...base, "titleField"], e.target.value)}
            >
              {fields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label || f.name}
                </option>
              ))}
            </select>
            {errorsAt(bound.diags, [...base, "titleField"]).map((e) => (
              <span className="err" key={e}>
                {e}
              </span>
            ))}
          </div>
          <NumberInput {...bound} path={[...base, "maxSubmissions"]} label="Pending + accepted entries" />
          <NumberInput {...bound} path={[...base, "maxPerSubmitter"]} label="Per address" hint="0 for no extra limit" />
          <NumberInput {...bound} path={[...base, "maxPayloadBytes"]} label="Max entry size (bytes)" />
        </div>
      </div>
    </section>
  );
}

function Summary({ result, parsed }: { result: ReturnType<typeof generate>; parsed: ProjectSpec | undefined }) {
  const recipe = parsed && catalog.recipes.get(parsed.recipe.id);
  return (
    <div className="stack-lg">
      {parsed && recipe && (
        <>
          <section>
            <p className="panel-title">Behaviour</p>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {behaviour(parsed).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </section>
          <section>
            <p className="panel-title">Who can do what</p>
            <table className="table">
              <tbody>
                {permissionLines(parsed, recipe).map((l) => (
                  <tr key={l.op}>
                    <td className="small">{l.description}</td>
                    <td className="small nowrap">
                      {l.who}
                      {l.changedFromDefault && (
                        <>
                          {" "}
                          <Tag tone="accent">changed</Tag>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
      {result.ok && <Composition g={result.value} />}
    </div>
  );
}

function Composition({ g }: { g: Generated }) {
  const size = Object.values(g.runtime).reduce((n, s) => n + utf8Length(s), 0);
  return (
    <section>
      <p className="panel-title">Ingredients (locked)</p>
      {g.lock.components.map((c) => (
        <div className="ingredient" key={c.id}>
          <div className="grow">
            <a href={`#/components/${c.id}`}>{catalog.components.get(c.id)?.title ?? c.id}</a>
            <div className="faint mono break">{c.pkgPath}</div>
          </div>
          <LifecycleTag lifecycle={c.lifecycle} />
        </div>
      ))}
      {g.lock.thirdParty.map((p) => (
        <div className="ingredient" key={p}>
          <div className="grow mono small">{p}</div>
          <Tag>third party</Tag>
        </div>
      ))}
      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>Runtime digest</dt>
        <dd className="digest">{g.runtimeDigest}</dd>
        <dt>Config digest</dt>
        <dd className="digest">{g.configDigest}</dd>
        <dt>Runtime size</dt>
        <dd>
          {bytes(size)} in {Object.keys(g.runtime).length} files
        </dd>
        <dt>Generator</dt>
        <dd>@remixlab/generator {GENERATOR_VERSION}</dd>
      </dl>
    </section>
  );
}

function TestsTab({ result }: { result: ReturnType<typeof generate> }) {
  if (!result.ok) return <Blocked />;
  return (
    <div className="stack">
      <Notice tone="info">
        <p>
          These tests are generated for this exact configuration. The hosted runner that executes them against the pinned
          Gno toolchain is not available yet, so nothing here has been run. Export the project and run{" "}
          <code>gno test .</code> to execute them; DEPLOY.md lists the setup.
        </p>
      </Notice>
      <FileBrowser files={result.value.tests} />
    </div>
  );
}

function ChangesTab({
  draftId,
  project,
  baseline,
  result,
}: {
  draftId: string;
  project: unknown;
  baseline: { project: unknown; at: string } | undefined;
  result: ReturnType<typeof generate>;
}) {
  const recipeId = (project as Project).recipe?.id as string;
  const reference = baseline?.project ?? exampleProjects[recipeId];
  const before = useMemo(() => generateSafely(reference), [reference]);
  const [open, setOpen] = useState<string | null>(null);
  if (!result.ok) return <Blocked />;
  const changes = before.ok ? diffFiles({ ...before.value.runtime, ...before.value.tests }, { ...result.value.runtime, ...result.value.tests }) : [];

  return (
    <div className="stack">
      <div className="row-between">
        <p className="small muted" style={{ margin: 0 }}>
          Compared with {baseline ? `the configuration you marked on ${new Date(baseline.at).toLocaleString()}` : "the recipe's default configuration"}.
        </p>
        <button
          className="btn btn-sm"
          onClick={() => updateDraft(draftId, (d) => ({ ...d, baseline: { project: structuredClone(project), at: new Date().toISOString() } }))}
        >
          Mark current as reviewed
        </button>
      </div>
      {!before.ok && <Notice tone="warn">The comparison configuration no longer generates, so changes cannot be shown.</Notice>}
      {before.ok && changes.length === 0 && <p className="muted">No differences in the generated files.</p>}
      {changes.map((c) => (
        <div key={c.name}>
          <button className="linkish row" onClick={() => setOpen(open === c.name ? null : c.name)} aria-expanded={open === c.name}>
            <span className="mono">{c.name}</span>
            <Tag tone={c.status === "added" ? "ok" : c.status === "removed" ? "bad" : "info"}>{c.status}</Tag>
            <span className="faint">
              +{c.added} −{c.removed}
            </span>
          </button>
          {open === c.name && (
            <div style={{ marginTop: 8 }}>
              <DiffView change={c} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ExportTab({ project, result }: { project: Project; result: ReturnType<typeof generate> }) {
  const name = typeof project.app?.pkgPath === "string" ? expectedPackageName(project.app.pkgPath) || "app" : "app";
  return (
    <div className="stack">
      <div className="row">
        <button
          className="btn btn-primary"
          disabled={!result.ok}
          onClick={() => result.ok && download(`${name}.zip`, zip(exportProject(result.value), name), "application/zip")}
        >
          Download project (.zip)
        </button>
        <button className="btn" onClick={() => download("remix.project.json", JSON.stringify(project, null, 2) + "\n", "application/json")}>
          Download configuration only
        </button>
      </div>
      <p className="small muted">
        The project contains the runtime files, generated tests, the configuration, the dependency lockfile, provenance
        and DEPLOY.md with exact command-line steps. Anyone can import the configuration to remix it.
      </p>
      {result.ok && (
        <>
          <p className="panel-title">DEPLOY.md</p>
          <Source text={exportProject(result.value)["DEPLOY.md"]!} />
          <p className="faint">
            Runtime digest {shortDigest(result.value.runtimeDigest)} · config digest {shortDigest(result.value.configDigest)}
          </p>
        </>
      )}
    </div>
  );
}
