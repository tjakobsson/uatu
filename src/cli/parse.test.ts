import { describe, expect, test } from "bun:test";

import { DEFAULT_PORT, parseCommand, usageText } from "./parse";

describe("parseCommand", () => {
  test("defaults watch roots, follow, and open behavior", () => {
    const parsed = parseCommand(["serve"]);
    expect(parsed.kind).toBe("watch");

    if (parsed.kind !== "watch") {
      return;
    }

    expect(parsed.options.rootPaths).toEqual(["."]);
    expect(parsed.options.follow).toBe(true);
    expect(parsed.options.openBrowser).toBe(true);
    expect(parsed.options.port).toBe(DEFAULT_PORT);
    expect(parsed.options.portExplicit).toBe(false);
    expect(parsed.options.force).toBe(false);
  });

  test("accepts positional roots and startup flags", () => {
    const parsed = parseCommand(["serve", "docs", "notes", "--force", "--no-open", "--no-follow", "--port", "5000"]);
    expect(parsed.kind).toBe("watch");

    if (parsed.kind !== "watch") {
      return;
    }

    expect(parsed.options.rootPaths).toEqual(["docs", "notes"]);
    expect(parsed.options.openBrowser).toBe(false);
    expect(parsed.options.follow).toBe(false);
    expect(parsed.options.port).toBe(5000);
    expect(parsed.options.portExplicit).toBe(true);
    expect(parsed.options.force).toBe(true);
  });

  test("accepts --port 0 for an ephemeral kernel-assigned port", () => {
    const parsed = parseCommand(["serve", "--port", "0"]);
    expect(parsed.kind).toBe("watch");
    if (parsed.kind !== "watch") return;
    expect(parsed.options.port).toBe(0);
    expect(parsed.options.portExplicit).toBe(true);
  });

  test("rejects negative or out-of-range ports", () => {
    expect(() => parseCommand(["serve", "--port", "-1"])).toThrow();
    expect(() => parseCommand(["serve", "--port", "70000"])).toThrow();
    expect(() => parseCommand(["serve", "--port", "abc"])).toThrow();
  });

  test("respectGitignore defaults to true and is disabled by --no-gitignore", () => {
    const defaulted = parseCommand(["serve"]);
    if (defaulted.kind !== "watch") throw new Error("expected watch");
    expect(defaulted.options.respectGitignore).toBe(true);

    const opted = parseCommand(["serve", "--no-gitignore"]);
    if (opted.kind !== "watch") throw new Error("expected watch");
    expect(opted.options.respectGitignore).toBe(false);
  });

  test("usage documents the --force flag", () => {
    expect(usageText()).toContain("--force");
  });

  test("--mode is rejected as an unknown flag after the deprecation window", () => {
    expect(() => parseCommand(["serve", "--mode=review"])).toThrow(/unknown flag: --mode/);
    expect(() => parseCommand(["serve", "--mode", "review"])).toThrow(/unknown flag: --mode/);
  });

  test("usage lists only flags the parser honors", () => {
    expect(usageText()).not.toContain("--mode");
  });

  test("debug defaults to false; watchdog defaults to enabled", () => {
    const parsed = parseCommand(["serve"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.debug).toBe(false);
    expect(parsed.options.watchdogEnabled).toBe(true);
    expect(parsed.options.watchdogTimeoutMs).toBeUndefined();
  });

  test("--debug enables verbose metrics history", () => {
    const parsed = parseCommand(["serve", "--debug"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.debug).toBe(true);
  });

  test("--no-watchdog suppresses the watchdog subprocess", () => {
    const parsed = parseCommand(["serve", "--no-watchdog"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.watchdogEnabled).toBe(false);
  });

  test("--watchdog-timeout=<ms> parses as a positive integer", () => {
    const parsed = parseCommand(["serve", "--watchdog-timeout=60000"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.watchdogTimeoutMs).toBe(60_000);
  });

  test("--watchdog-timeout (space form) requires a positive value", () => {
    const parsed = parseCommand(["serve", "--watchdog-timeout", "5000"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.watchdogTimeoutMs).toBe(5_000);
    expect(() => parseCommand(["serve", "--watchdog-timeout"])).toThrow(
      /missing value for --watchdog-timeout/,
    );
    expect(() => parseCommand(["serve", "--watchdog-timeout=0"])).toThrow(
      /invalid --watchdog-timeout/,
    );
    expect(() => parseCommand(["serve", "--watchdog-timeout=-50"])).toThrow(
      /invalid --watchdog-timeout/,
    );
  });

  test("UATU_DEBUG env var enables debug mode when --debug is absent", () => {
    const previous = process.env.UATU_DEBUG;
    process.env.UATU_DEBUG = "1";
    try {
      const parsed = parseCommand(["serve"]);
      if (parsed.kind !== "watch") throw new Error("expected watch");
      expect(parsed.options.debug).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.UATU_DEBUG;
      } else {
        process.env.UATU_DEBUG = previous;
      }
    }
  });

  test("usage documents the diagnostic flags", () => {
    const text = usageText();
    expect(text).toContain("--debug");
    expect(text).toContain("--no-watchdog");
    expect(text).toContain("--watchdog-timeout");
  });

  test("bare invocation with no arguments defaults to serve on cwd", () => {
    const parsed = parseCommand([]);
    expect(parsed.kind).toBe("watch");
    if (parsed.kind !== "watch") return;
    expect(parsed.options.rootPaths).toEqual(["."]);
  });

  test("bare invocation with a path defaults to serve", () => {
    const parsed = parseCommand(["docs"]);
    expect(parsed.kind).toBe("watch");
    if (parsed.kind !== "watch") return;
    expect(parsed.options.rootPaths).toEqual(["docs"]);
  });

  test("bare invocation with a leading flag defaults to serve", () => {
    const parsed = parseCommand(["--no-open", "docs"]);
    expect(parsed.kind).toBe("watch");
    if (parsed.kind !== "watch") return;
    expect(parsed.options.openBrowser).toBe(false);
    expect(parsed.options.rootPaths).toEqual(["docs"]);
  });

  test("-h / --help still short-circuit to help", () => {
    expect(parseCommand(["-h"]).kind).toBe("help");
    expect(parseCommand(["--help"]).kind).toBe("help");
  });

  test("the watch alias behaves as serve and warns once via the warn sink", () => {
    const warnings: string[] = [];
    const parsed = parseCommand(["watch", "docs", "--no-open"], message => warnings.push(message));
    expect(parsed.kind).toBe("watch");
    if (parsed.kind !== "watch") return;
    expect(parsed.options.rootPaths).toEqual(["docs"]);
    expect(parsed.options.openBrowser).toBe(false);
    expect(warnings).toEqual(["warning: 'uatu watch' is deprecated; use 'uatu serve'\n"]);
  });

  test("the serve command does not emit the deprecation warning", () => {
    const warnings: string[] = [];
    parseCommand(["serve", "docs"], message => warnings.push(message));
    parseCommand(["docs"], message => warnings.push(message));
    expect(warnings).toEqual([]);
  });

  test("usage presents serve as the default command", () => {
    const text = usageText();
    expect(text).toContain("uatu [serve] [PATH...]");
    expect(text).toContain("deprecated alias");
  });
});
