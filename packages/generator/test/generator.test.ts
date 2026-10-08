import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { isFieldName } from "@remixlab/spec";
import { loadCatalog } from "@remixlab/spec/node";
import { exportProject, generate, gnoString, type Generated } from "@remixlab/generator";

const root = join(import.meta.dirname, "../../..");
const catalog = loadCatalog(join(root, "catalog"));
const example = (file: string) => (mut?: (p: any) => void) => {
  const p = JSON.parse(readFileSync(join(root, "catalog/recipes/examples", file), "utf8"));
  mut?.(p);
  return p;
};
const project = example("club-poll.default.json");
const directory = example("community-directory.default.json");
const contest = example("demo-contest.default.json");
const generated = (p: unknown): Generated => {
  const r = generate(p, catalog);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
};
const gen = (mut?: (p: any) => void) => generated(project(mut));
const genDir = (mut?: (p: any) => void) => generated(directory(mut));
const genContest = (mut?: (p: any) => void) => generated(contest(mut));

const reverseKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]));
  }
  return v;
};

describe("generate", () => {
  it.each([
    ["clubpoll", gen],
    ["directory", genDir],
    ["contest", genContest],
  ])("reproduces the checked-in %s realm byte for byte", (name, g) => {
    const out = g();
    const dir = join(root, "gno/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab", name);
    const files = { ...out.runtime, ...out.tests };
    for (const [file, content] of Object.entries(files)) {
      expect(readFileSync(join(dir, file), "utf8"), file).toBe(content);
    }
    // Nothing else lives there except the hand-written adversarial tests.
    expect(readdirSync(dir).sort()).toEqual([...Object.keys(files), `${name}_test.gno`].sort());
  });

  // Form fields become Submit parameters. A field named like an identifier
  // the generated package declares or imports would shadow it, so every
  // lowercase identifier the templates emit must be refused as a field name.
  it.each([
    ["clubpoll", () => gen()],
    ["clubpoll, open", () => gen((p) => ((p.config.membership.joinMode = "open"), delete p.config.rules["members.invite"]))],
    ["directory", () => genDir()],
    ["contest", () => genContest()],
    ["contest, public", () => genContest((p) => (p.config.contest.eligibility = "public"))],
  ])("reserves every package-level identifier of the %s templates", (_, g) => {
    const out = g();
    const names = new Set<string>();
    for (const src of Object.values(out.runtime)) {
      for (const m of src.matchAll(/^func (?:\([^)]*\) )?([a-z]\w*)\(/gm)) names.add(m[1]!);
      for (const m of src.matchAll(/^(?:const|var|type) ([a-z]\w*)/gm)) names.add(m[1]!);
      for (const block of src.matchAll(/^(?:const|var) \(([\s\S]*?)^\)/gm)) {
        for (const m of block[1]!.matchAll(/^\t([a-z]\w*)\b/gm)) names.add(m[1]!);
      }
      for (const m of src.matchAll(/^(?:\t|import )"([^"]+)"$/gm)) {
        names.add(m[1]!.replace(/\/v\d+$/, "").split("/").pop()!);
      }
    }
    // Locals of the function whose parameters are form fields.
    for (const n of ["actor", "id", "err", "cur"]) names.add(n);
    const allowed = [...names].filter(isFieldName);
    expect(allowed).toEqual([]);
  });

  it("is deterministic and independent of key order in the input", () => {
    const a = gen();
    const b = generate(reverseKeys(project()), catalog);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.value.runtime).toEqual(a.runtime);
    expect(b.value.runtimeDigest).toBe(a.runtimeDigest);
    expect(b.value.configDigest).toBe(a.configDigest);
  });

  it("separates runtime files from tests", () => {
    const g = gen();
    expect(Object.keys(g.runtime)).toEqual(["app.gno", "descriptor.gno", "gnomod.toml", "render.gno"]);
    expect(Object.keys(g.tests)).toEqual(["app_generated_test.gno"]);
  });

  it("changes the generated code when eligibility changes", () => {
    const members = gen();
    const pub = gen((p) => (p.config.ballots.eligibility = "public"));
    expect(members.runtime["app.gno"]).toContain("polls.OpenWithElectorate(");
    expect(pub.runtime["app.gno"]).toContain("polls.OpenPublic(");
    expect(pub.runtime["app.gno"]).not.toContain("members.Snapshot(");
    expect(pub.runtime["render.gno"]).toContain('"any address"');
    expect(pub.configDigest).not.toBe(members.configDigest);
  });

  it("omits invitation entry points in open-join mode", () => {
    const g = gen((p) => {
      p.config.membership.joinMode = "open";
      delete p.config.rules["members.invite"];
    });
    expect(g.runtime["app.gno"]).not.toContain("func Invite(");
    expect(g.runtime["app.gno"]).not.toContain("opInvite");
    expect(g.runtime["app.gno"]).toContain("membership.JoinOpen");
  });

  it("writes configured rules and floors into policy definitions", () => {
    const g = gen((p) => (p.config.rules["poll.create"] = "reviewer"));
    expect(g.runtime["app.gno"]).toContain("policy.Define(opCreate, policies.RuleReviewer, policies.RuleReviewer)");
    expect(g.runtime["app.gno"]).toContain("policy.Define(opRemove, policies.RuleOwner, policies.RuleOwner)");
  });

  it("embeds hostile titles only as escaped string literals", () => {
    const title = 'Poll" + evil() + "\\ `x` </script>';
    const g = gen((p) => (p.app.title = title));
    expect(g.runtime["app.gno"]).toContain(`appTitle      = ${gnoString(title)}`);
    expect(g.runtime["app.gno"]).not.toContain('" + evil() + "');
  });

  it("rejects invalid projects with diagnostics instead of source", () => {
    const r = generate(project((p) => (p.config.rules["policy.set"] = "member")), catalog);
    expect(r).toEqual({
      ok: false,
      diagnostics: [{ path: "config.rules.policy.set", message: 'may not be more permissive than "owner"' }],
    });
  });

  it("exports the project with lockfile, provenance and instructions", () => {
    const files = exportProject(gen());
    expect(Object.keys(files).sort()).toEqual([
      "DEPLOY.md",
      "app.gno",
      "app_generated_test.gno",
      "descriptor.gno",
      "gnomod.toml",
      "remix.lock.json",
      "remix.project.json",
      "remix.provenance.json",
      "render.gno",
    ]);
    expect(files["DEPLOY.md"]).toContain("gno.land/p/nt/avl/v0");
    expect(JSON.parse(files["remix.provenance.json"]!).supported).toBe(false);
  });
});

describe("generate: community directory", () => {
  it("turns each form field into a Submit parameter in schema order", () => {
    const app = genDir().runtime["app.gno"]!;
    expect(app).toContain(
      "func Submit(cur realm, name string, link string, category string, since string, summary string) uint64 {",
    );
    expect(app).toContain("entries.Submit(actor, []string{name, link, category, since, summary})");
    expect(app).toContain("const titleIndex = 0");
  });

  it("writes field constraints into the form schema", () => {
    const app = genDir().runtime["app.gno"]!;
    expect(app).toContain('{Name: "since", Label: "Year started", Kind: forms.KindInteger, Required: false, Min: 2000, Max: 2100},');
    expect(app).toContain('Choices: []string{"Realm", "Library", "Tool", "Other"}');
    expect(app).toContain("MaxBytes: 500, Multiline: true}");
  });

  it("embeds hostile labels and choices only as escaped string literals", () => {
    const hostile = 'L" + evil() + "\\';
    const g = genDir((p) => {
      p.config.form.fields[0].label = hostile;
      p.config.form.fields[2].choices = [hostile, "b"];
    });
    expect(g.runtime["app.gno"]).toContain(`Label: ${gnoString(hostile)}`);
    expect(g.runtime["app.gno"]).not.toContain('" + evil() + "');
  });

  it("follows the configured title field", () => {
    const g = genDir((p) => {
      p.config.form.fields.reverse();
      p.config.form.titleField = "link";
    });
    expect(g.runtime["app.gno"]).toContain("const titleIndex = 3");
    expect(g.tests["app_generated_test.gno"]).toContain('"remix: invalid input: link is required"');
  });

  it("lists forms in the lockfile", () => {
    expect(genDir().lock.components.map((c) => c.id)).toEqual(["core", "forms", "membership", "policies", "render"]);
  });
});

describe("generate: demo contest", () => {
  it("sizes ballot options to fit the id prefix and the title field", () => {
    const app = genContest((p) => (p.config.form.fields[0].maxBytes = 256)).runtime["app.gno"]!;
    expect(app).toContain("MaxOptionBytes: 278,");
    expect(app).toContain("MaxOptions:     maxEntries,");
  });

  it("opens a public ballot only for public eligibility", () => {
    const members = genContest().runtime["app.gno"]!;
    const pub = genContest((p) => (p.config.contest.eligibility = "public")).runtime["app.gno"]!;
    expect(members).toContain("ballot.OpenWithElectorate(");
    expect(pub).toContain("ballot.OpenPublic(");
    expect(pub).not.toContain("members.Snapshot(");
  });

  it("predicts a failed quorum when a seated entrant does not vote", () => {
    const t = genContest((p) => {
      p.config.rules["entry.submit"] = "member";
      p.config.contest.quorumPercent = 100;
    }).tests["app_generated_test.gno"]!;
    expect(t).toContain("int(core.OutcomeNoQuorum)");
    expect(t).toContain("_, ok := Winner()");
  });

  it("locks the ballots and forms components", () => {
    expect(genContest().lock.components.map((c) => c.id)).toEqual([
      "ballots",
      "core",
      "forms",
      "membership",
      "policies",
      "render",
    ]);
  });
});

describe("gnoString", () => {
  it("escapes quotes, backslashes and control characters", () => {
    expect(gnoString('a"b\\c\nd\u0001 ')).toBe('"a\\"b\\\\c\\nd\\u0001\\u2028"');
    expect(gnoString("héllo ✓")).toBe('"héllo ✓"');
    expect(() => gnoString("\ud800")).toThrow();
  });
});
