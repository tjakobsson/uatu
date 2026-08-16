import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverExecutable } from "./executable";

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
