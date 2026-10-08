// Compares the deployed Remix Lab packages with the local runtime files and
// checks that the maintainer deployed and owns them.
//
//   node scripts/verify-deploy.ts [--remote URL] [--network ID]
//
// Each package must hash (remixlab-bundle-v1) to the digest of the local
// runtime files, and catalog components also to their manifest's
// sourceDigest. The digest reads only the module and gno lines of
// gnomod.toml, because the chain rewrites that file on deploy; the [addpkg]
// table it adds must name the maintainer as creator.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bundleDigest } from "@remixlab/spec";
import { loadCatalog, readRuntimeFiles } from "@remixlab/spec/node";
import { ChainReader, HttpTransport, type Schema } from "@remixlab/chain";

const MAINTAINER = "g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm";
const NS = `${MAINTAINER}/remixlab`;

const { values } = parseArgs({
  strict: true,
  options: {
    remote: { type: "string", default: "https://rpc.onyx.testnets.gno.land:443" },
    network: { type: "string", default: "onyx-1" },
  },
});

const root = join(import.meta.dirname, "..");
const reader = new ChainReader(new HttpTransport(values.remote!), { network: values.network! });
const catalogDigests = new Map([...loadCatalog(join(root, "catalog")).components.values()].map((c) => [c.source, c.sourceDigest]));

const packages = [
  ...readdirSync(join(root, "gno/p", NS)).map((d) => `p/${NS}/${d}/v1`),
  ...readdirSync(join(root, "gno/r", NS)).map((d) => `r/${NS}/${d}`),
].sort();

const ROLE: Schema = {
  kind: "enum",
  type: `gno.land/p/${NS}/core/v1.Role`,
  names: ["none", "member", "reviewer", "owner"],
};
// How to ask each realm for the maintainer's role.
const OWNER_CHECKS: Record<string, [fn: string, schema: Schema]> = {
  clubpoll: ["RoleOf", { kind: "string" }],
  directory: ["RoleOf", { kind: "string" }],
  contest: ["RoleOf", { kind: "string" }],
  sharedmembers: ["RoleOf", ROLE],
  sharedpoll: ["AdminRole", { kind: "string" }],
};

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`FAIL   ${msg}`);
};

for (const p of packages) {
  const path = `gno.land/${p}`;
  try {
    const local = readRuntimeFiles(join(root, "gno", p));
    const chain = await reader.readPackage(path);
    if (chain === null) {
      fail(`${path}: not deployed`);
      continue;
    }
    const problems: string[] = [];
    const want = bundleDigest(local);
    const got = bundleDigest(chain);
    if (got !== want) {
      const differing = [...new Set([...Object.keys(local), ...Object.keys(chain)])].filter(
        (n) => n !== "gnomod.toml" && local[n] !== chain[n],
      );
      problems.push(`digest ${got} != local ${want}${differing.length ? ` (${differing.join(", ")} differ)` : ""}`);
    }
    const manifest = catalogDigests.get(`gno/${p}`);
    if (manifest !== undefined && manifest !== want) problems.push(`local files do not match the catalog sourceDigest; run pnpm regen:fixtures`);
    const creator = /^\[addpkg\][\s\S]*?^\s*creator\s*=\s*"([^"]*)"/m.exec(chain["gnomod.toml"] ?? "")?.[1];
    if (creator !== MAINTAINER) problems.push(`deployed by ${creator ?? "unknown"}`);

    const app = p.split("/").pop()!;
    const check = OWNER_CHECKS[app];
    if (p.startsWith("r/") && check) {
      const [role] = (await reader.read(path, check[0], [{ address: MAINTAINER }], [check[1]])).value;
      if (role !== "owner") problems.push(`maintainer role is ${JSON.stringify(role)}`);
    } else if (p.startsWith("r/")) {
      problems.push("no ownership check defined for this realm");
    }

    if (problems.length > 0) fail(`${path}: ${problems.join("; ")}`);
    else console.log(`ok     ${path} ${want}${check ? " (maintainer is owner)" : ""}`);
  } catch (e) {
    fail(`${path}: ${(e as Error).message}`);
  }
}

console.log(failures === 0 ? `All ${packages.length} packages verified on ${values.network}.` : `${failures} problem(s) on ${values.network}.`);
process.exitCode = failures === 0 ? 0 : 1;
