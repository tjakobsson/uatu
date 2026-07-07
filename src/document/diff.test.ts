import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __resetDocumentDiffCachesForTests, __setBaseCacheTtlForTests, getDocumentDiff } from "./diff";
import { safeGit, setGitMetricsSink } from "./git-base-ref";
import type { DocumentMeta, RootGroup } from "../shared/types";

const tempDirectories: string[] = [];

// Counter-capturing metrics sink so tests can assert which pipeline phases
// ran (rename scans, cache hits/misses, git exec counts).
let counters: Record<string, number>;

beforeEach(() => {
  __resetDocumentDiffCachesForTests();
  counters = {};
  setGitMetricsSink({ inc: (name, delta = 1) => { counters[name] = (counters[name] ?? 0) + delta; } });
});

afterEach(async () => {
  setGitMetricsSink(null);
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("getDocumentDiff", () => {
  test("returns text payload with line counts for a modified file", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "README.md");
    await writeFile(filePath, "# Readme\n\nadded line\n");
    const roots = rootsFor(repo, "README.md", "markdown");

    const result = await getDocumentDiff(roots, filePath);

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.patch).toContain("+added line");
    expect(result.addedLines).toBeGreaterThan(0);
    expect(result.bytes).toBeGreaterThan(0);
    expect(typeof result.baseRef).toBe("string");
  });

  test("ships old and new blob contents for a modified small file", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "README.md");
    await writeFile(filePath, "# Readme\n\nadded line\n");
    const roots = rootsFor(repo, "README.md", "markdown");

    const result = await getDocumentDiff(roots, filePath);

    if (result.kind !== "text") throw new Error("expected text payload");
    expect(result.oldContents).toBe("# Readme\n");
    expect(result.newContents).toBe("# Readme\n\nadded line\n");
  });

  test("ships oldContents='' for a file added on the current branch", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "NEW.md");
    // Brand new file — does not exist at HEAD, so the old blob is empty.
    await writeFile(filePath, "# New file\n");
    const roots = rootsFor(repo, "NEW.md", "markdown");

    const result = await getDocumentDiff(roots, filePath);

    if (result.kind !== "text") throw new Error("expected text payload");
    expect(result.oldContents).toBe("");
    expect(result.newContents).toBe("# New file\n");
  });

  test("skips blobs for files above the per-blob size cap", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "huge.txt");
    // Commit a small baseline, then balloon the worktree past 200 KB so
    // the per-blob cutoff trips and the response omits blob contents.
    await writeFile(filePath, "baseline\n");
    await safeGit(repo, ["add", "huge.txt"]);
    await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "seed huge"]);
    await writeFile(filePath, "x".repeat(250 * 1024));
    const roots = rootsFor(repo, "huge.txt", "text");

    const result = await getDocumentDiff(roots, filePath);

    if (result.kind !== "text") throw new Error("expected text payload");
    expect(result.oldContents).toBeUndefined();
    expect(result.newContents).toBeUndefined();
  });

  test("returns unchanged for a file matching the base", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "README.md");
    const roots = rootsFor(repo, "README.md", "markdown");

    const result = await getDocumentDiff(roots, filePath);

    expect(result.kind).toBe("unchanged");
  });

  test("returns binary for a changed binary file", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "logo.bin");
    // Seed a binary blob (NUL bytes), commit it, then change it.
    await writeFile(filePath, Buffer.from([0, 1, 2, 3, 4, 5]));
    await safeGit(repo, ["add", "logo.bin"]);
    await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "add binary"]);
    await writeFile(filePath, Buffer.from([9, 9, 9, 9, 9, 9]));
    const roots = rootsFor(repo, "logo.bin", "binary");

    const result = await getDocumentDiff(roots, filePath);

    expect(result.kind).toBe("binary");
  });

  test("returns unsupported-no-git outside a git workspace", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-diff-no-git-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "notes.md");
    await writeFile(filePath, "# Notes\n");
    const roots = rootsFor(tempDirectory, "notes.md", "markdown");

    const result = await getDocumentDiff(roots, filePath);

    expect(result.kind).toBe("unsupported-no-git");
  });

  test("renames produce a single diff, not add+delete pair", async () => {
    // Seed a file with enough content for git's -M rename detection
    // (default similarity threshold is 50% — a 1-line file is too small).
    const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-document-diff-"));
    tempDirectories.push(repo);
    await safeGit(repo, ["init", "--initial-branch=main"]);
    await safeGit(repo, ["config", "user.email", "uatu@example.test"]);
    await safeGit(repo, ["config", "user.name", "Uatu Test"]);
    const initialBody = ["line one", "line two", "line three", "line four", "line five"].join("\n") + "\n";
    await writeFile(path.join(repo, "README.md"), initialBody);
    await safeGit(repo, ["add", "."]);
    await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);

    await safeGit(repo, ["mv", "README.md", "GUIDE.md"]);
    const editedBody = ["line one", "line two CHANGED", "line three", "line four", "line five"].join("\n") + "\n";
    await writeFile(path.join(repo, "GUIDE.md"), editedBody);
    const roots = rootsFor(repo, "GUIDE.md", "markdown");

    const result = await getDocumentDiff(roots, path.join(repo, "GUIDE.md"));

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.patch).toMatch(/rename from README\.md/);
    expect(result.patch).toMatch(/rename to GUIDE\.md/);
    expect(result.oldPath).toBe("README.md");
    // The rename path is exactly the case that pays for the repo-wide scan.
    expect(counters["diff.rename_scans_total"]).toBe(1);
  });

  test("modified files never trigger the repo-wide rename scan", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "README.md");
    await writeFile(filePath, "# Readme\n\nedited\n");
    const roots = rootsFor(repo, "README.md", "markdown");

    const result = await getDocumentDiff(roots, filePath);

    expect(result.kind).toBe("text");
    expect(counters["diff.rename_scans_total"]).toBeUndefined();
  });

  test("untracked files surfaced via --no-index skip the rename scan", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "NEW.md");
    await writeFile(filePath, "# New file\n");
    const roots = rootsFor(repo, "NEW.md", "markdown");

    const result = await getDocumentDiff(roots, filePath);

    expect(result.kind).toBe("text");
    // Untracked files are invisible to `git diff <ref>`, so a repo-wide
    // scan can never attribute a rename to them — it must not run.
    expect(counters["diff.rename_scans_total"]).toBeUndefined();
  });

  test("warm requests reuse the cached base resolution with one validation probe", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "README.md");
    await writeFile(filePath, "# Readme\n\nedited\n");
    const roots = rootsFor(repo, "README.md", "markdown");

    await getDocumentDiff(roots, filePath);
    expect(counters["diff.base_cache_misses_total"]).toBe(1);

    const coldExecs = counters["git.execs_total"] ?? 0;
    await getDocumentDiff(roots, filePath);

    expect(counters["diff.base_cache_hits_total"]).toBe(1);
    // Warm pipeline: one HEAD validation probe + the file-scoped diff +
    // the old-blob `git show` — never the full resolution chain.
    expect((counters["git.execs_total"] ?? 0) - coldExecs).toBeLessThanOrEqual(3);
  });

  test("a HEAD move invalidates the cached base resolution", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "README.md");
    await writeFile(filePath, "# Readme\n\nedited\n");
    const roots = rootsFor(repo, "README.md", "markdown");

    await getDocumentDiff(roots, filePath);
    await safeGit(repo, ["add", "."]);
    await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "move HEAD"]);
    await writeFile(filePath, "# Readme\n\nedited again\n");
    await getDocumentDiff(roots, filePath);

    expect(counters["diff.base_cache_misses_total"]).toBe(2);
    expect(counters["diff.base_cache_hits_total"]).toBeUndefined();
  });

  test("TTL expiry re-resolves even when HEAD is unchanged", async () => {
    __setBaseCacheTtlForTests(0);
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "README.md");
    await writeFile(filePath, "# Readme\n\nedited\n");
    const roots = rootsFor(repo, "README.md", "markdown");

    await getDocumentDiff(roots, filePath);
    await getDocumentDiff(roots, filePath);

    expect(counters["diff.base_cache_misses_total"]).toBe(2);
  });

  test("skips blobs when the old blob exceeds the cap even if the worktree is small", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "huge.txt");
    // Commit a >200 KB baseline, then shrink the worktree copy: the old
    // blob overflows `git show`'s buffer cap and blobs must be omitted —
    // shipping oldContents="" would misrender the diff as a pure addition.
    await writeFile(filePath, "y".repeat(250 * 1024));
    await safeGit(repo, ["add", "huge.txt"]);
    await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "seed big baseline"]);
    await writeFile(filePath, "tiny now\n");
    const roots = rootsFor(repo, "huge.txt", "text");

    const result = await getDocumentDiff(roots, filePath);

    if (result.kind !== "text") throw new Error("expected text payload");
    expect(result.oldContents).toBeUndefined();
    expect(result.newContents).toBeUndefined();
  });

  test("rejects a documentId not in the watched roots", async () => {
    const repo = await createSeededRepo();
    const filePath = path.join(repo, "ghost.md");
    const roots: RootGroup[] = [
      { id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 },
    ];

    await expect(getDocumentDiff(roots, filePath)).rejects.toThrow(/document not found/);
  });

  test("base spans committed-since-base + worktree; last-commit shows only the worktree", async () => {
    const repo = await createBranchedRepo();
    const filePath = path.join(repo, "README.md");
    const roots = rootsFor(repo, "README.md", "markdown");

    const base = await getDocumentDiff(roots, filePath, "base");
    expect(base.kind).toBe("text");
    if (base.kind !== "text") return;
    expect(base.baseRef).toBe("main");
    // Both edits are additions relative to the merge base.
    expect(base.patch).toContain("+committed-line");
    expect(base.patch).toContain("+worktree-line");

    const last = await getDocumentDiff(roots, filePath, "last-commit");
    expect(last.kind).toBe("text");
    if (last.kind !== "text") return;
    expect(last.baseRef).toBe("HEAD");
    expect(last.patch).toContain("+worktree-line");
    // The feature-branch commit is already in HEAD, so committed-line is only
    // unchanged *context* here — never an addition. That is the whole point of
    // the last-commit target.
    expect(last.patch).not.toContain("+committed-line");
  });
});

async function createBranchedRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-document-diff-branched-"));
  tempDirectories.push(repo);
  await safeGit(repo, ["init", "--initial-branch=main"]);
  await safeGit(repo, ["config", "user.email", "uatu@example.test"]);
  await safeGit(repo, ["config", "user.name", "Uatu Test"]);
  await writeFile(path.join(repo, "README.md"), "# Readme\n");
  await safeGit(repo, ["add", "."]);
  await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
  await safeGit(repo, ["checkout", "-b", "feature"]);
  // Committed-since-base edit (visible to `base`, not to `last-commit`).
  await writeFile(path.join(repo, "README.md"), "# Readme\n\ncommitted-line\n");
  await safeGit(repo, ["add", "."]);
  await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "feature work"]);
  // Uncommitted worktree edit (visible to both targets).
  await writeFile(path.join(repo, "README.md"), "# Readme\n\ncommitted-line\n\nworktree-line\n");
  return repo;
}

async function createSeededRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-document-diff-"));
  tempDirectories.push(repo);
  await safeGit(repo, ["init", "--initial-branch=main"]);
  await safeGit(repo, ["config", "user.email", "uatu@example.test"]);
  await safeGit(repo, ["config", "user.name", "Uatu Test"]);
  await writeFile(path.join(repo, "README.md"), "# Readme\n");
  await safeGit(repo, ["add", "."]);
  await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
  return repo;
}

function rootsFor(repo: string, relativePath: string, kind: DocumentMeta["kind"]): RootGroup[] {
  const id = path.join(repo, relativePath);
  return [
    {
      id: repo,
      label: "repo",
      path: repo,
      docs: [{ id, name: path.basename(relativePath), relativePath, mtimeMs: 0, rootId: repo, kind }],
      hiddenCount: 0,
    },
  ];
}
