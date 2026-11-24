import { describe, expect, test } from "bun:test";

import {
  createReadyLineScanner,
  formatReadyLine,
  isSourceRun,
  parseReadyLine,
  POLICY_BOOTSTRAP_FLAG,
  SESSION_STARTUP_INACTIVITY_MS,
  SESSION_STDIO,
  sessionServeArgv,
  takePolicyBootstrapFlag,
} from "./spawn";

describe("spawn shape", () => {
  test("the serve argv is the list the Hub has always passed", () => {
    expect(sessionServeArgv(["/usr/local/bin/uatu"], "/work/project", "/s/project/")).toEqual([
      "/usr/local/bin/uatu",
      "serve",
      "/work/project",
      "--no-open",
      "--exit-on-stdin-close",
      "--hub-policy-bootstrap",
      "--port",
      "0",
      "--base-path",
      "/s/project/",
      "--manifest-scope",
      "origin",
    ]);
    expect(sessionServeArgv(["bun", "src/cli.ts"], "/w", "/s/w/").slice(0, 4)).toEqual(["bun", "src/cli.ts", "serve", "/w"]);
  });

  test("stdio is three pipes and a private socket on descriptor 3", () => {
    expect([...SESSION_STDIO]).toEqual(["pipe", "pipe", "pipe", "socket-fd"]);
  });

  test("a silent session is given 30 seconds", () => {
    expect(SESSION_STARTUP_INACTIVITY_MS).toBe(30_000);
  });

  test("isSourceRun tells a script path from a compiled binary's entry", () => {
    expect(isSourceRun("/repo/src/cli.ts")).toBe(true);
    expect(isSourceRun("/repo/dist/cli.js")).toBe(true);
    // A compiled binary's Bun.argv[1] is its extensionless virtual entry.
    expect(isSourceRun("/$bunfs/root/uatu")).toBe(false);
    expect(isSourceRun("serve")).toBe(false);
    expect(isSourceRun(null)).toBe(false);
  });

  test("the session takes the bootstrap flag off a serve invocation only", () => {
    const hubSpawned = ["serve", "/w", "--no-open", POLICY_BOOTSTRAP_FLAG, "--port", "0"];
    expect(takePolicyBootstrapFlag(hubSpawned)).toBe(true);
    expect(hubSpawned).toEqual(["serve", "/w", "--no-open", "--port", "0"]);
    const plain = ["serve", "/w"];
    expect(takePolicyBootstrapFlag(plain)).toBe(false);
    const hub = ["hub", POLICY_BOOTSTRAP_FLAG];
    expect(takePolicyBootstrapFlag(hub)).toBe(false);
    expect(hub).toEqual(["hub", POLICY_BOOTSTRAP_FLAG]);
  });
});

describe("formatReadyLine", () => {
  test("default base path with a token matches the historical shape", () => {
    expect(formatReadyLine(4711, "/", "abc")).toBe("http://127.0.0.1:4711/?t=abc");
  });

  test("default base path without a token is the slashless origin", () => {
    expect(formatReadyLine(4711, "/")).toBe("http://127.0.0.1:4711");
  });

  test("a base path is carried in both token and tokenless forms", () => {
    expect(formatReadyLine(4711, "/s/uatu/", "abc")).toBe("http://127.0.0.1:4711/s/uatu/?t=abc");
    expect(formatReadyLine(4711, "/s/uatu/")).toBe("http://127.0.0.1:4711/s/uatu/");
  });

  test("token values are URL-encoded", () => {
    expect(formatReadyLine(4711, "/", "a+b/c")).toBe("http://127.0.0.1:4711/?t=a%2Bb%2Fc");
  });
});

describe("parseReadyLine", () => {
  test("round-trips every form the formatter prints", () => {
    for (const [basePath, token] of [["/", "a+b/c"], ["/", undefined], ["/s/uatu/", "abc"], ["/s/uatu/", undefined]] as const) {
      const text = formatReadyLine(4711, basePath, token);
      const ready = parseReadyLine(`${text}\n`);
      expect(ready?.text).toBe(text);
      expect(ready?.endpoint).toEqual({ hostname: "127.0.0.1", port: 4711 });
      expect(ready?.token).toBe(token ?? null);
      expect(ready?.url.pathname).toBe(basePath);
    }
  });

  test("finds the URL after startup progress output", () => {
    expect(parseReadyLine("uatu: indexing /repo\nuatu: still starting\nhttp://127.0.0.1:5/s/x/?t=tok")?.token).toBe("tok");
    expect(parseReadyLine("uatu: indexing /repo\n")).toBeNull();
    expect(parseReadyLine("https://127.0.0.1:5/")).toBeNull();
  });
});

describe("createReadyLineScanner", () => {
  test("accepts only complete lines, so a chunk-split fragment is never a session", () => {
    const scanner = createReadyLineScanner();
    expect(scanner.push("http://127")).toBeNull();
    expect(scanner.push(".0.0.1:4711/s/uatu/?t=ab")).toBeNull();
    const ready = scanner.push("c\n");
    expect(ready?.text).toBe("http://127.0.0.1:4711/s/uatu/?t=abc");
    expect(ready?.endpoint.port).toBe(4711);
  });

  test("drops scanned progress lines and keeps the unfinished tail", () => {
    const scanner = createReadyLineScanner();
    expect(scanner.push("uatu: indexing\nuatu: still ")).toBeNull();
    expect(scanner.push("starting\nhttp://127.0.0.1:9/")).toBeNull();
    expect(scanner.push("\n")?.text).toBe("http://127.0.0.1:9/");
  });
});
