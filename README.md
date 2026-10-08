# Remix Lab

Assemble a Gno application from reviewed components, read the generated
code, test it, and deploy a realm you control. See
`Remix_Lab_Implementation_Plan.md` for the full plan.

## Status

| Area | State |
|---|---|
| Gno blocks: core, membership, policies, forms, ballots, render (RML-03–07) | Implemented with unit tests |
| Recipes: club poll, community directory, demo contest (RML-05, 06, 17) | Generated realms, adversarial tests and local-node scenarios pass |
| Shared membership realm and shared-membership poll (RML-08) | Unit tests and local-node scenario pass |
| Catalog manifests, project schema, resolver, lockfile (RML-02, 09) | All three recipes |
| Deterministic generator and export (RML-10) | All three recipes; each reference realm is byte-identical generator output |
| Toolchain/local-node compatibility (RML-01) | Local node done; Onyx deploy script and readback verifier ready, deploy pending; Adena still open |
| Chain adapter: transport, typed-value decoding, reads, transaction outcomes, message builders (RML-14) | Tested against wire fixtures recorded from a local node; not yet run against a public node |
| Web app, validator service, wallet adapter | Not started |

Compatibility findings: `docs/compat/2026-10-toolchain-660decca0.md`.

## Layout

```
gno/                 Gno workspace (gnowork.toml)
  p/<maintainer>/remixlab/*/v1   reusable blocks
  r/<maintainer>/remixlab/*      reference realms
tests/integration/   local-node scenarios (txtar, in-memory gno.land node)
catalog/             component manifests, recipes, network profiles, example projects
packages/spec        project/catalog schemas, canonical JSON, digests
packages/resolver    recipe + network -> exact package paths (lockfile)
packages/generator   deterministic Gno source, tests and export (remix-gen CLI)
packages/chain       JSON-RPC, typed-value decoding, reads, tx outcomes, VM messages
scripts/             fixture and digest regeneration, generated-variant checks,
                     toolchain link, Onyx deploy and deploy verification
apps/, services/     web app and validator (planned)
docs/                compatibility reports, ADRs
```

Packages live in the maintainer's address namespace,
`gno.land/{p,r}/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/...`.

## Running the checks

Requires Node 24+, pnpm 10, Go 1.25+ and the `gno` CLI at the pinned commit.

```sh
pnpm install
pnpm typecheck && pnpm test        # schemas, resolver, generator, chain adapter
pnpm check:generated               # generate 30 config variants; gno fmt/lint/test each

# Gno unit tests and lint
cd gno && gno test ./... && gno lint ./...

# Local-node scenarios (about 70 s; the poll and contest wait out deadlines)
scripts/link-toolchain.sh          # links $GNOROOT at the pinned commit
cd tests/integration && go test ./...

# Re-record the chain adapter's wire fixtures from a local node
pnpm fixtures:wire
```

## Generating an app

```sh
pnpm gen catalog/recipes/examples/club-poll.default.json out/ --export
```

Example projects live in `catalog/recipes/examples/`. The realms
`gno/r/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/{clubpoll,directory,contest}` are generator output
(`pnpm regen:fixtures` rewrites them); the `<name>_test.gno` file in each
holds hand-written adversarial tests. The generator test fails if a realm
drifts from its project.

Deploy only the runtime files: `gnokey maketx addpkg -pkgdir` uploads every
`.gno` file in the directory, tests included. The exported `DEPLOY.md`
shows how.

## Deploying the maintainer packages

`scripts/deploy.sh` deploys the libraries and reference realms to the Onyx
testnet (`onyx-1`) from the `mainclock` gnokey entry, asking only for its
password. It stages runtime files, deploys in dependency order and skips
packages already on chain, so it can be rerun. Then:

```sh
node scripts/verify-deploy.ts
```

checks every package: its on-chain digest equals the digest of the local
runtime files (and, for catalog components, the manifest's `sourceDigest`),
the chain recorded the maintainer as creator, and the maintainer owns each
realm. `KEY`, `CHAIN_ID`, `REMOTE` and the gas variables override the
deploy defaults.

Deployed `/p/` packages cannot be changed. Any fix after deployment needs a
new version path (`.../v2`), so run the full check suite before deploying.
