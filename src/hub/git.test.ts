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
    // Visible non-ASCII names are ordinary folder names.
    expect(validCloneFolderName("docs-ö")).toBe(true);
    expect(validCloneFolderName("文書")).toBe(true);
    for (const value of ["", ".", "..", "nested/repo", "nested\\repo", "/tmp/repo", "bad\0name"]) {
      expect(validCloneFolderName(value)).toBe(false);
    }
  });

  test("rejects control and invisible Unicode format characters", () => {
    // The route trims before calling this, and trim() leaves every one of
    // these in place: a zero-width-only name would clone into a directory
    // that renders blank, and an embedded bidi control would make the
    // checkout display a name other than the path it occupies. The whole Cc
    // category is rejected, C1 (U+0080-U+009F) included — those are as
    // invisible as C0 and would name a checkout nobody can read back.
    for (const value of [
      "\u200b",
      "\u200b\u200c\u200d",
      "\ufeff",
      "repo\u202egpj.txt",
      "repo\u2066hidden\u2069",
      "\u00ad",
      "bad\u0007name",
      "bad\u007fname",
      "repo\u0085name",
      "\u009f",
      "\u0080\u009f",
    ]) {
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

  test("caps repository probe output", async () => {
    const dir = await tempDir();
    const executable = path.join(dir, "managed-git");
    await writeFile(executable, "#!/bin/sh\ndd if=/dev/zero bs=1024 count=1 2>/dev/null\n", { mode: 0o755 });

    const started = Date.now();
    const probe = await probeGitRepository(dir, executable, { timeoutMs: 1_000, outputLimit: 128 });
    expect(probe).toEqual({ kind: "indeterminate", detail: "git repository probe exceeded the output limit" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("times out without waiting for a descendant holding the output pipes", async () => {
    const dir = await tempDir();
    const executable = path.join(dir, "managed-git");
    await writeFile(executable, "#!/bin/sh\n(sleep 30) &\nsleep 30\n", { mode: 0o755 });

    const started = Date.now();
    const probe = await probeGitRepository(dir, executable, { timeoutMs: 20 });
    expect(probe).toEqual({ kind: "indeterminate", detail: "git repository probe timed out" });
    expect(Date.now() - started).toBeLessThan(3_000);
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
