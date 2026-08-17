import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverExecutable, discoverExecutableCandidates, withinBudget } from "./executable";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("executable discovery", () => {
  test("finds the first executable on PATH without invoking a shell", async () => {
    const first = await mkdtemp(path.join(os.tmpdir(), "uatu-opencode-first-"));
    const second = await mkdtemp(path.join(os.tmpdir(), "uatu-opencode-second-"));
    temporaryDirectories.push(first, second);
    const executable = path.join(second, "opencode");
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });

    expect(await discoverExecutable("opencode", { PATH: `${first}${path.delimiter}${second}` }, "darwin")).toBe(executable);
  });

  test("reports shadowed candidates in search order without changing the selection", async () => {
    const first = await mkdtemp(path.join(os.tmpdir(), "uatu-opencode-shadow-a-"));
    const second = await mkdtemp(path.join(os.tmpdir(), "uatu-opencode-shadow-b-"));
    temporaryDirectories.push(first, second);
    const shim = path.join(first, "opencode");
    const real = path.join(second, "opencode");
    await writeFile(shim, "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(real, "#!/bin/sh\n", { mode: 0o755 });

    const env = { PATH: `${first}${path.delimiter}${second}` };
    // The shadowing one still wins — reporting must not change behavior.
    expect(await discoverExecutableCandidates("opencode", env, "darwin")).toEqual([shim, real]);
    expect(await discoverExecutable("opencode", env, "darwin")).toBe(shim);
  });

  test("returns no candidates when nothing matches", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "uatu-opencode-empty-"));
    temporaryDirectories.push(empty);
    expect(await discoverExecutableCandidates("opencode", { PATH: empty }, "darwin")).toEqual([]);
    expect(await discoverExecutableCandidates("opencode", {}, "darwin")).toEqual([]);
  });

  test("a check that cannot answer within the budget reports absent, not hangs", async () => {
    // Models a stat against a hung network mount: the promise never settles,
    // and the scan must not let it block startup.
    const hung = new Promise<boolean>(() => {});
    expect(await withinBudget(hung, 5)).toBe(false);
    expect(await withinBudget(Promise.resolve(true), 1_000)).toBe(true);
    expect(await withinBudget(Promise.reject(new Error("io error")), 1_000)).toBe(false);
  });

  test("ignores non-executable files and reports a missing PATH", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-opencode-mode-"));
    temporaryDirectories.push(directory);
    const candidate = path.join(directory, "opencode");
    await writeFile(candidate, "not executable");
    await chmod(candidate, 0o644);

    expect(await discoverExecutable("opencode", { PATH: directory }, "darwin")).toBeNull();
    expect(await discoverExecutable("opencode", {}, "darwin")).toBeNull();
  });
});
