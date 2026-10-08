import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, zip } from "../src/lib/zip.ts";
import { diffFiles, diffLines, hunks } from "../src/lib/diff.ts";

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("writes an archive unzip accepts, byte-identical for the same files", () => {
    const files = { "app.gno": "package app\n// é ✓\n", "gnomod.toml": 'module = "x"\n', "remix.project.json": "{}\n" };
    const a = zip(files, "clubpoll");
    expect(zip({ ...files }, "clubpoll")).toEqual(a);
    const dir = mkdtempSync(join(tmpdir(), "rl-zip-"));
    writeFileSync(join(dir, "p.zip"), a);
    expect(execFileSync("unzip", ["-t", join(dir, "p.zip")], { encoding: "utf8" })).toMatch(/No errors detected/);
    expect(execFileSync("unzip", ["-p", join(dir, "p.zip"), "clubpoll/app.gno"], { encoding: "utf8" })).toBe(files["app.gno"]);
  });
  it("refuses names that escape the folder", () => {
    expect(() => zip({ "../x": "" })).toThrow();
    expect(() => zip({ "/etc/x": "" })).toThrow();
  });
});

describe("diff", () => {
  it("aligns changed lines and keeps line numbers", () => {
    const d = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(d.map((l) => `${l.kind[0]}${l.text}`)).toEqual(["sa", "db", "aB", "sc", "sd", "ae"]);
    expect(d.find((l) => l.text === "e")?.b).toBe(5);
  });
  it("reports added, removed and changed files only", () => {
    const c = diffFiles({ a: "1", b: "2", same: "x" }, { b: "3", c: "4", same: "x" });
    expect(c.map((x) => `${x.name}:${x.status}`)).toEqual(["a:removed", "b:changed", "c:added"]);
  });
  it("collapses long unchanged runs", () => {
    const before = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l25", "changed");
    const h = hunks(diffLines(before, after), 2);
    expect(h.filter((x) => x.kind === "gap").map((x) => (x as { count: number }).count)).toEqual([23, 22]);
  });
});
