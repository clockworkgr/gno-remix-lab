import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildCatalog, parseProject, type ProjectSpec } from "@remixlab/spec";
import { loadCatalog } from "@remixlab/spec/node";
import { resolve } from "@remixlab/resolver";

const root = join(import.meta.dirname, "../../..");
const catalog = loadCatalog(join(root, "catalog"));
const spec = (mut?: (p: any) => void): ProjectSpec => {
  const p = JSON.parse(readFileSync(join(root, "catalog/recipes/examples/club-poll.default.json"), "utf8"));
  mut?.(p);
  const r = parseProject(p);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
};

describe("resolve", () => {
  it("pins every component and third-party package for local-dev", () => {
    const r = resolve(spec(), catalog);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lock.components.map((c) => `${c.id}=${c.pkgPath}`)).toEqual([
      "ballots=gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/ballots/v1",
      "core=gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/core/v1",
      "membership=gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/membership/v1",
      "policies=gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/policies/v1",
      "render=gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/render/v1",
    ]);
    expect(r.value.lock.thirdParty).toEqual(["gno.land/p/nt/avl/v0"]);
    expect(r.value.supported).toBe(false); // draft components
  });

  it("refuses draft and unpublished components on the public testnet", () => {
    const r = resolve(spec((p) => (p.network = "onyx-1")), catalog);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const messages = r.diagnostics.map((d) => d.message);
    expect(messages).toContain("ballots@1.0.0 is a draft and cannot be used on onyx-1");
    expect(messages).toContain("ballots@1.0.0 is not published on onyx-1");
  });

  it("reports third-party packages missing from the network", () => {
    const raw = {
      components: [...catalog.components.values()],
      recipes: [...catalog.recipes.values()],
      networks: [...catalog.networks.values()].map((n) => (n.id === "local-dev" ? { ...n, availablePackages: [] } : n)),
    };
    const r = resolve(spec(), buildCatalog(raw));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.message).toBe("ballots imports gno.land/p/nt/avl/v0, which is not known to exist on local-dev");
  });

  it("rejects an unknown recipe version and network", () => {
    expect(resolve(spec((p) => (p.recipe.version = "9.9.9")), catalog)).toMatchObject({ ok: false });
    expect(resolve(spec((p) => (p.network = "nowhere")), catalog)).toMatchObject({ ok: false });
  });

  const rebuild = (mut: (raw: { components: any[]; recipes: any[]; networks: any[] }) => void) => {
    const raw = {
      components: [...catalog.components.values()].map((c) => structuredClone(c)),
      recipes: [...catalog.recipes.values()].map((r) => structuredClone(r)),
      networks: [...catalog.networks.values()].map((n) => structuredClone(n)),
    };
    mut(raw);
    return buildCatalog(raw);
  };

  it("requires every interface a component needs to be provided", () => {
    const cat = rebuild((raw) => {
      const r = raw.recipes.find((x) => x.id === "club-poll");
      r.components = r.components.filter((c: { id: string }) => c.id !== "membership");
      raw.components.find((c) => c.id === "policies").componentDependencies = ["core"];
    });
    const r = resolve(spec(), cat);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.map((d) => d.message)).toContain(
        "policies requires membership.read/v1, which no component in this recipe provides",
      );
    }
  });

  it("gates draft recipes and warns on deprecated ones", () => {
    const published = rebuild((raw) => {
      for (const c of raw.components) c.lifecycle = "published";
      const n = raw.networks.find((x) => x.id === "local-dev");
      n.allowDraftComponents = true;
    });
    const draft = resolve(spec(), published);
    expect(draft.ok).toBe(true);
    if (draft.ok) {
      expect(draft.value.supported).toBe(false); // the recipe itself is a draft
      expect(draft.value.warnings.map((w) => w.message)).toContain("recipe club-poll@1.0.0 is a draft release");
    }
    const deprecated = rebuild((raw) => {
      for (const c of raw.components) c.lifecycle = "published";
      raw.recipes.find((x) => x.id === "club-poll").lifecycle = "deprecated";
    });
    const d = resolve(spec(), deprecated);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.value.warnings.map((w) => w.message)).toContain("recipe club-poll@1.0.0 is deprecated");
    const strict = rebuild((raw) => {
      for (const c of raw.components) c.lifecycle = "published";
      raw.networks.find((x) => x.id === "local-dev").allowDraftComponents = false;
    });
    const s = resolve(spec(), strict);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.diagnostics[0]!.message).toBe("recipe club-poll@1.0.0 is a draft and cannot be used on local-dev");
  });

  it("does not read package paths from the prototype chain", () => {
    const cat = rebuild((raw) => {
      raw.networks.push({ ...raw.networks[0], id: "constructor", kind: "local" });
    });
    const r = resolve(spec((p) => (p.network = "constructor")), cat);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.map((d) => d.message)).toContain("ballots@1.0.0 is not published on constructor");
  });
});

describe("buildCatalog", () => {
  const raw = () => ({
    components: [...catalog.components.values()].map((c) => structuredClone(c)) as any[],
    recipes: [...catalog.recipes.values()].map((r) => structuredClone(r)) as any[],
    networks: [...catalog.networks.values()].map((n) => structuredClone(n)) as any[],
  });
  it("rejects inconsistent recipes, networks and components", () => {
    const dupOp = raw();
    dupOp.recipes[0].operations.push(dupOp.recipes[0].operations[0]);
    expect(() => buildCatalog(dupOp)).toThrow(/duplicate operation/);

    const lax = raw();
    const op = lax.recipes[0].operations.find((o: any) => o.floor === "owner");
    op.default = "member";
    expect(() => buildCatalog(lax)).toThrow(/more permissive than the floor/);

    const lockout = raw();
    lockout.recipes[0].operations.find((o: any) => o.floor === "owner").default = "nobody";
    expect(() => buildCatalog(lockout)).toThrow(/cannot be disabled/);

    const mainnet = raw();
    mainnet.networks.push({ ...mainnet.networks[0], id: "main", kind: "mainnet", allowDraftComponents: true });
    expect(() => buildCatalog(mainnet)).toThrow(/only local profiles/);

    const js = raw();
    js.networks[0].rpc = "javascript:alert(1)";
    expect(() => buildCatalog(js)).toThrow(/http/);

    const ghost = raw();
    ghost.components[0].packages["ghost-net"] = ghost.components[0].packages["local-dev"];
    expect(() => buildCatalog(ghost)).toThrow(/unknown network ghost-net/);
  });
});

