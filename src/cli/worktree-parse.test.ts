import { describe, expect, test } from "bun:test";

import { parseCommand } from "./parse";
import { parseWorktreeCommand, worktreeUsageText } from "./worktree-parse";

describe("uatu worktree argument parsing", () => {
  test("routes through the CLI's own command parser", () => {
    expect(parseCommand(["worktree", "list"])).toEqual({ kind: "worktree", command: { kind: "list", json: false } });
    // The surface is documented where users look for it.
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
  });

  test("list takes only --json", () => {
    expect(parseWorktreeCommand(["list", "--json"])).toEqual({ kind: "list", json: true });
    expect(() => parseWorktreeCommand(["list", "atlas"])).toThrow(/takes no arguments/);
    expect(() => parseWorktreeCommand(["list", "--start"])).toThrow(/does not apply/);
    expect(() => parseWorktreeCommand(["list", "--branch", "main"])).toThrow(/no branch options/);
  });

  test("create accepts exactly one of the three approved modes", () => {
    expect(parseWorktreeCommand(["create", "--new-branch", "feature/login", "--from", "main"])).toEqual({
      kind: "create", json: false, start: false, mode: "new-branch", branch: "feature/login", baseRef: "main",
    });
    expect(parseWorktreeCommand(["create", "--branch", "release", "--start"])).toEqual({
      kind: "create", json: false, start: true, mode: "existing-local", base: { kind: "local", ref: "release" },
    });
    expect(parseWorktreeCommand(["create", "--remote-branch", "origin/release", "--json"])).toEqual({
      kind: "create", json: true, start: false, mode: "remote-tracking", base: { kind: "remote", ref: "origin/release" },
    });
    expect(() => parseWorktreeCommand(["create"])).toThrow(/needs one of/);
    expect(() => parseWorktreeCommand(["create", "--branch", "a", "--remote-branch", "origin/b"])).toThrow(/takes one of/);
    expect(() => parseWorktreeCommand(["create", "--new-branch", "feature"])).toThrow(/needs --from/);
    expect(() => parseWorktreeCommand(["create", "--branch", "a", "--from", "main"])).toThrow(/applies only to --new-branch/);
    expect(() => parseWorktreeCommand(["create", "atlas"])).toThrow(/no positional arguments/);
  });

  test("an option-shaped value is refused before anything is requested", () => {
    // Without this, `--new-branch --from main` would ask the Hub to create a
    // branch called "--from", and an option-shaped name is exactly what must
    // never travel toward a Git argument list.
    expect(() => parseWorktreeCommand(["create", "--new-branch", "--from", "main"]))
      .toThrow(/expects a value, not another option/);
    expect(() => parseWorktreeCommand(["create", "--branch"])).toThrow(/missing value/);
    expect(() => parseWorktreeCommand(["open", "--nope", "x"])).toThrow(/unknown option/);
    expect(() => parseWorktreeCommand(["nope"])).toThrow(/unknown worktree command/);
  });

  test("invalid branch grammar never leaves the CLI", () => {
    for (const branch of ["-f", "feature..login", "feature/", ".hidden", "with space", "refs/heads/x.lock", "@"]) {
      expect(() => parseWorktreeCommand(["create", "--new-branch", branch, "--from", "main"])).toThrow();
    }
    expect(() => parseWorktreeCommand(["create", "--remote-branch", "origin"])).toThrow(/remote-qualified/);
    expect(() => parseWorktreeCommand(["create", "--remote-branch", "origin/"])).toThrow(/remote-qualified/);
    expect(() => parseWorktreeCommand(["create", "--new-branch", "ok", "--from", "bad..ref"])).toThrow(/valid branch name/);
  });

  test("a slashed --from stays unresolved for the Hub to qualify", () => {
    // "feature/login" is a perfectly good local branch and "origin/main" a
    // remote-qualified ref; only the repository's listing can tell them
    // apart, so the CLI commits to neither.
    const parsed = parseWorktreeCommand(["create", "--new-branch", "x", "--from", "origin/main"]);
    expect(parsed).toMatchObject({ baseRef: "origin/main" });
    expect(parsed).not.toHaveProperty("base");
  });

  test("open names exactly one worktree and starts only when asked", () => {
    expect(parseWorktreeCommand(["open", "feature/login"])).toEqual({
      kind: "open", json: false, start: false, reference: "feature/login",
    });
    expect(parseWorktreeCommand(["open", "feature/login", "--start", "--json"])).toEqual({
      kind: "open", json: true, start: true, reference: "feature/login",
    });
    expect(() => parseWorktreeCommand(["open"])).toThrow(/needs the branch or workspace id/);
    expect(() => parseWorktreeCommand(["open", "a", "b"])).toThrow(/exactly one/);
    expect(() => parseWorktreeCommand(["open", "a", "--stop"])).toThrow(/does not apply/);
  });

  test("remove requires the explicit confirmation and offers no force", () => {
    expect(() => parseWorktreeCommand(["remove", "feature/login"])).toThrow(/needs --confirm-delete; nothing was removed/);
    expect(parseWorktreeCommand(["remove", "feature/login", "--confirm-delete"])).toEqual({
      kind: "remove", json: false, stop: false, reference: "feature/login",
    });
    expect(parseWorktreeCommand(["remove", "feature/login", "--confirm-delete", "--stop"])).toEqual({
      kind: "remove", json: false, stop: true, reference: "feature/login",
    });
    // There is no force, and no branch deletion, anywhere in this surface.
    for (const flag of ["--force", "-f", "--delete-branch", "--yes"]) {
      expect(() => parseWorktreeCommand(["remove", "x", "--confirm-delete", flag])).toThrow(/unknown option/);
    }
    expect(worktreeUsageText()).not.toMatch(/--force|delete the branch|branch will be deleted/i);
  });

  test("help is available everywhere and documents the exit codes", () => {
    expect(parseWorktreeCommand([])).toEqual({ kind: "help" });
    expect(parseWorktreeCommand(["remove", "--help"])).toEqual({ kind: "help" });
    const usage = worktreeUsageText();
    expect(usage).toContain("Exit codes: 0 success, 1 the operation was refused, 2 invalid usage,");
    expect(usage).toContain("no usable Hub context");
    // No credential, host or path is ever documented as an input.
    expect(usage).not.toMatch(/--token|--hub |password|secret/i);
  });
});
