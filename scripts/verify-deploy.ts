// Compares the deployed Remix Lab packages with the local runtime files and
// checks that the maintainer owns each reference app realm.
//
//   node scripts/verify-deploy.ts [--remote URL] [--network ID]
//
// .gno files must match byte for byte. gnomod.toml is compared by its module
// line only, because the chain may rewrite the rest of it on deploy.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ChainReader, HttpTransport } from "@remixlab/chain";

const MAINTAINER = "g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm";
const OWNED_APPS = ["clubpoll", "directory", "contest"];

const { values } = parseArgs({
  options: {
    remote: { type: "string", default: "https://rpc.onyx.testnets.gno.land:443" },
    network: { type: "string", default: "onyx-1" },
  },
});

const root = join(import.meta.dirname, "..");
const reader = new ChainReader(new HttpTransport(values.remote!), { network: values.network! });

function localPackages(): string[] {
  const out: string[] = [];
  for (const d of readdirSync(join(root, "gno/p", MAINTAINER, "remixlab"))) out.push(`p/${MAINTAINER}/remixlab/${d}/v1`);
  for (const d of readdirSync(join(root, "gno/r", MAINTAINER, "remixlab"))) out.push(`r/${MAINTAINER}/remixlab/${d}`);
  return out.sort();
}

function runtimeFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const n of readdirSync(dir)) {
    if (n === "gnomod.toml" || (n.endsWith(".gno") && !n.endsWith("_test.gno") && !n.endsWith("_filetest.gno"))) {
      files[n] = readFileSync(join(dir, n), "utf8");
    }
  }
  return files;
}

const moduleLine = (toml: string) => /^module\s*=.*$/m.exec(toml)?.[0];

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`FAIL   ${msg}`);
};

for (const p of localPackages()) {
  const path = `gno.land/${p}`;
  const local = runtimeFiles(join(root, "gno", p));
  const chain = await reader.readPackage(path);
  if (chain === null) {
    fail(`${path}: not deployed`);
    continue;
  }
  const problems: string[] = [];
  for (const name of new Set([...Object.keys(local), ...Object.keys(chain)])) {
    const l = local[name];
    const c = chain[name];
    if (l === undefined) problems.push(`${name} is on chain only`);
    else if (c === undefined) problems.push(`${name} is missing on chain`);
    else if (name === "gnomod.toml" ? moduleLine(l) !== moduleLine(c) : l !== c) problems.push(`${name} differs`);
  }
  if (problems.length > 0) fail(`${path}: ${problems.join("; ")}`);
  else console.log(`ok     ${path} (${Object.keys(local).length} files)`);
}

for (const app of OWNED_APPS) {
  const path = `gno.land/r/${MAINTAINER}/remixlab/${app}`;
  try {
    const [role] = (await reader.read(path, "RoleOf", [{ address: MAINTAINER }], [{ kind: "string" }])).value;
    if (role === "owner") console.log(`ok     ${path}: maintainer is owner`);
    else fail(`${path}: maintainer role is ${JSON.stringify(role)}`);
  } catch (e) {
    fail(`${path}: RoleOf: ${(e as Error).message}`);
  }
}

console.log(failures === 0 ? `All packages match on ${values.network}.` : `${failures} problem(s) on ${values.network}.`);
process.exitCode = failures === 0 ? 0 : 1;
