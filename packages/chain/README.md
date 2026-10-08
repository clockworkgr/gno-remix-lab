# @remixlab/chain

The Lab's chain adapter. It contains:

- `rpc.ts`: a bounded JSON-RPC transport (timeouts and response size limits),
  with typed `RpcError` and `TransportError`.
- `encoding.ts`: base64 (JSON-RPC) versus hex (display) hashes and
  little-endian integers. It runs in browsers and Node.
- `values.ts`: a decoder for `vm/qeval_json` typed values, driven by schemas.
  It checks type IDs, caps slice lengths and the total node count, and never
  follows object references.
- `views.ts`: schemas for the v1 view structs. A test compares them with the
  Gno sources.
- `query.ts`: `ChainReader` for read functions, rendered pages and on-chain
  source readback. Every result is stamped with its network and observation
  time.
- `tx.ts`: transaction outcomes (`pending`, `rejected`, `committed-success`,
  `committed-failure`, `unknown`) and a tracker that backs off and never
  re-signs.
- `messages.ts`: Amino JSON for `MsgCall` and `MsgAddPackage`. Only runtime
  files are accepted.

## Wire fixtures

`test/fixtures/*.json` are raw requests and responses recorded from a real
local node by `tests/integration/testdata/wire.txtar`. The machine's hostname
is replaced with `fixture-host` before they are saved. To re-record them
after a toolchain bump:

```sh
pnpm fixtures:wire
```

Then rerun `pnpm test`. A failing decoder test after a bump is a
compatibility finding: record it in `docs/compat/`.
