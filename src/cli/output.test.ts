import { describe, expect, test } from "bun:test";

import {
  formatSessionUrl,
  printIndexingStatus,
  printStartupBanner,
  SERVE_DEPRECATION_WARNING,
  shouldWarnServeDeprecation,
  STARTUP_BANNER,
  startSupervisedStartupHeartbeat,
  startupHeartbeatArgv,
} from "./output";

describe("printStartupBanner", () => {
  test("prints the ASCII banner with a leading newline when stdout is a TTY", () => {
    const chunks: string[] = [];
    printStartupBanner({ isTTY: true, write: chunk => chunks.push(chunk) });
    const output = chunks.join("");
    expect(output.startsWith("\n")).toBe(true);
    expect(output).toContain(STARTUP_BANNER);
    expect(output).toContain("I observe. I follow. I render.");
  });

  test("writes nothing when stdout is not a TTY", () => {
    const chunks: string[] = [];
    printStartupBanner({ isTTY: false, write: chunk => chunks.push(chunk) });
    expect(chunks).toHaveLength(0);
  });

  test("prints and clears indexing status when stdout is a TTY", () => {
    const chunks: string[] = [];
    const clear = printIndexingStatus([{ kind: "dir", absolutePath: "/repo" }], {
      isTTY: true,
      write: chunk => chunks.push(chunk),
    });

    expect(chunks.join("")).toContain("Indexing /repo...");
    clear();
    expect(chunks.join("")).toContain("\r");
  });

  test("writes no indexing status when stdout is not a TTY", () => {
    const chunks: string[] = [];
    const clear = printIndexingStatus([{ kind: "dir", absolutePath: "/repo" }], {
      isTTY: false,
      write: chunk => chunks.push(chunk),
    });

    clear();
    expect(chunks).toHaveLength(0);
  });
});

describe("formatSessionUrl", () => {
  test("default base path with a token matches the historical shape", () => {
    expect(formatSessionUrl(4711, "/", "abc")).toBe("http://127.0.0.1:4711/?t=abc");
  });

  test("default base path without a token is the slashless origin", () => {
    expect(formatSessionUrl(4711, "/")).toBe("http://127.0.0.1:4711");
  });

  test("a base path is carried in both token and tokenless forms", () => {
    expect(formatSessionUrl(4711, "/s/uatu/", "abc")).toBe("http://127.0.0.1:4711/s/uatu/?t=abc");
    expect(formatSessionUrl(4711, "/s/uatu/")).toBe("http://127.0.0.1:4711/s/uatu/");
  });

  test("token values are URL-encoded", () => {
    expect(formatSessionUrl(4711, "/", "a+b/c")).toBe("http://127.0.0.1:4711/?t=a%2Bb%2Fc");
  });
});

describe("shouldWarnServeDeprecation", () => {
  test("a user-shaped compiled-binary invocation warns", () => {
    // In a compiled binary Bun.argv[1] is not a script path.
    expect(shouldWarnServeDeprecation({ exitOnStdinClose: false }, "serve")).toBe(true);
    expect(shouldWarnServeDeprecation({ exitOnStdinClose: false }, null)).toBe(true);
  });

  test("hub-spawned session children stay quiet via their supervisor argv", () => {
    // The hub controls the child argv and always passes
    // --exit-on-stdin-close — that flag IS the internal-spawn marker.
    expect(shouldWarnServeDeprecation({ exitOnStdinClose: true }, "serve")).toBe(false);
  });

  test("source runs (bun run dev, the repo harness) stay quiet", () => {
    expect(shouldWarnServeDeprecation({ exitOnStdinClose: false }, "/repo/src/cli.ts")).toBe(false);
    expect(shouldWarnServeDeprecation({ exitOnStdinClose: false }, "/repo/dist/cli.js")).toBe(false);
  });

  test("the warning names the replacement command", () => {
    expect(SERVE_DEPRECATION_WARNING).toContain("uatu hub");
    expect(SERVE_DEPRECATION_WARNING).toContain("deprecated");
  });
});

describe("startSupervisedStartupHeartbeat", () => {
  const entry = [{ kind: "dir", absolutePath: "/repo" }] as never;

  test("spawns a stdout-inheriting helper so heartbeats survive event-loop starvation", () => {
    const spawns: { argv: string[]; options: Record<string, unknown> }[] = [];
    let killed = 0;
    const stop = startSupervisedStartupHeartbeat(entry, { isTTY: false }, 5, (argv, options) => {
      spawns.push({ argv, options });
      return { kill: () => { killed += 1; } };
    });
    expect(spawns).toHaveLength(1);
    // fd 1 passes straight through to the supervisor's pipe.
    expect(spawns[0]!.options.stdout).toBe("inherit");
    expect(spawns[0]!.argv.slice(0, 2)).toEqual(["sh", "-c"]);
    // The label and interval travel as positional parameters, never
    // interpolated into the script — a hostile root path cannot inject.
    expect(spawns[0]!.argv[2]).not.toContain("/repo");
    expect(spawns[0]!.argv[3]).toBe("/repo");
    expect(spawns[0]!.argv[4]).toBe("5");
    stop();
    stop();
    expect(killed).toBe(1);
  });

  test("the helper loop emits URL-free progress lines", async () => {
    // Run the exact production argv with a captured pipe to validate the
    // script itself; production inherits fd 1 instead.
    const helper = Bun.spawn(startupHeartbeatArgv("/my repo/docs", 0), { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    await new Promise(resolve => setTimeout(resolve, 150));
    helper.kill();
    const output = await new Response(helper.stdout).text();
    const lines = output.split("\n").filter(line => line !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).toBe("uatu: starting — indexing /my repo/docs");
      // The supervisor contract scans stdout for the first http:// URL;
      // heartbeat lines must never satisfy it.
      expect(line).not.toContain("http://");
    }
  });

  test("stays silent on a TTY — the inline indexing status owns that surface", () => {
    let spawned = 0;
    const stop = startSupervisedStartupHeartbeat(entry, { isTTY: true }, 5, () => {
      spawned += 1;
      return { kill: () => undefined };
    });
    stop();
    expect(spawned).toBe(0);
  });

  test("a failed helper spawn degrades to no heartbeat instead of failing startup", () => {
    const stop = startSupervisedStartupHeartbeat(entry, { isTTY: false }, 5, () => {
      throw new Error("spawn refused");
    });
    expect(stop).not.toThrow();
  });
});
