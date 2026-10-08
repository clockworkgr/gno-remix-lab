// Lab views of deployed apps, built only from the realms' structured reads
// (never from parsing their rendered pages). Buttons are hidden when the
// app's own rules say the connected address may not act, but the realm
// checks every call again.
import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { msgCall, type BallotView, type FieldView, type MemberView, type RuleView, type SubmissionView } from "@remixlab/chain";
import { RULE_ORDER, type Rule } from "@remixlab/spec";
import { reader, schemas } from "../lib/chain.ts";
import { dateTime, duration, relative, utf8Length } from "../lib/format.ts";
import { RULE_LABEL, ruleWho } from "../lib/permissions.ts";
import { useQuery } from "../hooks/query.ts";
import type { TxOptions } from "../hooks/tx.ts";
import { Addr, Empty, Loaded, Notice, Tag } from "./ui.tsx";

export type Role = "none" | "member" | "reviewer" | "owner";
const ROLE_RANK: Record<Role, number> = { none: 0, member: 1, reviewer: 2, owner: 3 };

export interface AppCtx {
  net: string;
  pkgPath: string;
  /** Connected address on this network, if any. */
  me: string | undefined;
  role: Role;
  /** Current rules, when the app publishes them. */
  rules: RuleView[] | undefined;
  /** Bumped after every confirmed write, so reads refresh. */
  version: number;
  busy: boolean;
  act(func: string, args: Array<string | number | bigint>, opts?: TxOptions): void;
}

const Ctx = createContext<AppCtx | null>(null);
export const AppProvider = Ctx.Provider;
export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** Whether the connected address passes an operation's rule (unknown rules: let the realm decide). */
export function can(app: AppCtx, op: string): boolean {
  if (!app.me) return false;
  const r = app.rules?.find((x) => x.op === op);
  if (!r) return app.rules === undefined;
  return ruleAdmits(r.rule, app.role);
}

export function ruleAdmits(rule: Rule, role: Role): boolean {
  switch (rule) {
    case "public":
      return true;
    case "nobody":
      return false;
    default:
      return ROLE_RANK[role] >= ROLE_RANK[rule];
  }
}

export const callMsg = (app: AppCtx, func: string, args: Array<string | number | bigint>) => (caller: string) => [
  msgCall({ caller, pkgPath: app.pkgPath, func, args: args.map(String) }),
];

function useRead<T>(app: AppCtx, key: string, fn: () => Promise<T>, everyMs = 15_000) {
  return useQuery(`${app.net}|${app.pkgPath}|${key}|${app.version}`, fn, { everyMs });
}

// ---------------------------------------------------------------- Polls

const NOW = () => Math.floor(Date.now() / 1000);

/**
 * One ballot. For a contest, `entries` maps ballot options to entry IDs:
 * the contest votes by entry ID and has a single ballot, so HasVoted and
 * Finalize take no poll ID.
 */
function PollCard({ b, ops, entries }: { b: BallotView; ops: { open: string; create: string }; entries?: string[] }) {
  const app = useApp();
  const voted = useRead(app, `voted:${b.id}:${app.me}`, async () => {
    if (!app.me) return false;
    const args = entries ? [{ address: app.me }] : [b.id, { address: app.me }];
    return (await reader(app.net).read(app.pkgPath, "HasVoted", args, [{ kind: "bool" }])).value[0];
  });
  const now = NOW();
  const open = b.status === "open" && now < b.deadline;
  const ended = b.status === "open" && now >= b.deadline;
  const total = b.counts.reduce((n, c) => n + c, 0);
  const status =
    b.status === "draft" ? <Tag tone="draft">Draft</Tag> : b.status === "finalized" ? <Tag>Finalized</Tag> : open ? <Tag tone="ok">Open</Tag> : <Tag tone="info">Ended, not finalized</Tag>;

  return (
    <div className="card">
      <div className="row-between">
        <h3 className="break" style={{ margin: 0 }}>
          {b.title}
        </h3>
        <div className="row">
          {status}
          <span className="faint">#{b.id}</span>
        </div>
      </div>
      <p className="faint" style={{ marginTop: 4 }}>
        {b.status === "draft"
          ? "Not open yet. Options can still be changed by cancelling and recreating."
          : `${b.public ? "Any address may vote" : `${b.electorateSize} eligible voters`} · ${b.turnout} voted${
              b.quorumPercent ? ` · quorum ${b.quorumPercent}%` : ""
            } · ${open ? `closes ${relative(b.deadline)}` : `closed ${dateTime(b.deadline)}`}`}
      </p>
      <div>
        {b.options.map((o, i) => {
          const pct = total ? Math.round((b.counts[i]! / total) * 100) : 0;
          const winner = b.outcome === "winner" && b.winner === i;
          return (
            <div className={`option${winner ? " winner" : ""}`} key={i}>
              <span className="break">
                {o} {winner && <Tag tone="ok">Winner</Tag>}
              </span>
              <span className="row nowrap">
                {b.status !== "draft" && (
                  <span className="faint">
                    {b.counts[i]} {b.counts[i] === 1 ? "vote" : "votes"}
                  </span>
                )}
                {open && app.me && voted.data === false && (
                  <button className="btn btn-sm" disabled={app.busy} onClick={() => app.act("Vote", entries ? [entries[i]!] : [b.id, i])}>
                    Vote
                  </button>
                )}
              </span>
              {b.status !== "draft" && (
                <div className="bar" aria-hidden>
                  <span style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {b.abstentions > 0 && <p className="faint">{b.abstentions} abstained</p>}
      {b.status === "finalized" && (
        <p className="small">
          Result:{" "}
          {
            {
              pending: "pending",
              winner: `“${b.options[b.winner] ?? "?"}” won.`,
              tie: "a tie; no winner.",
              "no-quorum": "quorum not reached; no winner.",
              "no-votes": "no votes were cast.",
            }[b.outcome]
          }
        </p>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        {open && voted.data === true && <Tag tone="ok">You voted</Tag>}
        {open && !app.me && <span className="faint">Connect a wallet to vote.</span>}
        {!entries && b.status === "draft" && can(app, ops.open) && (
          <button className="btn btn-sm btn-primary" disabled={app.busy} onClick={() => app.act("OpenPoll", [b.id])}>
            Open poll
          </button>
        )}
        {!entries && b.status === "draft" && app.me && (can(app, ops.open) || can(app, ops.create)) && (
          <button className="btn btn-sm btn-ghost btn-danger" disabled={app.busy} onClick={() => app.act("CancelPoll", [b.id])}>
            Cancel draft
          </button>
        )}
        {ended && app.me && (
          <button className="btn btn-sm btn-primary" disabled={app.busy} onClick={() => app.act("Finalize", entries ? [] : [b.id])}>
            Finalize result
          </button>
        )}
      </div>
    </div>
  );
}

function DurationField({ seconds, onChange, id }: { seconds: number; onChange: (s: number) => void; id: string }) {
  const [unit, setUnit] = useState(seconds % 86400 === 0 ? 86400 : seconds % 3600 === 0 ? 3600 : 60);
  return (
    <div className="row" style={{ flexWrap: "nowrap" }}>
      <input id={id} className="input" inputMode="numeric" value={String(seconds / unit)} onChange={(e) => onChange(Math.round(Number(e.target.value) * unit) || 0)} />
      <select className="select" style={{ width: "auto" }} value={unit} onChange={(e) => setUnit(Number(e.target.value))} aria-label="Unit">
        <option value={60}>minutes</option>
        <option value={3600}>hours</option>
        <option value={86400}>days</option>
      </select>
    </div>
  );
}

function CreatePoll() {
  const app = useApp();
  const id = useId();
  const [title, setTitle] = useState("");
  const [options, setOptions] = useState("Yes\nNo");
  const [seconds, setSeconds] = useState(86400);
  const opts = options.split("\n").map((s) => s.trim()).filter(Boolean);
  const problem =
    title.trim() === ""
      ? "Give the poll a title."
      : opts.length < 2
        ? "Add at least two options."
        : opts.some((o) => o.includes("|"))
          ? "Options cannot contain “|”, which separates them."
          : new Set(opts).size !== opts.length
            ? "Options must be different."
            : seconds < 60
              ? "Polls last at least a minute."
              : null;
  return (
    <div className="card">
      <h3>New poll</h3>
      <p className="faint">Polls start as drafts. Opening one freezes its options and, for member polls, its electorate.</p>
      <div className="stack">
        <div className="field">
          <label htmlFor={`${id}-t`}>Title</label>
          <input id={`${id}-t`} className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-o`}>Options, one per line</label>
          <textarea id={`${id}-o`} className="textarea" rows={4} value={options} onChange={(e) => setOptions(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-d`}>Voting lasts</label>
          <DurationField id={`${id}-d`} seconds={seconds} onChange={setSeconds} />
          <span className="hint">The app's configured limits apply; the realm rejects durations outside them.</span>
        </div>
        {problem && <span className="faint">{problem}</span>}
        <div>
          <button
            className="btn btn-primary"
            disabled={!!problem || app.busy}
            onClick={() => app.act("CreatePoll", [title.trim(), opts.join("|"), seconds], { onSuccess: () => setTitle("") })}
          >
            Create draft poll
          </button>
        </div>
      </div>
    </div>
  );
}

export function PollsView({ ops }: { ops: { create: string; open: string } }) {
  const app = useApp();
  const [pages, setPages] = useState(1);
  const polls = useRead(app, `polls:${pages}`, async () => (await reader(app.net).read(app.pkgPath, "Polls", [0, 25 * pages], [schemas(app.net).ballots])).value[0]);
  return (
    <div className="stack-lg">
      {can(app, ops.create) && <CreatePoll />}
      <Loaded q={polls} what="polls">
        {(list) =>
          list.length === 0 ? (
            <Empty>No polls yet.</Empty>
          ) : (
            <div className="stack">
              {list.map((b) => (
                <PollCard key={b.id} b={b} ops={ops} />
              ))}
              {list.length >= 25 * pages && (
                <button className="btn" onClick={() => setPages(pages + 1)}>
                  Show older polls
                </button>
              )}
            </div>
          )
        }
      </Loaded>
    </div>
  );
}

// ---------------------------------------------------------------- Members

function RoleTag({ role }: { role: string }) {
  return <Tag tone={role === "owner" ? "accent" : role === "reviewer" ? "info" : undefined}>{role}</Tag>;
}

export function MembersView({ invitations, adminOps = true }: { invitations: boolean; adminOps?: boolean }) {
  const app = useApp();
  const id = useId();
  const s = schemas(app.net);
  const members = useRead(app, "members", async () => (await reader(app.net).read(app.pkgPath, "Members", [0, 25], [s.members])).value[0]);
  const invites = useRead(app, "invites", async () => (await reader(app.net).read(app.pkgPath, "Invites", [0, 25], [s.members])).value[0]);
  const [addr, setAddr] = useState("");
  const [role, setRole] = useState<Role>("member");
  const canInvite = invitations && can(app, "members.invite");
  const canSetRole = adminOps && can(app, "members.set_role");
  const canRemove = adminOps && can(app, "members.remove");
  const isMember = members.data?.some((m) => m.address === app.me);
  const invited = invites.data?.find((m) => m.address === app.me);
  const validAddr = /^g1[02-9ac-hj-np-z]{38}$/.test(addr.trim());

  return (
    <div className="stack-lg">
      {app.me && (
        <div className="card row-between">
          <span>
            {isMember ? (
              <>
                You are a <RoleTag role={app.role} /> of this app.
              </>
            ) : invited ? (
              <>
                You are invited as <RoleTag role={invited.role} />.
              </>
            ) : invitations ? (
              "Joining needs an invitation from someone allowed to invite."
            ) : (
              "Anyone may join this app."
            )}
          </span>
          {!isMember && (invited || !invitations) && (
            <button className="btn btn-primary" disabled={app.busy} onClick={() => app.act("Join", [])}>
              Join
            </button>
          )}
          {isMember && (
            <button className="btn btn-ghost btn-danger" disabled={app.busy} onClick={() => confirm("Leave this app? You will need to join again.") && app.act("Leave", [])}>
              Leave
            </button>
          )}
        </div>
      )}

      <Loaded q={members} what="members">
        {(list) => (
          <div className="card table-wrap">
            <p className="panel-title">Members{list.length >= 25 ? " (first 25)" : ""}</p>
            <MemberTable list={list} canSetRole={canSetRole} canRemove={canRemove} />
          </div>
        )}
      </Loaded>

      {invitations && (
        <div className="card">
          <p className="panel-title">Pending invitations</p>
          <Loaded q={invites} what="invitations">
            {(list) =>
              list.length === 0 ? (
                <p className="faint">None.</p>
              ) : (
                <table className="table">
                  <tbody>
                    {list.map((m) => (
                      <tr key={m.address}>
                        <td>
                          <Addr address={m.address} you={app.me} />
                        </td>
                        <td>
                          <RoleTag role={m.role} />
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {canInvite && (
                            <button className="btn btn-sm btn-ghost" disabled={app.busy} onClick={() => app.act("RevokeInvite", [m.address])}>
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </Loaded>
          {canInvite && (
            <div className="row" style={{ marginTop: 12, alignItems: "flex-end" }}>
              <div className="field grow">
                <label htmlFor={id}>Invite an address</label>
                <input id={id} className="input mono" placeholder="g1…" value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} />
              </div>
              <select className="select" style={{ width: "auto" }} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
                <option value="member">Member</option>
                {canSetRole && <option value="reviewer">Reviewer</option>}
                {canSetRole && <option value="owner">Owner</option>}
              </select>
              <button className="btn btn-primary" disabled={!validAddr || app.busy} onClick={() => app.act("Invite", [addr.trim(), role], { onSuccess: () => setAddr("") })}>
                Invite
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MemberTable({ list, canSetRole, canRemove }: { list: MemberView[]; canSetRole: boolean; canRemove: boolean }) {
  const app = useApp();
  if (list.length === 0) return <p className="faint">No members.</p>;
  return (
    <table className="table">
      <tbody>
        {list.map((m) => (
          <tr key={m.address}>
            <td>
              <Addr address={m.address} you={app.me} />
            </td>
            <td>
              {canSetRole && m.address !== app.me ? (
                <select
                  className="select"
                  style={{ width: "auto", padding: "3px 6px" }}
                  value={m.role}
                  disabled={app.busy}
                  onChange={(e) => app.act("SetRole", [m.address, e.target.value])}
                  aria-label={`Role of ${m.address}`}
                >
                  <option value="member">member</option>
                  <option value="reviewer">reviewer</option>
                  <option value="owner">owner</option>
                </select>
              ) : (
                <RoleTag role={m.role} />
              )}
            </td>
            <td style={{ textAlign: "right" }}>
              {canRemove && m.address !== app.me && (
                <button className="btn btn-sm btn-ghost btn-danger" disabled={app.busy} onClick={() => confirm(`Remove ${m.address}?`) && app.act("RemoveMember", [m.address])}>
                  Remove
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- Rules

export function RulesView() {
  const app = useApp();
  const editable = can(app, "policy.set");
  if (!app.rules) return <Notice>This app does not publish its rules.</Notice>;
  return (
    <div className="card table-wrap">
      <p className="faint">
        {editable ? "You may change these rules, within the floor the recipe sets." : "Only those allowed to change rules can edit them."}
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Operation</th>
            <th>Who may do it</th>
            <th>Loosest allowed</th>
          </tr>
        </thead>
        <tbody>
          {app.rules.map((r) => (
            <tr key={r.op}>
              <td className="mono small">{r.op}</td>
              <td>
                {editable ? (
                  <select
                    className="select"
                    style={{ width: "auto", padding: "3px 6px" }}
                    value={r.rule}
                    disabled={app.busy}
                    onChange={(e) => app.act("SetRule", [r.op, e.target.value])}
                    aria-label={`Rule for ${r.op}`}
                  >
                    {RULE_ORDER.filter((x) => RULE_ORDER.indexOf(x) >= RULE_ORDER.indexOf(r.floor) && !(r.floor === "owner" && x === "nobody")).map((x) => (
                      <option key={x} value={x}>
                        {RULE_LABEL[x]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span title={ruleWho(r.rule)}>{RULE_LABEL[r.rule]}</span>
                )}
              </td>
              <td>{RULE_LABEL[r.floor]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Submissions

function answerProblem(f: FieldView, v: string): string | null {
  if (v.trim() === "") return f.required ? "Required." : null;
  if (v !== v.trim()) return "Remove leading or trailing spaces.";
  switch (f.kind) {
    case "text":
      if (utf8Length(v) > f.maxBytes) return `At most ${f.maxBytes} bytes.`;
      if (!f.multiline && v.includes("\n")) return "One line only.";
      return null;
    case "integer":
      if (!/^-?\d+$/.test(v)) return "A whole number.";
      return Number(v) < f.min || Number(v) > f.max ? `Between ${f.min} and ${f.max}.` : null;
    case "choice":
      return f.choices.includes(v) ? null : "Pick one of the choices.";
  }
}

export function SubmitForm({ fields, title = "Submit an entry" }: { fields: FieldView[]; title?: string }) {
  const app = useApp();
  const [values, setValues] = useState<string[]>(() => fields.map(() => ""));
  const problems = fields.map((f, i) => answerProblem(f, values[i] ?? ""));
  const ok = problems.every((p) => p === null);
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="stack">
        {fields.map((f, i) => (
          <div className="field" key={f.name}>
            <label htmlFor={`f-${f.name}`}>
              {f.label}
              {!f.required && <span className="faint"> (optional)</span>}
            </label>
            {f.kind === "choice" ? (
              <select id={`f-${f.name}`} className="select" value={values[i]} onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}>
                <option value="">—</option>
                {f.choices.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            ) : f.kind === "text" && f.multiline ? (
              <textarea id={`f-${f.name}`} className="textarea" value={values[i]} onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))} />
            ) : (
              <input
                id={`f-${f.name}`}
                className="input"
                inputMode={f.kind === "integer" ? "numeric" : undefined}
                value={values[i]}
                onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}
              />
            )}
            {values[i] !== "" && problems[i] && <span className="err">{problems[i]}</span>}
          </div>
        ))}
        <div>
          <button
            className="btn btn-primary"
            disabled={!ok || app.busy || !app.me}
            onClick={() => app.act("Submit", values, { onSuccess: () => setValues(fields.map(() => "")) })}
          >
            {app.me ? "Submit" : "Connect a wallet to submit"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The title field must be a required single-line text field; reads do not say which one, so take the first such field. */
export function titleIndex(fields: FieldView[]): number {
  return Math.max(0, fields.findIndex((f) => f.kind === "text" && f.required && !f.multiline));
}

export function EntryCard({ e, fields, actions }: { e: SubmissionView; fields: FieldView[]; actions?: ReactNode }) {
  const titleIdx = titleIndex(fields);
  return (
    <div className="card">
      <div className="row-between">
        <h3 className="break" style={{ margin: 0 }}>
          {e.answers[titleIdx] || `Entry #${e.id}`}
        </h3>
        <div className="row">
          <Tag tone={e.status === "accepted" ? "ok" : e.status === "rejected" ? "bad" : "draft"}>{e.status === "submitted" ? "pending" : e.status}</Tag>
          <span className="faint">#{e.id}</span>
        </div>
      </div>
      <dl className="kv" style={{ marginTop: 10 }}>
        {fields.map((f, i) =>
          i === titleIdx || !e.answers[i] ? null : (
            <div key={f.name} style={{ display: "contents" }}>
              <dt>{f.label}</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{e.answers[i]}</dd>
            </div>
          ),
        )}
        <dt>Submitted by</dt>
        <dd>
          <Addr address={e.submitter} />
        </dd>
      </dl>
      {actions && (
        <div className="row" style={{ marginTop: 10 }}>
          {actions}
        </div>
      )}
    </div>
  );
}

export function QueueView({ fields, reviewOp, locked }: { fields: FieldView[]; reviewOp: string; locked?: boolean }) {
  const app = useApp();
  const queue = useRead(app, "queue", async () => (await reader(app.net).read(app.pkgPath, "Queue", [0, 25], [schemas(app.net).submissions])).value[0]);
  const review = can(app, reviewOp) && !locked;
  return (
    <Loaded q={queue} what="the review queue">
      {(list) =>
        list.length === 0 ? (
          <Empty>Nothing waiting for review.</Empty>
        ) : (
          <div className="stack">
            {list.map((e) => (
              <EntryCard
                key={e.id}
                e={e}
                fields={fields}
                actions={
                  review && (
                    <>
                      <button className="btn btn-sm btn-primary" disabled={app.busy} onClick={() => app.act("Accept", [e.id])}>
                        Accept
                      </button>
                      <button className="btn btn-sm btn-ghost btn-danger" disabled={app.busy} onClick={() => app.act("Reject", [e.id])}>
                        Reject
                      </button>
                    </>
                  )
                }
              />
            ))}
          </div>
        )
      }
    </Loaded>
  );
}

export function useFields(app: AppCtx) {
  return useQuery(`${app.net}|${app.pkgPath}|fields`, async () => (await reader(app.net).read(app.pkgPath, "Fields", [], [schemas(app.net).fields!])).value[0]);
}

export function useEntriesPage(app: AppCtx, paged: boolean) {
  return useRead(app, "entries", async () =>
    paged
      ? (await reader(app.net).read(app.pkgPath, "Entries", [0, 25], [schemas(app.net).submissions])).value[0]
      : (await reader(app.net).read(app.pkgPath, "Entries", [], [schemas(app.net).submissions])).value[0],
  );
}

export { duration, PollCard, useRead };
export type { BallotView };
