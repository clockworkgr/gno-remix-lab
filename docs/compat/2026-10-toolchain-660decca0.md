# Compatibility report: toolchain 660decca0

Status: **local node verified; public testnet and wallet not yet verified.**
Recorded 7 October 2026 (RML-01, partial).

## Pinned toolchain

| Item | Value |
|---|---|
| Gno checkout | `660decca0` (21 Sep 2026), pinned in `/TOOLCHAIN` |
| `gno` CLI | `master.3357+660decca0` |
| `gnomod.toml` language | `gno = "0.9"` |
| Go (integration harness) | 1.25.9+ (the Gno module requires it; Go auto-switches) |

## Verified on the in-memory node (`tests/integration`)

| Capability | Result | Fixture |
|---|---|---|
| `/p/` libraries in genesis, app realm via `MsgAddPackage` | Works | `clubpoll.txtar` |
| `init(cur realm)` sees the deployer as `cur.Previous()`, `IsUser()` true | Works; the deployer becomes owner | `clubpoll.txtar` |
| Admin auth from `cur.Previous().Address()` | Works; non-owner and intermediary realms rejected | `clubpoll.txtar`, `clubpoll_test.gno` |
| Panic message reaches the client as the tx error | Works (`remix: unauthorized: ...` in gnokey stderr) | both |
| `vm/qeval` of exported read functions | Works | both |
| `vm/qeval_json` returning a `/p/` struct (`core.BallotView`) | Works, but see finding 9 on its format | `clubpoll.txtar`, `contest.txtar` |
| `vm/qrender` with a render path | Works | both |
| Non-crossing read calls into another realm (`sharedmembers.Snapshot`) from a crossing function | Works; returned slice can be copied into the host's state | `sharedpoll.txtar` |
| Frozen electorate unaffected by later shared-membership changes | Works | `sharedpoll.txtar` |
| Deadlines from `time.Now()` in transactions | Works, with the block-time caveat below | `clubpoll.txtar` |
| Form submissions with one string parameter per field, empty strings for optional fields | Works | `directory.txtar` |
| `vm/qfile` on a package path lists its on-chain files | Works | `directory.txtar` |
| Single-run contest: capped admission, ballot built from admitted entries at opening | Works | `contest.txtar` |
| `vm/qfile <pkg>/<file>` returns the deployed source byte for byte | Works | `wire.txtar`, `packages/chain` tests |
| JSON-RPC outcomes: `tx` lookup of committed success and failure, unknown hash (-32603), CheckTx rejection in `broadcast_tx_sync`, unknown method (-32601) | Recorded as wire fixtures | `wire.txtar` |

## Findings that change the plan

1. **Every `/p/` dependency must exist on the target chain.** The first local
   run failed at genesis because `gno.land/p/nt/avl/v0` was not loaded:
   `gno test` resolves it from the toolchain examples, a chain does not.
   The resolver must list third-party paths and the deploy flow must check
   them on the target network (plan §15, "missing dependency").
2. **Block time lags after idle periods.** Block time is the median of the
   previous commit's vote times, so the first block or two after an idle gap
   carry the old time. A deadline that has passed by wall clock can still be
   "not reached" for the next transaction. The UI should say "voting ended,
   finalization available shortly" and retry rather than report failure.
   The integration test uses two filler transactions after waiting.
3. **Under `gno test`, realm `init` has no deployer.** `cur.Previous()` is
   empty, including for imported realms in filetests. Reference realms
   therefore initialize only when the deployer is a user and call an
   unexported `setup(owner)`, which unit tests call directly. There is no
   public initialization entry point to front-run.
4. **`testing.SetRealm` applies to the calling frame.** Helpers that call it
   have no effect on the test body; call it inline.
5. **`uassert.AbortsWithMessage` takes the test's `cur`** and does not
   compare enum types with `Equal`; convert to `int`.
6. **`gnowork.toml` workspaces do not follow symlinked package trees.**
   The variant checker copies `gno/p` into its temporary workspace.
7. **`MsgCall` arguments are primitives.** Variable-length inputs (poll
   options, form answers) need an explicit encoding. The club poll uses a
   `|`-separated option list; forms will use one parameter per field in
   generated code.
8. **`gnokey maketx addpkg -pkgdir` uploads `_test.gno` files.** Every
   `.gno` file in the directory goes on chain, tests included (confirmed with
   `vm/qfile`). Deployments must start from a staged runtime bundle; the
   harness's `stageruntime` command does this, `DEPLOY.md` says so, and the
   wallet flow builds `MsgAddPackage` from the generator's runtime files
   only. Leaving the tests out cut deploy gas by 10–15M for these realms.
9. **`vm/qeval_json` returns typed values, not plain JSON.** The result is
   `{"results":[{"T":...,"V":...}]}`: struct fields are positional (no
   names), integers are base64 little-endian in `N`, and zero values omit
   `N`. The chain adapter needs a decoder keyed by the view schema version
   (`core.ViewSchemaVersion`) and field order; alternatively, realms can add
   string-encoded read functions. Rendered pages and `vm/qeval` text are
   fine for scenario assertions. `packages/chain` now decodes these values
   against per-view schemas (type IDs checked, references refused).
10. **Rendering is not cheap.** A contest home page with two entries
    renders for about 20M gas in `gno test`. Query gas limits on the target
    network need checking before page sizes are final (RML-18).
11. **A failing call never reaches the chain through `gnokey` by default.**
    gnokey simulates first and stops on a VM panic, so there is no hash.
    With `-simulate skip`, the transaction is committed as a failure (fees
    charged, `ResponseBase.Error` set to `/abci.StringError` with the
    realm's panic message). Wallets may behave either way, so the tracker
    handles both.
12. **`tx` lookups work with `tx_index: off`** on the in-memory node.
    Onyx's public RPC (also `tx_index: off`) serves the `tx` method too: an
    unknown hash returns -32603 "Could not find tx result for hash …",
    the same as the fixture, so the adapter reports "unknown". A hit has
    not been observed on Onyx yet.
13. **Onyx reports a missing package differently.** `onyx-1` (node
    v1.0.0-rc.0, `tx_index: off`) answers `vm/qfile` for an unknown path
    with `/vm.InvalidPackageError` `package "…" is not available`; the
    pinned toolchain answers `/vm.InvalidPkgPathError`. The adapter treats
    both as "not deployed" (fixture `onyx_qfile_missing.json`). Onyx
    enforces namespaces through `gno.land/r/sys/names` and has CLA
    enforcement configured (`gno.land/r/sys/cla`); gas price is 1 ugnot per
    1000 gas and storage 100 ugnot per byte.
14. **The chain rewrites `gnomod.toml` on deploy.** It keeps the `module`
    and `gno` lines and appends an `[addpkg]` table (creator, height,
    max_deposit). The bundle digest therefore reads only those two lines of
    gnomod.toml; recomputed from Onyx readback, the digests of two deployed
    Guildhall packages equal the digests of their local files.

## Measured costs (in-memory node, default params)

Storage fees are 100 ugnot per byte here; recheck on the target network.

| Transaction | Gas used | Storage delta |
|---|---|---|
| addpkg `sharedmembers` (runtime files only, libs in genesis) | 16.7M | 28,433 B |
| addpkg `sharedpoll` | 25.2M | 40,227 B |
| addpkg `clubpoll` | 30.9M | 54,910 B |
| addpkg `directory` (5 fields) | 33.5M | 60,488 B |
| `Invite` | 7.4M | 1,073 B |
| `Join` | 5.9M | 1,016 B |
| `CreatePoll` (2 options) | 9.7M | 3,523 B |
| `OpenPoll` (2-member electorate, cross-realm snapshot) | 11.4M | 4,537 B |
| `Vote` | 7.8–8.2M | 1,042–2,033 B |
| directory `Submit` (5 fields) | 11.0–12.7M | 3,594–5,647 B |
| directory `Accept` / `Reject` | 9.7–9.9M | 20–30 B |
| addpkg `contest` (3 fields) | 41.3M | 69,854 B |
| contest `Submit` | 11.0–12.0M | 3,648–5,574 B |
| contest `OpenVoting` (2 entries, 3-member electorate) | 14.5M | 10,557 B |
| contest `Vote` | 9.5–10.5M | 1,076–2,048 B |
| contest `Finalize` | 9.1M | small |
| rejected call (validation panic) | 4.6–9.6M | none |

Not yet measured at the configured limits (100 members, 20 options, 100
polls); that is the benchmark gate (RML-18).

## Onyx deployment (`onyx-1`, 2026-10-08)

All eleven packages were deployed with `scripts/deploy.sh` under
`gno.land/{p,r}/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/`.
`scripts/verify-deploy.ts` passes: every package's digest equals both
the local runtime files and the catalog `sourceDigest`, the `[addpkg]`
creator is the maintainer, and the maintainer is owner of all five
realms. Storage, from `vm/qstorage` (100 ugnot per byte):

| Package | Storage | Deposit |
|---|---|---|
| `p/…/core/v1` | 17,023 B | 1.70 GNOT |
| `p/…/render/v1` | 21,560 B | 2.16 GNOT |
| `p/…/membership/v1` | 4,586 B | 0.46 GNOT |
| `p/…/policies/v1` | 6,875 B | 0.69 GNOT |
| `p/…/forms/v1` | 9,028 B | 0.90 GNOT |
| `p/…/ballots/v1` | 5,241 B | 0.52 GNOT |
| `r/…/clubpoll` | 62,223 B | 6.22 GNOT |
| `r/…/directory` | 69,805 B | 6.98 GNOT |
| `r/…/contest` | 80,037 B | 8.00 GNOT |
| `r/…/sharedmembers` | 32,240 B | 3.22 GNOT |
| `r/…/sharedpoll` | 45,780 B | 4.58 GNOT |
| **Total** | **354,398 B** | **35.44 GNOT** |

The maintainer's balance fell by 45.44 GNOT (188,889,186 → 143,447,386
ugnot) over 14 transactions (sequence 103 → 117): 35.44 GNOT of storage
deposits and 10.00 GNOT of fees. Per-transaction gas was not recorded,
and Onyx's `tx_index: off` means it cannot be looked up afterwards.

The catalog lists the Onyx paths. The recipes and components were marked
`reviewed` the same day (internal review by the Remix Lab maintainers),
so the composer can target Onyx. `onyx-1` stays `verified: false` until
a deploy and calls through Adena have been tried there.

## Still open for RML-01

- Adena: add-package and call messages from the browser extension.
- Call the deployed realms on Onyx (invite, join, poll, vote) and record
  gas per call.
- Measure gas/storage at configured limits and decide gas-wanted defaults.
