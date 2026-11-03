import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ScriptDiagnostics } from "./script-diagnostics";

const origin = "http://127.0.0.1:20000";
const asset = "/__uatu/asset/chunk-abcdefgh.js";
const syntax = (url = origin + asset) => ({ name: "SyntaxError", stack: `SECRET message\n at unknown (${url}:42:7)\n/private/SECRET/file.ts` });
const bytes = new TextEncoder().encode("SECRET raw script");
function fixture(options = {}) {
  const records: unknown[] = [];
  let reads = 0;
  const capture = new ScriptDiagnostics(origin, record => records.push(record), options);
  const track = (url = origin + asset, contentLength: string | null = String(bytes.length), readBody = async () => bytes) => capture.track({url, contentLength, readBody: async () => { reads++; return readBody(); }});
  return {capture, records, track, reads: () => reads};
}

describe("failure-only static script diagnostics", () => {
  test("successful responses cause no body reads or records", async () => {
    const f = fixture(); f.track(); await f.capture.flush();
    expect(f.reads()).toBe(0); expect(f.records).toEqual([]);
  });
  test("syntax error records only path, category, location and received hash", async () => {
    const f = fixture(); f.track(origin + asset + "?token=SECRET");
    f.capture.pageError(syntax(origin + asset + "?token=SECRET")); await f.capture.flush();
    expect(f.reads()).toBe(1);
    expect(f.records).toEqual([{path:asset, category:"SyntaxError", line:42, column:7, outcome:"received", byteLength:bytes.length, sha256:createHash("sha256").update(bytes).digest("hex")}]);
    expect(JSON.stringify(f.records)).not.toMatch(/SECRET|127\.0\.0\.1|private|token|raw script/);
  });
  test("ignores foreign, authenticated, untracked and non-static error URLs", async () => {
    const f = fixture();
    for (const url of ["http://elsewhere.test" + asset, "http://user:SECRET@127.0.0.1:20000" + asset, origin + "/api/login", origin + "/__uatu/asset/chunk-ijklmnop.js"]) {
      if (!url.endsWith("ijklmnop.js")) f.track(url);
      f.capture.pageError(syntax(url));
    }
    await f.capture.flush(); expect(f.reads()).toBe(0); expect(f.records).toEqual([]);
  });
  test("mounted Hub scripts emit only canonical static paths, not private session prefixes", async () => {
    const f = fixture({basePath:"/s/PRIVATE-workspace/"});
    const url = origin + "/s/PRIVATE-workspace" + asset + "?token=SECRET";
    f.track(url); f.capture.pageError(syntax(url)); await f.capture.flush();
    expect(f.records).toMatchObject([{path:asset, outcome:"received"}]);
    expect(JSON.stringify(f.records)).not.toMatch(/PRIVATE|workspace|SECRET|token/);
  });
  test("mounted collectors reject other sessions and arbitrary path prefixes", async () => {
    const f = fixture({basePath:"/s/PRIVATE-workspace/"});
    for (const prefix of ["/s/other", "/private", ""]) {
      f.track(origin + prefix + asset); f.capture.pageError(syntax(origin + prefix + asset));
    }
    await f.capture.flush(); expect(f.records).toEqual([]); expect(f.reads()).toBe(0);
  });
  test("unknown, oversized and invalid declared sizes are unavailable without reads", async () => {
    for (const size of [null, "999999999", "-1", "NaN", "1.5"]) {
      const f = fixture(); f.track(undefined, size); f.capture.pageError(syntax()); await f.capture.flush();
      expect(f.reads()).toBe(0); expect(f.records).toMatchObject([{outcome:"unavailable", reason:"size"}]);
    }
  });
  test("checks actual size and handles body errors without exposing error text", async () => {
    for (const [readBody, reason] of [[async () => bytes, "size"], [async () => {throw Error("SECRET");}, "body"]] as const) {
      const f = fixture({maxBytes:4}); f.track(undefined, "2", readBody); f.capture.pageError(syntax()); await f.capture.flush();
      expect(f.records).toMatchObject([{outcome:"unavailable", reason}]); expect(JSON.stringify(f.records)).not.toContain("SECRET");
    }
  });
  test("deadline resolves flush and late rejection cannot replace result", async () => {
    const f = fixture({deadlineMs:10}); let reject!: (error: Error) => void;
    f.track(undefined, "2", () => new Promise((_, no) => {reject = no;}));
    f.capture.pageError(syntax()); await f.capture.flush();
    expect(f.records).toMatchObject([{outcome:"unavailable", reason:"deadline"}]);
    reject(Error("SECRET")); await Promise.resolve(); expect(f.records).toHaveLength(1);
  });
  test("bounds tracked scripts and captures and deduplicates repeated page errors", async () => {
    const f = fixture({maxScripts:1, maxCaptures:1}); f.track(); f.track(origin + "/__uatu/asset/chunk-ijklmnop.js");
    f.capture.pageError(syntax(origin + "/__uatu/asset/chunk-ijklmnop.js"));
    f.capture.pageError(syntax()); f.capture.pageError(syntax()); await f.capture.flush();
    expect(f.reads()).toBe(1); expect(f.records).toHaveLength(1);
  });
  test("capture cap applies across distinct scripts and arbitrary error names are not emitted", async () => {
    const f = fixture({maxCaptures:1}); f.track(); f.track(origin + "/__uatu/asset/chunk-ijklmnop.js");
    f.capture.pageError({...syntax(), name:"SECRET"});
    f.capture.pageError(syntax(origin + "/__uatu/asset/chunk-ijklmnop.js")); await f.capture.flush();
    expect(f.reads()).toBe(1); expect(f.records).toMatchObject([{category:"PageError"}]);
    expect(JSON.stringify(f.records)).not.toContain("SECRET");
  });
  test("record callback failures cannot fail cleanup", async () => {
    const capture = new ScriptDiagnostics(origin, () => {throw Error("SECRET");});
    capture.track({url:origin + asset, contentLength:"1", readBody:async () => bytes});
    capture.pageError(syntax()); await capture.flush();
  });
});
