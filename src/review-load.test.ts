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
    expect(load.ignoredFiles.map(file => file.path)).toContain("dist/bundle.js");
    expect(["medium", "high"]).toContain(load.level);
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
