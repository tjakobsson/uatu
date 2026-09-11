import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PORT,
  isSourceRun,
  normalizeBasePath,
  parseCommand,
  serveRemovedText,
  usageText,
  type ParseContext,
} from "./parse";

// The two ways `serve` is still reached: the repository's own source runs,
// and a compiled binary spawned by the hub (marked by --exit-on-stdin-close).
const SOURCE: ParseContext = { sourceRun: true };
const COMPILED: ParseContext = { sourceRun: false };

// Grammar tests drive the session child command as a source run.
function serve(...args: string[]) {
  const parsed = parseCommand(["serve", ...args], SOURCE);
  if (parsed.kind !== "watch") throw new Error(`expected the session child, got ${parsed.kind}`);
  return parsed.options;
}

describe("user-shaped serve and watch are removed", () => {
  test("serve, watch, and bare invocations from a compiled binary refuse", () => {
    const userShaped = [
      ["serve"],
      ["serve", "docs"],
      ["serve", "docs", "--no-open", "--port", "5000"],
      ["watch"],
      ["watch", "docs"],
      [],
      ["docs"],
      ["--no-open", "docs"],
    ];
    for (const argv of userShaped) {
      expect(parseCommand(argv, COMPILED)).toEqual({ kind: "serve-removed" });
    }
  });

  test("a stale habit gets the bootstrap steps, not a flag error", () => {
    expect(parseCommand(["serve", "--bogus-flag"], COMPILED)).toEqual({ kind: "serve-removed" });
    expect(parseCommand(["serve", "--port"], COMPILED)).toEqual({ kind: "serve-removed" });
    expect(parseCommand(["serve", "--mode=review"], COMPILED)).toEqual({ kind: "serve-removed" });
  });

  test("the watch alias and the bare default are gone for source runs too", () => {
    expect(parseCommand(["watch", "docs"], SOURCE)).toEqual({ kind: "serve-removed" });
    expect(parseCommand(["docs"], SOURCE)).toEqual({ kind: "serve-removed" });
    expect(parseCommand([], SOURCE)).toEqual({ kind: "serve-removed" });
  });

  test("the refusal walks through the hub bootstrap", () => {
    const text = serveRemovedText("/home/me/.config/uatu/hub.json", 4700);
    expect(text).toContain("'uatu serve' and 'uatu watch' were removed");
    expect(text).toContain("printf '%s' '<password>' | uatu hub hash-password");
    expect(text).toContain("Put the printed hash in /home/me/.config/uatu/hub.json");
    expect(text).toContain('{ "users": [{ "name": "<your-name>", "passwordHash": "<hash from step 1>" }] }');
    expect(text).toContain("\n  3. uatu hub\n");
    expect(text).toContain("Open http://127.0.0.1:4700/, sign in, and choose Add Folder");
    expect(text).toContain("docs/SELF-HOSTING.md");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("help, version, and hub still parse from a compiled binary", () => {
    expect(parseCommand(["--help"], COMPILED).kind).toBe("help");
    expect(parseCommand(["-h"], COMPILED).kind).toBe("help");
    expect(parseCommand(["--version"], COMPILED).kind).toBe("version");
    expect(parseCommand(["-V"], COMPILED).kind).toBe("version");
    expect(parseCommand(["hub"], COMPILED).kind).toBe("hub");
  });
});

describe("the hub's session child", () => {
  test("the hub's spawn argv parses in a compiled binary", () => {
    // Mirrors LocalProcessBackend.start in src/hub/backend.ts; the hub
    // integration tests spawn that argv for real.
    const parsed = parseCommand(
      [
        "serve",
        "/srv/work/myproject",
        "--no-open",
        "--exit-on-stdin-close",
        "--port",
        "0",
        "--base-path",
        "/s/myproject/",
        "--manifest-scope",
        "origin",
      ],
      COMPILED,
    );
    expect(parsed.kind).toBe("watch");
    if (parsed.kind !== "watch") return;
    expect(parsed.options).toMatchObject({
      rootPaths: ["/srv/work/myproject"],
      openBrowser: false,
      exitOnStdinClose: true,
      port: 0,
      portExplicit: true,
      basePath: "/s/myproject/",
      manifestScope: "origin",
    });
  });
});

describe("the source-run harness", () => {
  test("the base-path e2e argv parses unchanged", () => {
    // tests/e2e/base-path.e2e.ts: `bun run src/cli.ts serve …`, no
    // --exit-on-stdin-close.
    const argv = ["serve", "/tmp/ws", "--no-open", "--no-watchdog", "--port", "0", "--base-path", "/s/e2e/"];
    const parsed = parseCommand(argv, SOURCE);
    expect(parsed.kind).toBe("watch");
    if (parsed.kind !== "watch") return;
    expect(parsed.options).toMatchObject({
      rootPaths: ["/tmp/ws"],
      openBrowser: false,
      watchdogEnabled: false,
      exitOnStdinClose: false,
      port: 0,
      basePath: "/s/e2e/",
    });
    // The same argv typed at a compiled binary is a user.
    expect(parseCommand(argv, COMPILED)).toEqual({ kind: "serve-removed" });
  });

  test("the stdin-close test argv parses unchanged", () => {
    const options = serve("/repo/testdata/watch-docs", "--no-open", "--no-watchdog", "--port", "0");
    expect(options.rootPaths).toEqual(["/repo/testdata/watch-docs"]);
    expect(options.exitOnStdinClose).toBe(false);
  });

  test("isSourceRun tells a script path from a compiled binary's entry", () => {
    expect(isSourceRun("/repo/src/cli.ts")).toBe(true);
    expect(isSourceRun("/repo/dist/cli.js")).toBe(true);
    // A compiled binary's Bun.argv[1] is its extensionless virtual entry.
    expect(isSourceRun("/$bunfs/root/uatu")).toBe(false);
    expect(isSourceRun("serve")).toBe(false);
    expect(isSourceRun(null)).toBe(false);
  });
});

describe("session child grammar", () => {
  test("defaults watch roots, follow, and open behavior", () => {
    const options = serve();
    expect(options.rootPaths).toEqual(["."]);
    expect(options.follow).toBe(true);
    expect(options.openBrowser).toBe(true);
    expect(options.port).toBe(DEFAULT_PORT);
    expect(options.portExplicit).toBe(false);
    expect(options.force).toBe(false);
  });

  test("accepts positional roots and startup flags", () => {
    const options = serve("docs", "notes", "--force", "--no-open", "--no-follow", "--port", "5000");
    expect(options.rootPaths).toEqual(["docs", "notes"]);
    expect(options.openBrowser).toBe(false);
    expect(options.follow).toBe(false);
    expect(options.port).toBe(5000);
    expect(options.portExplicit).toBe(true);
    expect(options.force).toBe(true);
  });

  test("accepts --port 0 for an ephemeral kernel-assigned port", () => {
    const options = serve("--port", "0");
    expect(options.port).toBe(0);
    expect(options.portExplicit).toBe(true);
  });

  test("rejects negative or out-of-range ports", () => {
    expect(() => serve("--port", "-1")).toThrow();
    expect(() => serve("--port", "70000")).toThrow();
    expect(() => serve("--port", "abc")).toThrow();
  });

  test("respectGitignore defaults to true and is disabled by --no-gitignore", () => {
    expect(serve().respectGitignore).toBe(true);
    expect(serve("--no-gitignore").respectGitignore).toBe(false);
  });

  test("--mode is rejected as an unknown flag", () => {
    expect(() => serve("--mode=review")).toThrow(/unknown flag: --mode/);
    expect(() => serve("--mode", "review")).toThrow(/unknown flag: --mode/);
  });

  test("debug defaults to false; watchdog defaults to enabled", () => {
    const options = serve();
    expect(options.debug).toBe(false);
    expect(options.watchdogEnabled).toBe(true);
    expect(options.watchdogTimeoutMs).toBeUndefined();
  });

  test("--debug enables verbose metrics history", () => {
    expect(serve("--debug").debug).toBe(true);
  });

  test("--no-watchdog suppresses the watchdog subprocess", () => {
    expect(serve("--no-watchdog").watchdogEnabled).toBe(false);
  });

  test("--watchdog-timeout=<ms> parses as a positive integer", () => {
    expect(serve("--watchdog-timeout=60000").watchdogTimeoutMs).toBe(60_000);
  });

  test("--watchdog-timeout (space form) requires a positive value", () => {
    expect(serve("--watchdog-timeout", "5000").watchdogTimeoutMs).toBe(5_000);
    expect(() => serve("--watchdog-timeout")).toThrow(/missing value for --watchdog-timeout/);
    expect(() => serve("--watchdog-timeout=0")).toThrow(/invalid --watchdog-timeout/);
    expect(() => serve("--watchdog-timeout=-50")).toThrow(/invalid --watchdog-timeout/);
  });

  test("exit-on-stdin-close defaults to off and the flag enables it", () => {
    expect(serve().exitOnStdinClose).toBe(false);
    expect(serve("--exit-on-stdin-close").exitOnStdinClose).toBe(true);
  });

  test("UATU_DEBUG env var enables debug mode when --debug is absent", () => {
    const previous = process.env.UATU_DEBUG;
    process.env.UATU_DEBUG = "1";
    try {
      expect(serve().debug).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.UATU_DEBUG;
      } else {
        process.env.UATU_DEBUG = previous;
      }
    }
  });

  test("-h / --help inside the child command short-circuit to help", () => {
    expect(parseCommand(["serve", "--help"], SOURCE).kind).toBe("help");
    expect(parseCommand(["serve", "-h"], SOURCE).kind).toBe("help");
  });

  test("basePath defaults to /", () => {
    expect(serve().basePath).toBe("/");
  });

  test("--base-path accepts both value forms and normalizes the trailing slash", () => {
    expect(serve("--base-path", "/s/uatu").basePath).toBe("/s/uatu/");
    expect(serve("--base-path=/s/uatu/").basePath).toBe("/s/uatu/");
  });

  test("manifestScope defaults to base-path and accepts origin", () => {
    expect(serve().manifestScope).toBe("base-path");
    expect(serve("--manifest-scope", "origin").manifestScope).toBe("origin");
    expect(serve("--manifest-scope=origin").manifestScope).toBe("origin");
  });

  test("--manifest-scope rejects unknown modes", () => {
    expect(() => serve("--manifest-scope", "wide")).toThrow(/invalid --manifest-scope/);
    expect(() => serve("--manifest-scope")).toThrow(/missing value/);
  });

  test("--base-path rejects invalid prefixes", () => {
    expect(() => serve("--base-path", "relative/path")).toThrow(/must start with '\/'/);
    expect(() => serve("--base-path", "/has space/")).toThrow(/whitespace or reserved/);
    expect(() => serve("--base-path", "/a/../b/")).toThrow(/dot segments/);
    expect(() => serve("--base-path", "/a//b/")).toThrow(/empty path segment/);
    expect(() => serve("--base-path", "/x?y=1")).toThrow(/whitespace or reserved/);
    expect(() => serve("--base-path")).toThrow(/missing value/);
  });

  test("normalizeBasePath keeps / as the identity prefix", () => {
    expect(normalizeBasePath("/")).toBe("/");
    expect(normalizeBasePath("/s/alpha")).toBe("/s/alpha/");
  });

  test("a folder named hub is servable by the child command", () => {
    expect(serve("hub").rootPaths).toEqual(["hub"]);
  });
});

describe("usage", () => {
  test("usage advertises only the hub", () => {
    const text = usageText();
    expect(text).toContain("uatu hub [--config <PATH>] [--port <PORT>] [--exit-on-stdin-close]");
    expect(text).toContain("uatu hub hash-password");
    expect(text).toContain("docs/SELF-HOSTING.md");
    expect(text).not.toMatch(/\bserve\b/);
    expect(text).not.toMatch(/\bwatch\b/);
  });

  test("usage lists only flags a user can reach", () => {
    const text = usageText();
    for (const childOnly of ["--mode", "--force", "--no-open", "--no-follow", "--no-gitignore", "--base-path", "--manifest-scope", "--debug", "--no-watchdog"]) {
      expect(text).not.toContain(childOnly);
    }
  });

  test("usage documents --exit-on-stdin-close for supervising wrappers", () => {
    const text = usageText();
    expect(text).toContain("--exit-on-stdin-close");
    expect(text).toContain("supervising wrappers");
  });
});

describe("hub", () => {
  test("hub subcommand parses with and without --config", () => {
    const defaults = { configPath: undefined, port: undefined, exitOnStdinClose: false };
    expect(parseCommand(["hub"])).toEqual({ kind: "hub", options: defaults });
    expect(parseCommand(["hub", "--config", "/etc/uatu/hub.json"])).toEqual({
      kind: "hub",
      options: { ...defaults, configPath: "/etc/uatu/hub.json" },
    });
    expect(parseCommand(["hub", "--config=/etc/hub.json"])).toEqual({
      kind: "hub",
      options: { ...defaults, configPath: "/etc/hub.json" },
    });
  });

  test("hub parses port and stdin-close flags; --local is gone", () => {
    expect(parseCommand(["hub", "--port", "0", "--exit-on-stdin-close"])).toEqual({
      kind: "hub",
      options: { configPath: undefined, port: 0, exitOnStdinClose: true },
    });
    expect(parseCommand(["hub", "-p", "4700"])).toEqual({
      kind: "hub",
      options: { configPath: undefined, port: 4700, exitOnStdinClose: false },
    });
    expect(() => parseCommand(["hub", "--port", "not-a-port"])).toThrow(/invalid port/);
    expect(() => parseCommand(["hub", "--port"])).toThrow(/missing value/);
    // The trusted-loopback mode was removed with the single trust model.
    expect(() => parseCommand(["hub", "--local"])).toThrow(/unknown hub argument/);
  });

  test("hub hash-password parses and rejects extra arguments", () => {
    expect(parseCommand(["hub", "hash-password"])).toEqual({ kind: "hub-hash-password" });
    expect(() => parseCommand(["hub", "hash-password", "hunter2"])).toThrow(/read from stdin/);
  });

  test("hub rejects unknown arguments and missing --config values", () => {
    expect(() => parseCommand(["hub", "--nope"])).toThrow(/unknown hub argument/);
    expect(() => parseCommand(["hub", "--config"])).toThrow(/missing value/);
    expect(parseCommand(["hub", "--help"]).kind).toBe("help");
  });
});
