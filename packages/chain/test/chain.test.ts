import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ChainError,
  ChainReader,
  DecodeError,
  HttpTransport,
  RpcError,
  TransportError,
  TxHash,
  broadcastSync,
  callExpr,
  decodeResults,
  lookupTx,
  msgAddPackage,
  msgCall,
  parseEnvelope,
  trackTx,
  viewSchemas,
  type Schema,
  type Transport,
} from "@remixlab/chain";

// Fixtures are raw responses recorded from a local node by
// tests/integration/testdata/wire.txtar (see packages/chain/README.md).
const root = join(import.meta.dirname, "../../..");
const fixtureDir = join(import.meta.dirname, "fixtures");
interface Fixture {
  request: { method: string; params: Record<string, unknown> };
  response: unknown;
}
const fixtures: Fixture[] = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(fixtureDir, f), "utf8")));
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"));

/** Replays recorded responses for identical requests. */
class ReplayTransport implements Transport {
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const f = fixtures.find((x) => x.request.method === method && sorted(x.request.params) === sorted(params));
    if (!f) throw new Error(`no fixture for ${method} ${JSON.stringify(params)}`);
    return parseEnvelope(f.response, method);
  }
}

const sorted = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
const rpc = new ReplayTransport();
const reader = new ChainReader(rpc, { network: "local-dev", now: () => new Date(0) });
const v = viewSchemas({
  core: "gno.land/p/remixlab/core/v1",
  policies: "gno.land/p/remixlab/policies/v1",
  forms: "gno.land/p/remixlab/forms/v1",
});
const POLL = "gno.land/r/remixlab/clubpoll";
const DIR = "gno.land/r/remixlab/directory";
const addrOf = (name: string) => {
  const data = atob((fixture(name).request.params as { data: string }).data);
  return /"(g1[0-9a-z]{38})"/.exec(data)![1]!;
};

describe("reads against recorded node responses", () => {
  it("decodes a string result and stamps the observation", async () => {
    const r = await reader.read(POLL, "RoleOf", [{ address: addrOf("qeval_json_role") }], [v.string]);
    expect(r.value).toEqual(["owner"]);
    expect(r.network).toBe("local-dev");
    expect(r.observedAt).toEqual(new Date(0));
  });

  it("decodes a BallotView with its ok flag", async () => {
    const [poll, ok] = (await reader.read(POLL, "Poll", [1], [v.ballot, v.bool])).value;
    expect(ok).toBe(true);
    expect(poll).toMatchObject({
      id: "1",
      title: "Venue",
      options: ["Library", "Cafe"],
      status: "open",
      public: false,
      electorateSize: 2,
      quorumPercent: 0,
      counts: [0, 1],
      abstentions: 0,
      turnout: 1,
      outcome: "pending",
      winner: -1,
    });
    expect(poll.deadline - poll.openedAt).toBe(3600);
  });

  it("decodes a missing ballot as zero values", async () => {
    const [poll, ok] = (await reader.read(POLL, "Poll", [9], [v.ballot, v.bool])).value;
    expect(ok).toBe(false);
    expect(poll).toMatchObject({ id: "0", title: "", options: [], status: "draft", counts: [], winner: 0 });
  });

  it("decodes members, rules, the descriptor and booleans", async () => {
    const [members] = (await reader.read(POLL, "Members", [0, 25], [v.members])).value;
    expect(members.map((m) => m.role).sort()).toEqual(["member", "owner"]);
    expect(members.every((m) => /^g1/.test(m.address))).toBe(true);

    const [rules] = (await reader.read(POLL, "Rules", [], [v.rules!])).value;
    expect(rules).toContainEqual({ op: "members.invite", rule: "owner", floor: "reviewer" });
    expect(rules).toHaveLength(6);

    const [d] = (await reader.read(POLL, "Descriptor", [], [v.descriptor])).value;
    expect(d).toMatchObject({ recipe: "club-poll", recipeVersion: "1.0.0", viewSchemaVersion: 1 });
    expect(d.configDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d.bindings).toEqual([`membership.read/v1=${POLL}`]);

    const [voted] = (await reader.read(POLL, "HasVoted", [1, { address: addrOf("qeval_json_hasvoted") }], [v.bool])).value;
    expect(voted).toBe(true);
  });

  it("decodes submissions, empty slices and form fields", async () => {
    const [entry, ok] = (await reader.read(DIR, "Entry", [1], [v.submission, v.bool])).value;
    expect(ok).toBe(true);
    expect(entry).toMatchObject({ id: "1", status: "accepted" });
    expect(entry.answers).toEqual(["Gno Boards", "gno.land/r/demo/boards", "Realm", "2023", "Line one.\\nLine two."]);

    const [queue] = (await reader.read(DIR, "Queue", [0, 25], [v.submissions])).value;
    expect(queue).toEqual([]);

    const [fields] = (await reader.read(DIR, "Fields", [], [v.fields!])).value;
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["name", "text", true],
      ["link", "text", true],
      ["category", "choice", true],
      ["since", "integer", false],
      ["summary", "text", false],
    ]);
    expect(fields[3]).toMatchObject({ min: 2000, max: 2100 });
    expect(fields[2]!.choices).toEqual(["Realm", "Library", "Tool", "Other"]);
  });

  it("surfaces VM errors with their type and message", async () => {
    const unknownFn = await reader.read(POLL, "Nope", [], [v.string]).catch((e) => e);
    expect(unknownFn).toBeInstanceOf(ChainError);
    expect(unknownFn.type).toBe("/abci.StringError");
    expect(unknownFn.message).toMatch(/name Nope not declared/);
    expect(unknownFn.remix).toBeUndefined();
  });

  it("reports a missing package as InvalidPkgPathError", async () => {
    const e = await reader.read("gno.land/r/remixlab/nothere", "Render", [""], [v.string]).catch((x) => x);
    expect(e).toBeInstanceOf(ChainError);
    expect(e.type).toBe("/vm.InvalidPkgPathError");
    expect(e.message).toBe("package not found: gno.land/r/remixlab/nothere");
  });

  it("renders pages and reads back deployed source byte for byte", async () => {
    const page = (await reader.render(POLL, "polls/1")).value;
    expect(page).toContain("# Venue");
    expect(page).toContain("[vote](/r/remixlab/clubpoll$help&func=Vote&id=1&choice=1)");

    expect(await reader.files(POLL)).toEqual(["app.gno", "descriptor.gno", "gnomod.toml", "render.gno"]);
    const onChain = await reader.query("vm/qfile", `${POLL}/descriptor.gno`);
    expect(onChain).toBe(readFileSync(join(root, "gno/r/remixlab/clubpoll/descriptor.gno"), "utf8"));
  });
});

describe("transactions against recorded node responses", () => {
  const hashOf = (name: string) => TxHash.fromBase64((fixture(name).request.params as { hash: string }).hash);

  it("normalizes a committed success", async () => {
    const out = await lookupTx(rpc, hashOf("tx_success"));
    expect(out.status).toBe("committed-success");
    if (out.status !== "committed-success") return;
    expect(out.height).toBeGreaterThan(0);
    expect(out.gasUsed).toBeGreaterThan(1_000_000);
    expect(out.gasWanted).toBe(20_000_000);
    expect(out.events).toHaveLength(1);
  });

  it("normalizes a committed failure with the realm's error", async () => {
    const out = await lookupTx(rpc, hashOf("tx_failure"));
    expect(out.status).toBe("committed-failure");
    if (out.status !== "committed-failure") return;
    expect(out.error.message).toBe("remix: unauthorized: not in the electorate");
    expect(out.error.remix).toEqual({ category: "unauthorized", detail: "not in the electorate" });
  });

  it("reports an unknown hash as unknown, not as failure", async () => {
    const out = await lookupTx(rpc, hashOf("tx_unknown"));
    expect(out.status).toBe("unknown");
  });

  it("reports a broadcast refused at CheckTx as rejected", async () => {
    const out = await broadcastSync(rpc, "AQID");
    expect(out.status).toBe("rejected");
    if (out.status === "rejected") expect(out.error.type).toBe("/std.TxDecodeError");
  });

  it("keeps JSON-RPC errors distinct", async () => {
    const e: any = await rpc.call("no_such_method", {}).catch((x) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe(-32601);
  });

  it("converts hashes between JSON-RPC base64 and display hex", () => {
    const h = hashOf("tx_success");
    expect(TxHash.fromHex(h.hex).base64).toBe(h.base64);
    expect(() => TxHash.fromBase64("AQID")).toThrow(/32 bytes/);
  });
});

describe("trackTx", () => {
  const hash = TxHash.fromHex("00".repeat(32));
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms), elapsed: () => t };
  };

  it("polls with backoff until the transaction commits", async () => {
    let calls = 0;
    const seq: Transport = {
      async call(method, params) {
        calls++;
        if (calls < 4) throw new RpcError(-32603, "Internal error", "Could not find tx result for hash #00");
        const r = fixture("tx_success").response as { result: Record<string, unknown> };
        return { ...r.result, hash: (params as { hash: string }).hash };
      },
    };
    const c = clock();
    const out = await trackTx(seq, hash, { intervalMs: 2000, maxIntervalMs: 5000, timeoutMs: 60_000, ...c });
    expect(out.status).toBe("committed-success");
    expect(calls).toBe(4);
    expect(c.elapsed()).toBe(2000 + 4000 + 5000);
  });

  it("gives up as unknown and retries transport errors", async () => {
    let calls = 0;
    const flaky: Transport = {
      async call() {
        calls++;
        throw calls % 2 ? new TransportError("down") : new RpcError(-32603, "Internal error", "Could not find tx result");
      },
    };
    const c = clock();
    const out = await trackTx(flaky, hash, { intervalMs: 1000, maxIntervalMs: 1000, timeoutMs: 5000, ...c });
    expect(out).toEqual({ status: "unknown", hash });
    expect(calls).toBe(6); // at 0, 1, 2, 3, 4 and 5 seconds
    expect(c.elapsed()).toBe(5000);
  });
});

describe("decoder limits", () => {
  const poll = JSON.stringify(
    JSON.parse(atob((fixture("qeval_json_poll").response as any).result.response.ResponseBase.Data)),
  );

  it("checks type IDs, so a view from another package path is refused", () => {
    const other = viewSchemas({ core: "gno.land/p/someone/core/v1" });
    expect(() => decodeResults(poll, [other.ballot, other.bool])).toThrow(DecodeError);
  });

  it("enforces slice limits and the node budget", () => {
    const tight = { ...v.ballot, fields: v.ballot.fields.map(([n, s]) => (n === "options" ? [n, { kind: "slice", elem: { kind: "string" }, max: 1 }] : [n, s])) } as Schema;
    expect(() => decodeResults(poll, [tight, v.bool])).toThrow(/more than 1 items/);
    expect(() => decodeResults(poll, [v.ballot, v.bool], { maxNodes: 5 })).toThrow(/too large/);
  });

  it("refuses object references and unsafe integers", () => {
    const ref = JSON.stringify({ results: [{ T: { "@type": "/gno.PrimitiveType", value: "16" }, V: { "@type": "/gno.RefValue", ObjectID: "x" } }] });
    expect(() => decodeResults(ref, [v.string])).toThrow(/not followed/);
    const big = JSON.stringify({ results: [{ T: { "@type": "/gno.PrimitiveType", value: "1024" }, N: "/////////38=" }] });
    expect(() => decodeResults(big, [{ kind: "int", bits: 64 }])).toThrow(/safe range/);
    const id = JSON.stringify({ results: [{ T: { "@type": "/gno.PrimitiveType", value: "65536" }, N: "//////////8=" }] });
    expect(decodeResults(id, [v.uint64])).toEqual(["18446744073709551615"]);
  });

  it("refuses a result count mismatch", () => {
    expect(() => decodeResults(poll, [v.ballot])).toThrow(/expected 1 results, got 2/);
  });
});

describe("view schemas match the Gno sources", () => {
  // Field names (case-insensitively) and Go types, in declaration order.
  const goStruct = (file: string, name: string): Array<[string, string]> => {
    const src = readFileSync(join(root, "gno/p/remixlab", file), "utf8");
    const body = new RegExp(`type ${name} struct \\{([^}]*)\\}`).exec(src)![1]!;
    return body
      .split("\n")
      .map((l) => l.replace(/\/\/.*/, "").trim())
      .filter(Boolean)
      .flatMap((l) => {
        const [names, type] = [l.slice(0, l.lastIndexOf(" ")).trim(), l.slice(l.lastIndexOf(" ") + 1)];
        return names.split(",").map((n) => [n.trim(), type] as [string, string]);
      });
  };
  const GO_TYPE: Record<string, (s: Schema) => boolean> = {
    string: (s) => s.kind === "string",
    bool: (s) => s.kind === "bool",
    int: (s) => s.kind === "int" && s.bits === 0,
    int64: (s) => s.kind === "int" && s.bits === 64,
    uint64: (s) => s.kind === "uint64",
    address: (s) => s.kind === "address",
    "[]string": (s) => s.kind === "slice" && s.elem.kind === "string",
    "[]int": (s) => s.kind === "slice" && s.elem.kind === "int",
  };
  const cases: Array<[string, string, Schema]> = [
    ["core/v1/views.gno", "MemberView", v.member],
    ["core/v1/views.gno", "BallotView", v.ballot],
    ["core/v1/views.gno", "SubmissionView", v.submission],
    ["core/v1/views.gno", "AppDescriptor", v.descriptor],
    ["policies/v1/policies.gno", "RuleView", v.rules!.elem],
    ["forms/v1/forms.gno", "Field", v.fields!.elem],
  ];
  it.each(cases)("%s %s", (file, name, schema) => {
    if (schema.kind !== "struct") throw new Error("not a struct schema");
    const goFields = goStruct(file, name);
    expect(schema.fields.map(([n]) => n.toLowerCase())).toEqual(goFields.map(([n]) => n.toLowerCase()));
    goFields.forEach(([n, type], i) => {
      const s = schema.fields[i]![1];
      const check = GO_TYPE[type];
      if (check) expect(check(s), `${name}.${n} ${type}`).toBe(true);
      else expect(s.kind, `${name}.${n} ${type}`).toBe("enum");
    });
  });
});

describe("callExpr", () => {
  it("encodes arguments as literals", () => {
    expect(callExpr(POLL, "Poll", [1])).toBe("gno.land/r/remixlab/clubpoll.Poll(1)");
    expect(callExpr(POLL, "X", ['a")+evil("', "line\nbreak", 2n ** 64n - 1n, true])).toBe(
      'gno.land/r/remixlab/clubpoll.X("a\\")+evil(\\"", "line\\nbreak", 18446744073709551615, true)',
    );
  });
  it("rejects unexported or malformed names and bad addresses", () => {
    expect(() => callExpr(POLL, "setup", [])).toThrow();
    expect(() => callExpr(POLL, "X()", [])).toThrow();
    expect(() => callExpr("gno.land/r/x;y", "X", [])).toThrow();
    expect(() => callExpr(POLL, "RoleOf", [{ address: 'g1") + x("' }])).toThrow();
    expect(() => callExpr(POLL, "X", [1.5])).toThrow();
  });
});

describe("HttpTransport", () => {
  const respond = (body: string, headers: Record<string, string> = {}) =>
    (async () => new Response(body, { headers })) as unknown as typeof fetch;

  it("enforces the response size limit", async () => {
    const t = new HttpTransport("http://node", { timeoutMs: 1000, maxResponseBytes: 10 }, respond("x".repeat(11)));
    await expect(t.call("status", {})).rejects.toThrow(/exceeds 10 bytes/);
  });
  it("returns results and raises JSON-RPC errors", async () => {
    const ok = new HttpTransport("http://node", undefined, respond('{"jsonrpc":"2.0","id":1,"result":{"a":1}}'));
    expect(await ok.call("status", {})).toEqual({ a: 1 });
    const bad = new HttpTransport("http://node", undefined, respond('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}'));
    await expect(bad.call("x", {})).rejects.toBeInstanceOf(RpcError);
  });
  it("refuses non-HTTP endpoints", () => {
    expect(() => new HttpTransport("file:///etc/passwd")).toThrow();
  });
});

describe("messages", () => {
  const addr = addrOf("qeval_json_role");
  it("builds an add-package message from runtime files only", () => {
    const m = msgAddPackage({
      creator: addr,
      pkgPath: POLL,
      packageName: "clubpoll",
      files: { "render.gno": "r", "app.gno": "a", "gnomod.toml": "m" },
    });
    expect(m.package.files.map((f) => f.name)).toEqual(["app.gno", "gnomod.toml", "render.gno"]);
    expect(() =>
      msgAddPackage({ creator: addr, pkgPath: POLL, packageName: "clubpoll", files: { "gnomod.toml": "m", "x_test.gno": "t" } }),
    ).toThrow(/not a runtime file/);
    expect(() =>
      msgAddPackage({ creator: addr, pkgPath: "gno.land/p/x/y", packageName: "y", files: { "gnomod.toml": "m", "a.gno": "a" } }),
    ).toThrow();
  });
  it("validates call messages", () => {
    expect(msgCall({ caller: addr, pkgPath: POLL, func: "Vote", args: ["1", "0"] })).toMatchObject({
      "@type": "/vm.m_call",
      pkg_path: POLL,
      func: "Vote",
      args: ["1", "0"],
      send: "",
    });
    expect(() => msgCall({ caller: addr, pkgPath: POLL, func: "Vote", args: [], send: "1 ugnot" })).toThrow();
  });
});
