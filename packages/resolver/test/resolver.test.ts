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
      "ballots=gno.land/p/remixlab/ballots/v1",
      "core=gno.land/p/remixlab/core/v1",
      "membership=gno.land/p/remixlab/membership/v1",
      "policies=gno.land/p/remixlab/policies/v1",
      "render=gno.land/p/remixlab/render/v1",
    ]);
    expect(r.value.lock.thirdParty).toEqual(["gno.land/p/nt/avl/v0"]);
    expect(r.value.supported).toBe(false); // draft components
  });

  it("refuses draft and unpublished components on the public testnet", () => {
    const r = resolve(spec((p) => (p.network = "pearl-1")), catalog);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const messages = r.diagnostics.map((d) => d.message);
    expect(messages).toContain("ballots@1.0.0 is a draft and cannot be used on pearl-1");
    expect(messages).toContain("ballots@1.0.0 is not published on pearl-1");
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
});
