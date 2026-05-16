import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectRepositorySnapshots, loadReviewSettings, matchPath, parseDiffPath, safeGit } from "./review-load";
import type { WatchEntry } from "./server";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("review-load repository snapshots", () => {
  test("reports an explicit non-git state for roots outside a repository", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-review-non-git-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: tempDirectory }],
      [{ id: tempDirectory, label: "root", path: tempDirectory, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.metadata.status).toBe("non-git");
    expect(snapshots[0]?.reviewLoad.status).toBe("non-git");
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

  test("uses dirty-worktree-only fallback when no review base exists", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "README.md"), "# Changed\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    expect(snapshots[0]?.reviewLoad.base.mode).toBe("dirty-worktree-only");
    expect(snapshots[0]?.reviewLoad.changedFiles.map(file => file.path)).toContain("README.md");
  });

  test("applies configured risk, support, ignore, and thresholds with explanations", async () => {
    const repo = await createRepo();
    await writeFile(
      path.join(repo, ".uatu.json"),
      JSON.stringify({
        review: {
          thresholds: { medium: 10, high: 20 },
          riskAreas: [{ label: "Auth", paths: ["src/auth/**"], score: 12, perFile: 2, max: 20 }],
          supportAreas: [{ label: "Tests", paths: ["**/*.test.ts"], score: -6, perFile: -1, maxDiscount: 10 }],
          ignoreAreas: [{ label: "Generated", paths: ["dist/**"] }],
        },
      }),
    );
    await mkdir(path.join(repo, "src", "auth"), { recursive: true });
    await mkdir(path.join(repo, "dist"), { recursive: true });
    await writeFile(path.join(repo, "src", "auth", "session.ts"), "export const changed = true;\n");
    await writeFile(path.join(repo, "src", "auth", "session.test.ts"), "test('x', () => {});\n");
    await writeFile(path.join(repo, "dist", "bundle.js"), "generated\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );
    const load = snapshots[0]!.reviewLoad;

    expect(load.drivers.some(driver => driver.kind === "risk" && driver.label === "Auth")).toBe(true);
    expect(load.drivers.some(driver => driver.kind === "support" && driver.label === "Tests")).toBe(true);
    expect(load.drivers.some(driver => driver.kind === "ignore" && driver.label === "Generated")).toBe(true);
    expect(load.configuredAreas.find(area => area.label === "Auth")?.matchedFiles).toContain("src/auth/session.ts");
    expect(load.configuredAreas.find(area => area.label === "Tests")?.score).toBeLessThan(0);
    expect(load.configuredAreas.find(area => area.label === "Generated")?.matchedFiles).toContain("dist/bundle.js");
    expect(load.ignoredFiles.map(file => file.path)).toContain("dist/bundle.js");
    expect(["medium", "high"]).toContain(load.level);
  });

  test("exposes configured areas even when none match the current change", async () => {
    const repo = await createRepo();
    await writeFile(
      path.join(repo, ".uatu.json"),
      JSON.stringify({
        review: {
          riskAreas: [{ label: "Auth", paths: ["src/auth/**"], score: 12 }],
          supportAreas: [{ label: "Tests", paths: ["**/*.test.ts"], score: -6 }],
          ignoreAreas: [{ label: "Generated", paths: ["dist/**"] }],
        },
      }),
    );
    await writeFile(path.join(repo, "notes.txt"), "changed\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );
    const load = snapshots[0]!.reviewLoad;

    expect(load.configuredAreas.map(area => area.label)).toEqual(["Auth", "Tests", "Generated"]);
    expect(load.configuredAreas.every(area => area.matchedFiles.length === 0)).toBe(true);
    expect(load.configuredAreas.every(area => area.score === 0)).toBe(true);
    expect(load.drivers.some(driver => driver.kind === "risk" || driver.kind === "support" || driver.kind === "ignore")).toBe(false);
  });

  test("unconfigured paths contribute mechanical cost without path modifiers", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "notes.txt"), "changed\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );
    const drivers = snapshots[0]!.reviewLoad.drivers;

    expect(drivers.some(driver => driver.kind === "mechanical")).toBe(true);
    expect(drivers.some(driver => driver.kind === "risk" || driver.kind === "support")).toBe(false);
    expect(snapshots[0]!.reviewLoad.configuredAreas).toEqual([]);
  });

  test("reports untracked files with the distinct '?' status", async () => {
    const repo = await createRepo();
    await writeFile(path.join(repo, "scratch.md"), "# Scratch\n");

    const snapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repo }],
      [{ id: repo, label: "repo", path: repo, docs: [], hiddenCount: 0 }],
    );

    const entry = snapshots[0]?.reviewLoad.changedFiles.find(file => file.path === "scratch.md");
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

    const entry = snapshots[0]?.reviewLoad.changedFiles.find(file => file.path === "feature.md");
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

    const entry = snapshots[0]?.reviewLoad.changedFiles.find(file => file.path === "README.md");
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

    const entry = snapshots[0]?.reviewLoad.changedFiles.find(file => file.path === "README.md");
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

    const entry = snapshots[0]?.reviewLoad.changedFiles.find(file => file.path === "GUIDE.md");
    expect(entry).toBeDefined();
    expect(entry?.status.startsWith("R")).toBe(true);
    expect(entry?.oldPath).toBe("README.md");
  });

  test("untracked and staged-added states produce the same review-burden score", async () => {
    const untrackedRepo = await createRepo();
    await writeFile(path.join(untrackedRepo, "feature.md"), "# Feature\n");

    const stagedRepo = await createRepo();
    await writeFile(path.join(stagedRepo, "feature.md"), "# Feature\n");
    await safeGit(stagedRepo, ["add", "feature.md"]);

    const untrackedSnapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: untrackedRepo }],
      [{ id: untrackedRepo, label: "repo", path: untrackedRepo, docs: [], hiddenCount: 0 }],
    );
    const stagedSnapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: stagedRepo }],
      [{ id: stagedRepo, label: "repo", path: stagedRepo, docs: [], hiddenCount: 0 }],
    );

    expect(untrackedSnapshots[0]?.reviewLoad.score).toBe(stagedSnapshots[0]?.reviewLoad.score);
    expect(untrackedSnapshots[0]?.reviewLoad.level).toBe(stagedSnapshots[0]?.reviewLoad.level);
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
              kind: "source",
            },
          ],
          hiddenCount: 0,
        },
      ],
    );

    const load = snapshots[0]?.reviewLoad;
    expect(load?.gitIgnoredFiles).toContain("local-only.json");
    expect(load?.changedFiles.map(file => file.path)).not.toContain("local-only.json");
    expect(load?.ignoredFiles.map(file => file.path)).not.toContain("local-only.json");
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

    expect(snapshots[0]?.reviewLoad.gitIgnoredFiles).toEqual([]);
  });

  test("gitignored files do not affect the burden score", async () => {
    const repoWithoutIgnored = await createRepo();
    await writeFile(path.join(repoWithoutIgnored, "README.md"), "# changed\n");

    const repoWithIgnored = await createRepo();
    await writeFile(path.join(repoWithIgnored, "README.md"), "# changed\n");
    await writeFile(path.join(repoWithIgnored, ".gitignore"), "ignored-leaf.json\n");
    await writeFile(path.join(repoWithIgnored, "ignored-leaf.json"), "{}\n");
    await safeGit(repoWithIgnored, ["add", ".gitignore"]);
    await safeGit(repoWithIgnored, ["-c", "commit.gpgsign=false", "commit", "-m", "ignore"]);

    const noIgnoredSnapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repoWithoutIgnored }],
      [{ id: repoWithoutIgnored, label: "repo", path: repoWithoutIgnored, docs: [], hiddenCount: 0 }],
    );
    const ignoredSnapshots = await collectRepositorySnapshots(
      [{ kind: "dir", absolutePath: repoWithIgnored }],
      [
        {
          id: repoWithIgnored,
          label: "repo",
          path: repoWithIgnored,
          docs: [
            {
              id: `${repoWithIgnored}/ignored-leaf.json`,
              name: "ignored-leaf.json",
              relativePath: "ignored-leaf.json",
              mtimeMs: 0,
              rootId: repoWithIgnored,
              kind: "source",
            },
          ],
          hiddenCount: 0,
        },
      ],
    );

    expect(ignoredSnapshots[0]?.reviewLoad.score).toBe(noIgnoredSnapshots[0]?.reviewLoad.score);
    expect(ignoredSnapshots[0]?.reviewLoad.gitIgnoredFiles).toContain("ignored-leaf.json");
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

describe("review settings and path matching", () => {
  test("invalid config produces warnings and default thresholds", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-review-invalid-"));
    tempDirectories.push(repo);
    await writeFile(path.join(repo, ".uatu.json"), "{ nope");

    const result = await loadReviewSettings(repo);

    expect(result.settings.thresholds).toEqual({ medium: 35, high: 70 });
    expect(result.warnings[0]).toContain("Invalid .uatu.json");
  });

  test("matches simple glob patterns without a YAML dependency", () => {
    expect(matchPath("src/auth/**", "src/auth/session/index.ts")).toBe(true);
    expect(matchPath("**/*.test.ts", "src/auth/session.test.ts")).toBe(true);
    expect(matchPath("docs/*", "docs/guide.md")).toBe(true);
    expect(matchPath("docs/*", "docs/guides/setup.md")).toBe(false);
  });

  test("normalizes trailing slash area patterns as directory globs", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-review-config-"));
    tempDirectories.push(repo);
    await writeFile(
      path.join(repo, ".uatu.json"),
      JSON.stringify({
        review: {
          ignoreAreas: [{ label: "Build output", paths: ["dist/"] }],
        },
      }),
    );

    const result = await loadReviewSettings(repo);

    expect(result.settings.ignoreAreas[0]?.paths).toEqual(["dist/**"]);
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

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-review-repo-"));
  tempDirectories.push(repo);
  await safeGit(repo, ["init", "--initial-branch=feature"]);
  await safeGit(repo, ["config", "user.email", "uatu@example.test"]);
  await safeGit(repo, ["config", "user.name", "Uatu Test"]);
  await writeFile(path.join(repo, "README.md"), "# Readme\n");
  await safeGit(repo, ["add", "."]);
  await safeGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
  return repo;
}
