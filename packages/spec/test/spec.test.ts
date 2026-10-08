import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { bundleDigest, canonicalJson, checkRules, configDigest, normalizeGnomod, parseProject } from "@remixlab/spec";
import { loadCatalog, readRuntimeFiles } from "@remixlab/spec/node";

const root = join(import.meta.dirname, "../../..");
const catalog = loadCatalog(join(root, "catalog"));
const defaultProject = () =>
  JSON.parse(readFileSync(join(root, "catalog/recipes/examples/club-poll.default.json"), "utf8"));

describe("canonicalJson", () => {
  it("sorts keys and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
  });
  it("is independent of key insertion order", () => {
    expect(configDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(configDigest({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it("rejects values that have no canonical form", () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow(/safe integers/);
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
    expect(() => canonicalJson({ x: "\ud800" })).toThrow(/surrogate/);
    expect(() => canonicalJson({ x: new Date(0) })).toThrow(/plain objects/);
    expect(() => canonicalJson({ x: [1, , 3] })).toThrow(/holes/);
    expect(() => canonicalJson({ ["\ud800"]: 1 })).toThrow(/surrogate/);
  });
});

describe("bundleDigest", () => {
  it("depends on content and path but not on insertion order", () => {
    const a = bundleDigest({ "a.gno": "x", "b.gno": "y" });
    expect(bundleDigest({ "b.gno": "y", "a.gno": "x" })).toBe(a);
    expect(bundleDigest({ "a.gno": "x", "b.gno": "y " })).not.toBe(a);
    expect(bundleDigest({ "a.gno": "xb.gno\n1\ny" })).not.toBe(a);
  });
  it("refuses names that could make two bundles hash alike", () => {
    expect(() => bundleDigest({ "a\n1\nx\nb": "y" })).toThrow(/invalid file name/);
    expect(() => bundleDigest({ "../x.gno": "y" })).toThrow(/invalid file name/);
  });
  it("hashes gnomod.toml as the chain stores it", () => {
    const local = 'module = "gno.land/r/a/app"\ngno = "0.9"\n';
    const stamped = 'module = "gno.land/r/a/app"\ngno = "0.9"\n\n[addpkg]\n  creator = "g1x"\n  height = 232982\n';
    expect(normalizeGnomod(stamped)).toBe(local);
    expect(bundleDigest({ "gnomod.toml": stamped, "a.gno": "x" })).toBe(bundleDigest({ "gnomod.toml": local, "a.gno": "x" }));
    expect(bundleDigest({ "gnomod.toml": 'module = "gno.land/r/a/other"\ngno = "0.9"\n' })).not.toBe(
      bundleDigest({ "gnomod.toml": local }),
    );
    expect(() => normalizeGnomod("[addpkg]\nmodule = \"x\"\n")).toThrow();
  });
});

describe("catalog source digests", () => {
  it.each([...catalog.components.values()].map((c) => [c.id, c] as const))("%s matches its source", (_, c) => {
    expect(bundleDigest(readRuntimeFiles(join(root, c.source))), "run pnpm regen:fixtures").toBe(c.sourceDigest);
  });
});

describe("parseProject", () => {
  it("accepts the default club poll", () => {
    expect(parseProject(defaultProject()).ok).toBe(true);
  });
  it("rejects unknown fields at any depth", () => {
    const p = defaultProject();
    p.config.ballots.secretBackdoor = true;
    const r = parseProject(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.path).toBe("config.ballots");
  });
  it("rejects control characters and bad paths", () => {
    const p = defaultProject();
    p.app.title = "Club\npoll";
    p.app.pkgPath = "gno.land/r/Remix/Poll";
    const r = parseProject(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([...new Set(r.diagnostics.map((d) => d.path))].sort()).toEqual(["app.pkgPath", "app.title"]);
  });
  it("rejects keyword package names", () => {
    const p = defaultProject();
    p.app.pkgPath = "gno.land/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/default";
    expect(parseProject(p).ok).toBe(false);
  });
  it("rejects a percentage quorum on public polls", () => {
    const p = defaultProject();
    p.config.ballots.eligibility = "public";
    p.config.ballots.quorumPercent = 50;
    const r = parseProject(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.path).toBe("config.ballots.quorumPercent");
  });
});

describe("parseProject: community directory", () => {
  const dir = () =>
    JSON.parse(readFileSync(join(root, "catalog/recipes/examples/community-directory.default.json"), "utf8"));
  const paths = (p: unknown) => {
    const r = parseProject(p);
    return r.ok ? [] : [...new Set(r.diagnostics.map((d) => d.path))].sort();
  };

  it("accepts the default directory", () => {
    expect(paths(dir())).toEqual([]);
  });
  it("rejects an unknown recipe before looking at the config", () => {
    const p = dir();
    p.recipe.id = "token-launcher";
    expect(parseProject(p)).toEqual({
      ok: false,
      diagnostics: [{ path: "recipe.id", message: "expected one of: club-poll, community-directory, demo-contest" }],
    });
  });
  it("rejects a club-poll config under the directory recipe", () => {
    const p = dir();
    p.config = defaultProject().config;
    expect(paths(p)).toContain("config");
  });
  it("rejects field names that would shadow identifiers in generated code", () => {
    for (const name of ["cur", "string", "len", "func", "Name", "1x", "entries"]) {
      const p = dir();
      p.config.form.fields[0].name = name;
      p.config.form.titleField = name;
      expect(paths(p), name).toContain("config.form.fields.0.name");
    }
  });
  it("rejects kind-specific settings on the wrong kind", () => {
    const p = dir();
    p.config.form.fields[0].choices = ["a", "b"];
    expect(paths(p)).toEqual(["config.form.fields.0"]);
  });
  it("checks duplicates, ranges and the title field", () => {
    const p = dir();
    p.config.form.fields[1].name = "name";
    p.config.form.fields[2].choices = ["Tool", "Tool"];
    p.config.form.fields[3].min = 3000;
    p.config.form.titleField = "summary";
    expect(paths(p)).toEqual([
      "config.form.fields.1.name",
      "config.form.fields.2.choices",
      "config.form.fields.3.min",
      "config.form.titleField",
    ]);
  });
});

describe("parseProject: demo contest", () => {
  const contest = () =>
    JSON.parse(readFileSync(join(root, "catalog/recipes/examples/demo-contest.default.json"), "utf8"));
  const paths = (p: unknown) => {
    const r = parseProject(p);
    return r.ok ? [] : [...new Set(r.diagnostics.map((d) => d.path))].sort();
  };

  it("accepts the default contest", () => {
    expect(paths(contest())).toEqual([]);
  });
  it("bounds titles so ballot options fit", () => {
    const p = contest();
    p.config.form.fields[0].maxBytes = 257;
    expect(paths(p)).toEqual(["config.form.titleField"]);
  });
  it("checks contest limits against the form and eligibility", () => {
    const p = contest();
    p.config.contest.maxEntries = 21;
    expect(paths(p)).toEqual(["config.contest.maxEntries"]);
    p.config.contest.maxEntries = 20;
    p.config.form.maxSubmissions = 19;
    p.config.contest.eligibility = "public";
    p.config.contest.quorumPercent = 10;
    p.config.contest.minDurationSeconds = 700000;
    expect(paths(p)).toEqual(["config.contest.maxEntries", "config.contest.minDurationSeconds", "config.contest.quorumPercent"]);
  });
  it("requires the contest.open rule", () => {
    const p = contest();
    delete p.config.rules["contest.open"];
    const r = parseProject(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(checkRules(r.value, catalog.recipes.get("demo-contest")!)).toEqual([
        { path: "config.rules.contest.open", message: "missing rule" },
      ]);
    }
  });
});

describe("checkRules", () => {
  const recipe = catalog.recipes.get("club-poll")!;
  const parse = (p: unknown) => {
    const r = parseProject(p);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
    return r.value;
  };
  it("rejects rules below the floor", () => {
    const p = defaultProject();
    p.config.rules["members.remove"] = "member";
    expect(checkRules(parse(p), recipe)).toEqual([
      { path: "config.rules.members.remove", message: 'may not be more permissive than "owner"' },
    ]);
  });
  it("requires every operation and rejects unknown ones", () => {
    const p = defaultProject();
    delete p.config.rules["poll.open"];
    p.config.rules["treasury.drain"] = "owner";
    const paths = checkRules(parse(p), recipe).map((d) => d.path).sort();
    expect(paths).toEqual(["config.rules.poll.open", "config.rules.treasury.drain"]);
  });
  it("drops the invite operation in open-join mode", () => {
    const p = defaultProject();
    p.config.membership.joinMode = "open";
    expect(checkRules(parse(p), recipe)).toEqual([
      { path: "config.rules.members.invite", message: "not an operation of this recipe configuration" },
    ]);
  });
});

describe("schema matches what the Gno blocks accept", () => {
  const dir = () => JSON.parse(readFileSync(join(root, "catalog/recipes/examples/community-directory.default.json"), "utf8"));
  const paths = (r: ReturnType<typeof parseProject>) => (r.ok ? [] : [...new Set(r.diagnostics.map((d) => d.path))]);

  it("limits labels and choices by UTF-8 bytes, not characters", () => {
    const ok = dir();
    ok.config.form.fields[0].label = "项".repeat(26) + "ab"; // 80 bytes
    expect(parseProject(ok).ok).toBe(true);
    const p = dir();
    p.config.form.fields[0].label = "é".repeat(41); // 41 chars, 82 bytes
    p.config.form.fields[2].choices[0] = "选".repeat(30); // 90 bytes
    expect(paths(parseProject(p)).sort()).toEqual(["config.form.fields.0.label", "config.form.fields.2.choices.0"]);
  });

  it("rejects blank, padded, invisible and direction-changing text", () => {
    for (const title of ["   ", " Poll", "Poll ", "Po‮ll", "Po​ll", "﻿Poll"]) {
      const p = defaultProject();
      p.app.title = title;
      expect(paths(parseProject(p)), JSON.stringify(title)).toEqual(["app.title"]);
    }
    const p = defaultProject();
    p.app.title = "Club 👨‍👩 poll";
    expect(parseProject(p).ok).toBe(true);
  });

  it("accepts only realm paths and package names the VM accepts", () => {
    const ns = "gno.land/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm";
    for (const good of [`${ns}/poll`, `${ns}/club_poll`, `${ns}/poll/v2`, "gno.land/r/my-team/poll2"]) {
      const p = defaultProject();
      p.app.pkgPath = good;
      expect(parseProject(p).ok, good).toBe(true);
    }
    for (const bad of [
      `${ns}/a`, `${ns}/poll_`, `${ns}/a__b`, `${ns}/foo_test`, `${ns}/main`, `${ns}/my-app`, `${ns}/123`,
      `${ns}/_x`, "gno.land/r/poll", `${ns}//poll`, `${ns}/Poll`, `gno.land/p/x/poll`,
    ]) {
      const p = defaultProject();
      p.app.pkgPath = bad;
      expect(paths(parseProject(p)), bad).toEqual(["app.pkgPath"]);
    }
  });

  it("refuses field names that would shadow generated identifiers", () => {
    for (const name of ["must", "err", "authorize", "ready", "setup", "ok", "url", "ballot", "init"]) {
      const p = dir();
      p.config.form.fields[4].name = name;
      expect(paths(parseProject(p)), name).toEqual(["config.form.fields.4.name"]);
    }
  });

  it("requires a payload limit that fits the required fields", () => {
    const p = dir();
    p.config.form.maxPayloadBytes = 3; // name, link (1 each) + shortest category "Tool" (4)
    expect(paths(parseProject(p))).toEqual(["config.form.maxPayloadBytes"]);
    p.config.form.maxPayloadBytes = 6;
    expect(parseProject(p).ok).toBe(true);
  });

  it("rejects __proto__ keys instead of dropping them", () => {
    const p = JSON.parse(JSON.stringify(defaultProject()).replace('"rules":{', '"rules":{"__proto__":"public",'));
    expect(paths(parseProject(p))).toEqual(["config.rules.__proto__"]);
  });

  it("rejects a network id that is not a profile id", () => {
    const p = defaultProject();
    p.network = "Local Dev";
    expect(paths(parseProject(p))).toEqual(["network"]);
  });
});

describe("checkRules: owner-level operations", () => {
  it("cannot be disabled", () => {
    const p = parseProject(
      JSON.parse(JSON.stringify(defaultProject()).replace('"policy.set":"owner"', '"policy.set":"nobody"')),
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const recipe = catalog.recipes.get("club-poll")!;
    expect(checkRules(p.value, recipe)).toEqual([
      { path: "config.rules.policy.set", message: "owner-level operations cannot be disabled" },
    ]);
  });
});
