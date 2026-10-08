// Generates recipe variants into a temporary Gno workspace holding a copy of
// the repository's /p/ packages, then runs gno fmt, lint and test on each. This
// is the validation the worker will run, without isolation.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "@remixlab/spec/node";
import { generate } from "@remixlab/generator";

type Mut = (p: any) => void;
const CLUB_POLL: Array<[string, Mut]> = [
  ["defaults", () => {}],
  ["public_open", (p) => {
    p.config.ballots.eligibility = "public";
    p.config.membership.joinMode = "open";
    delete p.config.rules["members.invite"];
  }],
  ["quorum_unmet_abstain", (p) => {
    p.config.ballots.quorumPercent = 100;
    p.config.ballots.allowAbstain = true;
    p.config.membership.maxMembers = 2;
  }],
  ["quorum_full", (p) => {
    p.config.ballots.quorumPercent = 100;
    p.config.membership.maxMembers = 3;
    p.config.rules["members.invite"] = "reviewer";
  }],
  ["solo_owner", (p) => (p.config.membership.maxMembers = 1)],
  ["create_disabled", (p) => (p.config.rules["poll.create"] = "nobody")],
  ["open_disabled", (p) => (p.config.rules["poll.open"] = "nobody")],
  ["hostile_title", (p) => (p.app.title = HOSTILE)],
  // The package name comes from the element before a version suffix.
  ["versioned_path", (p) => (p.app.pkgPath += "/v2")],
];

const DIRECTORY: Array<[string, Mut]> = [
  ["defaults", () => {}],
  ["open_members_submit", (p) => {
    p.config.membership.joinMode = "open";
    delete p.config.rules["members.invite"];
    p.config.rules["entry.submit"] = "member";
  }],
  ["submit_disabled", (p) => (p.config.rules["entry.submit"] = "nobody")],
  ["review_owner", (p) => (p.config.rules["entry.review"] = "owner")],
  ["review_disabled", (p) => (p.config.rules["entry.review"] = "nobody")],
  ["tiny_payload", (p) => (p.config.form.maxPayloadBytes = 10)],
  ["single_field", (p) => {
    p.config.form.fields = [{ name: "title", label: "Title", kind: "text", required: true, maxBytes: 3, multiline: false }];
    p.config.form.titleField = "title";
    p.config.form.maxPerSubmitter = 1;
  }],
  ["hostile_text", (p) => {
    p.app.title = HOSTILE;
    p.config.form.fields[0].label = HOSTILE;
    p.config.form.fields[2].choices = [HOSTILE, "*/ x", "`y`"];
    p.config.form.fields[3].min = -9007199254740991;
  }],
  // Multi-byte text right at the byte limits the Gno blocks enforce.
  ["unicode_limits", (p) => {
    p.app.title = "名".repeat(20);
    p.config.form.fields[0].label = "项".repeat(26) + "ab";
    p.config.form.fields[2].choices = ["选".repeat(26) + "xy", "Ünïcødé", "🙂👨\u200d👩"];
  }],
];

const CONTEST: Array<[string, Mut]> = [
  ["defaults", () => {}],
  ["public_vote", (p) => {
    p.config.contest.eligibility = "public";
    p.config.membership.joinMode = "open";
    delete p.config.rules["members.invite"];
  }],
  // A seated member entrant does not vote, so a 100% quorum fails.
  ["quorum_unmet", (p) => {
    p.config.rules["entry.submit"] = "member";
    p.config.contest.quorumPercent = 100;
  }],
  ["quorum_met_reviewer_entrant", (p) => {
    p.config.rules["entry.submit"] = "reviewer";
    p.config.contest.quorumPercent = 75;
  }],
  ["owner_submits", (p) => {
    p.config.rules["entry.submit"] = "owner";
    p.config.form.maxPerSubmitter = 0;
  }],
  ["solo_owner", (p) => {
    p.config.rules["entry.submit"] = "owner";
    p.config.membership.maxMembers = 1;
  }],
  ["submit_disabled", (p) => (p.config.rules["entry.submit"] = "nobody")],
  ["review_disabled", (p) => (p.config.rules["entry.review"] = "nobody")],
  ["open_disabled", (p) => (p.config.rules["contest.open"] = "nobody")],
  ["tiny_payload", (p) => (p.config.form.maxPayloadBytes = 8)],
  ["two_entries_long_titles", (p) => {
    p.config.contest.maxEntries = 2;
    p.config.form.fields[0].maxBytes = 256;
  }],
  ["hostile_text", (p) => {
    p.app.title = HOSTILE;
    p.config.form.fields[1].label = HOSTILE;
  }],
];

const HOSTILE = 'x" + panic("pwn") + "\\ [a](https://e) <b>';

const root = join(import.meta.dirname, "..");
const catalog = loadCatalog(join(root, "catalog"));
const SUITES: Array<[prefix: string, example: string, variants: Array<[string, Mut]>]> = [
  ["poll", "club-poll.default.json", CLUB_POLL],
  ["dir", "community-directory.default.json", DIRECTORY],
  ["contest", "demo-contest.default.json", CONTEST],
];
const work = mkdtempSync(join(tmpdir(), "remix-check-"));
writeFileSync(join(work, "gnowork.toml"), "");
cpSync(join(root, "gno/p"), join(work, "p"), { recursive: true });

let failed = 0;
try {
  for (const [prefix, example, variants] of SUITES) for (const [variant, mut] of variants) {
    const name = `${prefix}_${variant}`;
    const project = JSON.parse(readFileSync(join(root, "catalog/recipes/examples", example), "utf8"));
    project.app.pkgPath = `gno.land/r/remixcheck/${name}`;
    mut(project);
    const r = generate(project, catalog);
    if (!r.ok) {
      console.log(`FAIL ${name}: ${JSON.stringify(r.diagnostics)}`);
      failed++;
      continue;
    }
    const rel = project.app.pkgPath.slice("gno.land/".length);
    const dir = join(work, rel);
    mkdirSync(dir, { recursive: true });
    const files = { ...r.value.runtime, ...r.value.tests };
    for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
    try {
      execFileSync("gno", ["fmt", "-w", ...readdirSync(dir).filter((f) => f.endsWith(".gno")).map((f) => join(dir, f))]);
      for (const [f, c] of Object.entries(files)) {
        const formatted = readFileSync(join(dir, f), "utf8");
        if (formatted !== c) {
          const want = formatted.split("\n");
          const line = c.split("\n").findIndex((l, i) => l !== want[i]);
          throw new Error(`${f} is not in gno fmt form at line ${line + 1}: ${JSON.stringify(want[line])}`);
        }
      }
      execFileSync("gno", ["lint", `./${rel}`], { cwd: work, stdio: "pipe" });
      execFileSync("gno", ["test", `./${rel}`], { cwd: work, stdio: "pipe" });
      console.log(`ok   ${name}  ${r.value.runtimeDigest.slice(0, 23)}`);
    } catch (e: any) {
      failed++;
      console.log(`FAIL ${name}\n${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? e.message}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
