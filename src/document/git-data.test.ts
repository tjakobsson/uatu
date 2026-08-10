import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectConfigWarnings, collectRepositorySnapshots, parseDiffPath, safeGit } from "./git-data";
import type { WatchEntry } from "../server/roots";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("repository snapshots", () => {
  test("reports an explicit non-git state for roots outside a repository", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-git-data-non-git-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: tempDirectory }],
      [{ id: tempDirectory, label: "root", path: tempDirectory, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.metadata.status).toBe("non-git");
    expect(snapshots[0]?.status).toBe("non-git");
  });

  test("groups multiple watched roots by detected repository", async () => {
    const repo = await createRepo();
    await mkdir(path.join(repo, "docs"), { recursive: true });
    await mkdir(path.join(repo, "packages", "app"), { recursive: true });

    const entries: WatchEntry[] = [
      { kind: "dir", absolutePath: path.join(repo, "docs") },
      { kind: "dir", absolutePath: path.join(repo, "packages", "app") },
    ];
    const snapshots = await collectRepositorySnapshots(entries, []);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.rootPath).toBe(await realpath(repo));
    expect(snapshots[0]?.watchedRootIds.sort()).toEqual(entries.map(entry => entry.absolutePath).sort());
  });

  test("uses dirty-worktree-only fallback when no base exists", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "README.md"), "# Changed\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots[0]?.base.mode).toBe("dirty-worktree-only");
    expect(snapshots[0]?.changedFiles.map(file => file.path)).toContain("README.md");
  });

  test("reports untracked files with the distinct '?' status", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "scratch.md"), "# Scratch\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    const entry = snapshots[0]?.changedFiles.find(file => file.path === "scratch.md");
    expect(entry).toBeDefined();
    expect(entry?.status.startsWith("?")).toBe(true);
  });

  test("reports staged-but-uncommitted files with the 'A' status, not '?'", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "feature.md"), "# Feature\n");
    await safeGit(repo, ["add", "feature.md"]);

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    const entry = snapshots[0]?.changedFiles.find(file => file.path === "feature.md");
    expect(entry).toBeDefined();
    expect(entry?.status.startsWith("A")).toBe(true);
    expect(entry?.status.startsWith("?")).toBe(false);
  });

  test("modified tracked files are reported with the 'M' status", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "README.md"), "# Readme (modified)\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    const entry = snapshots[0]?.changedFiles.find(file => file.path === "README.md");
    expect(entry).toBeDefined();
    expect(entry?.status.startsWith("M")).toBe(true);
  });

  test("deleted tracked files are reported with the 'D' status", async () => {
    const repo = await createRepo();
    await safeGit(repo, ["rm", "README.md"]);

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    const entry = snapshots[0]?.changedFiles.find(file => file.path === "README.md");
    expect(entry).toBeDefined();
    expect(entry?.status.startsWith("D")).toBe(true);
  });

  test("renamed tracked files are reported with the 'R' status and an oldPath", async () => {
    const repo = await createRepo();
    await safeGit(repo, ["mv", "README.md", "GUIDE.md"]);

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    const entry = snapshots[0]?.changedFiles.find(file => file.path === "GUIDE.md");
    expect(entry).toBeDefined();
    expect(entry?.status.startsWith("R")).toBe(true);
    expect(entry?.oldPath).toBe("README.md");
  });

  test("exposes gitignored files visible in the tree via gitIgnoredFiles, not changedFiles", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, ".gitignore"), "local-only.json\n");
    await safeGit(repo, ["add", ".gitignore"]);
    await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "add ignore"]);
    await writeFile(path.join(repo, "local-only.json"), "{}\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [
        {
          id: repo,
          label: "repo",
          path: repo,
          // The probe filters by the tree's known paths; include this leaf so
          // the intersection has something to match against.
          docs: [
            {
              id: `${repo}/local-only.json`,
              name: "local-only.json",
              relativePath: "local-only.json",
              mtimeMs: 0,
              rootId: repo,
              kind: "text",
            },
          ],
          hiddenCount: 0,
        },
      ],
    );

    expect(snapshots[0]?.gitIgnoredFiles).toContain("local-only.json");
    expect(snapshots[0]?.changedFiles.map(file => file.path)).not.toContain("local-only.json");
  });

  test("gitIgnoredFiles does not include files outside the tree's known paths", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, ".gitignore"), "local-only.json\n");
    await safeGit(repo, ["add", ".gitignore"]);
    await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "add ignore"]);
    await writeFile(path.join(repo, "local-only.json"), "{}\n");

    // RootGroup with no docs: nothing in the tree, so nothing to intersect.
    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots[0]?.gitIgnoredFiles).toEqual([]);
  });

  test("collects full commit messages without per-commit lookups", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "feature.md"), "# Feature\n");
    await safeGit(repo, ["add", "feature.md"]);
    await safeGit(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "add feature",
      "-m",
      "Body line one.\n\nBody line two.",
    ]);

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots[0]?.commitLog[0]?.subject).toBe("add feature");
    expect(snapshots[0]?.commitLog[0]?.message).toContain("Body line two.");
  });
});

describe("config warnings and path parsing", () => {
  test("invalid .uatu.json produces a parse warning on the snapshot", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, ".uatu.json"), "{ nope");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots[0]?.configWarnings[0]).toContain("Invalid .uatu.json");
  });

  test("a missing .uatu.json produces no warnings", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-git-data-config-"));
    tempDirectories.push(repo);

    expect(await collectConfigWarnings(repo)).toEqual([]);
  });

  test("an empty .uatu.json produces a parse warning", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-git-data-config-"));
    tempDirectories.push(repo);
    await writeFile(path.join(repo, ".uatu.json"), "");

    const warnings = await collectConfigWarnings(repo);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Invalid .uatu.json");
  });

  test("ignore shape warnings reach the snapshot's config warnings", async () => {
    const repo = await createRepo();
    await writeFile(
      path.join(repo, ".uatu.json"),
      JSON.stringify({ ignore: { exclude: "nope", respectGitignore: "true" } }),
    );

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots[0]?.configWarnings).toEqual([
      "Ignored .uatu.json ignore.exclude because it must be a string array.",
      "Ignored .uatu.json ignore.respectGitignore because it must be a boolean.",
    ]);
  });

  test("a malformed .uatu.json is reported exactly once", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-git-data-config-"));
    tempDirectories.push(repo);
    await writeFile(path.join(repo, ".uatu.json"), "{ nope");

    const warnings = await collectConfigWarnings(repo);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Invalid .uatu.json");
  });

  test("a watch root below the repository top level warns about its own .uatu.json", async () => {
    const repo = await createRepo();
    const docs = path.join(repo, "docs");
    await mkdir(docs);
    await writeFile(path.join(docs, "guide.md"), "# Guide\n");
    await writeFile(path.join(docs, ".uatu.json"), "{ nope");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: docs }],
      [{ id: docs, label: "docs", path: docs, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots[0]?.configWarnings).toHaveLength(1);
    expect(snapshots[0]?.configWarnings[0]).toStartWith("docs: Invalid .uatu.json");
  });

  test("a repo-top .uatu.json is not consulted when the watch root sits below it", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, ".uatu.json"), "{ nope");
    const docs = path.join(repo, "docs");
    await mkdir(docs);
    await writeFile(path.join(docs, "guide.md"), "# Guide\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: docs }],
      [{ id: docs, label: "docs", path: docs, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots[0]?.configWarnings).toEqual([]);
  });

  test("a non-git watch root still surfaces its config warnings", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-git-data-non-git-config-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, ".uatu.json"), "");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: tempDirectory }],
      [{ id: tempDirectory, label: "notes", path: tempDirectory, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots[0]?.status).toBe("non-git");
    expect(snapshots[0]?.configWarnings).toHaveLength(1);
    expect(snapshots[0]?.configWarnings[0]).toContain("Invalid .uatu.json");
  });

  test("a single-file watch root reads no ignore config", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-git-data-file-root-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "notes.md"), "# Notes\n");
    await writeFile(path.join(tempDirectory, ".uatu.json"), "{ nope");

    const file = path.join(tempDirectory, "notes.md");
    const snapshots = await collectRepositorySnapshots(
      [{ kind: "file", absolutePath: file, parentDir: tempDirectory }],
      [{ id: file, label: "notes.md", path: file, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots[0]?.configWarnings).toEqual([]);
  });

  test("parses brace rename paths with empty sides", () => {
    expect(parseDiffPath("src/{auth/ => }Button.ts")).toEqual({
      path: "src/Button.ts",
      oldPath: "src/auth/Button.ts",
    });
    expect(parseDiffPath("{ => src/auth/}Button.ts")).toEqual({
      path: "src/auth/Button.ts",
      oldPath: "Button.ts",
    });
  });
});

describe("compare target", () => {
  test("base includes committed-since-base changes; last-commit measures only the worktree", async () => {
    const repo = await createRepoWithBase();
    const entries: WatchEntry[] = [{ kind: "dir", absolutePath: repo }];
    const roots = [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }];

    const baseSnap = await collectRepositorySnapshots(entries, roots, "base");
    const basePaths = baseSnap[0]?.changedFiles.map(file => file.path).sort();
    expect(basePaths).toEqual(["README.md", "feature-committed.md"]);
    expect(baseSnap[0]?.base.compareTarget).toBe("base");
    expect(baseSnap[0]?.base.comparedAgainstRef).toBe("main");

    const lastSnap = await collectRepositorySnapshots(entries, roots, "last-commit");
    const lastPaths = lastSnap[0]?.changedFiles.map(file => file.path).sort();
    expect(lastPaths).toEqual(["README.md"]);
    expect(lastPaths).not.toContain("feature-committed.md");
    expect(lastSnap[0]?.base.compareTarget).toBe("last-commit");
    expect(lastSnap[0]?.base.comparedAgainstRef).toBe("HEAD");
  });

  test("last-commit matches `git diff HEAD` when staged and unstaged edits cancel", async () => {
    // Stage an edit, then revert it in the worktree: net change vs HEAD is
    // zero. A `--cached` + unstaged union would still report the file; a single
    // `git diff HEAD` (what the Diff view uses) does not. The overview must
    // agree with the Diff view.
    const repo = await createRepoWithBase();
    await writeFile(path.join(repo, "cancel.md"), "v1\n");
    await safeGit(repo, ["add", "cancel.md"]);
    await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "add cancel.md"]);
    await writeFile(path.join(repo, "cancel.md"), "v2\n");
    await safeGit(repo, ["add", "cancel.md"]); // staged: v1 -> v2
    await writeFile(path.join(repo, "cancel.md"), "v1\n"); // unstaged: v2 -> v1 (cancels)

    const lastSnap = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
      "last-commit",
    );

    expect(lastSnap[0]?.changedFiles.map(file => file.path)).not.toContain("cancel.md");
  });

  test("targets collapse to HEAD when no base resolves", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "README.md"), "# Changed\n");
    const entries: WatchEntry[] = [{ kind: "dir", absolutePath: repo }];
    const roots = [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }];

    const baseSnap = await collectRepositorySnapshots(entries, roots, "base");
    const lastSnap = await collectRepositorySnapshots(entries, roots, "last-commit");

    expect(baseSnap[0]?.base.targetsCollapsed).toBe(true);
    expect(baseSnap[0]?.base.comparedAgainstRef).toBe("HEAD");
    // Collapsed: both targets describe the same diff.
    expect(baseSnap[0]?.changedFiles.map(file => file.path)).toEqual(
      lastSnap[0]?.changedFiles.map(file => file.path),
    );
  });
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-git-data-repo-"));
  tempDirectories.push(repo);
  await safeGit(repo, ["init", "--initial-branch=feature"]);
  await safeGit(repo, ["config", "user.email", "uatu@example.test"]);
  await safeGit(repo, ["config", "user.name", "Uatu Test"]);
  await writeFile(path.join(repo, "README.md"), "# Readme\n");
  await safeGit(repo, ["add", "."]);
  await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
  return repo;
}

// A repo with a resolvable base (`main`), a feature branch carrying one
// committed-since-base file, plus an uncommitted edit to README in the
// worktree. Lets compare-target tests distinguish committed-since-base changes
// (base only) from worktree changes (both targets).
async function createRepoWithBase(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-git-data-base-"));
  tempDirectories.push(repo);
  await safeGit(repo, ["init", "--initial-branch=main"]);
  await safeGit(repo, ["config", "user.email", "uatu@example.test"]);
  await safeGit(repo, ["config", "user.name", "Uatu Test"]);
  await writeFile(path.join(repo, "README.md"), "# Readme\n");
  await safeGit(repo, ["add", "."]);
  await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
  await safeGit(repo, ["checkout", "-b", "feature"]);
  await writeFile(path.join(repo, "feature-committed.md"), "# Committed on feature\n");
  await safeGit(repo, ["add", "."]);
  await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "feature work"]);
  // Uncommitted worktree edit.
  await writeFile(path.join(repo, "README.md"), "# Readme edited\n");
  return repo;
}
