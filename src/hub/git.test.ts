import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cloneTargetName, gitInit, probeGitRepository, validCloneFolderName } from "./git";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("validCloneFolderName", () => {
  test("accepts one folder name and rejects paths and dot segments", () => {
    expect(validCloneFolderName("my-checkout")).toBe(true);
    expect(validCloneFolderName("repo copy")).toBe(true);
    for (const value of ["", ".", "..", "nested/repo", "nested\\repo", "/tmp/repo", "bad\0name"]) {
      expect(validCloneFolderName(value)).toBe(false);
    }
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-git-"));
  tempDirectories.push(dir);
  return dir;
}

describe("cloneTargetName", () => {
  test("derives folder names from common clone URL shapes", () => {
    expect(cloneTargetName("git@github.com:me/uatu.git")).toBe("uatu");
    expect(cloneTargetName("https://github.com/me/uatu")).toBe("uatu");
    expect(cloneTargetName("https://github.com/me/uatu.git/")).toBe("uatu");
    expect(cloneTargetName("/local/path/repo")).toBe("repo");
  });

  test("rejects URLs with no derivable name", () => {
    expect(cloneTargetName("")).toBeNull();
    expect(cloneTargetName("///")).toBeNull();
    expect(cloneTargetName("..")).toBeNull();
  });
});

describe("probeGitRepository", () => {
  test("classifies a repository, a plain folder, and reports the toplevel", async () => {
    const dir = await tempDir();
    expect((await probeGitRepository(dir)).kind).toBe("not-a-repository");

    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const probe = await probeGitRepository(dir);
    expect(probe.kind).toBe("repository");

    // A subdirectory of a worktree is inside the repository too.
    const sub = path.join(dir, "nested");
    execFileSync("mkdir", ["-p", sub]);
    expect((await probeGitRepository(sub)).kind).toBe("repository");
  });
});

describe("gitInit", () => {
  test("initializes a repository and reports failures with git's message", async () => {
    const dir = await tempDir();
    const result = await gitInit(dir);
    expect(result.ok).toBe(true);
    expect(await Bun.file(path.join(dir, ".git", "HEAD")).exists()).toBe(true);

    const missing = await gitInit(path.join(dir, "no", "such", "depth", "here"));
    expect(missing.ok).toBe(false);
  });

  test("uses an explicitly configured executable for probes and initialization", async () => {
    const dir = await tempDir();
    const executable = path.join(dir, "managed-git");
    const trace = path.join(dir, "trace");
    await writeFile(executable, [
      "#!/bin/sh",
      `printf '%s\\n' "$1" >> '${trace}'`,
      "if [ \"$1\" = rev-parse ]; then pwd; exit 0; fi",
      "if [ \"$1\" = init ]; then mkdir -p .git; exit 0; fi",
      "exit 2",
    ].join("\n"), { mode: 0o755 });

    expect((await probeGitRepository(dir, executable)).kind).toBe("repository");
    expect(await gitInit(dir, executable)).toEqual({ ok: true });
    expect((await Bun.file(trace).text()).trim().split("\n")).toEqual(["rev-parse", "init"]);
  });
});
