import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadIgnoreMatcher } from "./engine";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-ignore-"));
  tempDirectories.push(dir);
  return dir;
}

async function writeUatuConfig(rootPath: string, payload: unknown): Promise<void> {
  await writeFile(path.join(rootPath, ".uatu.json"), JSON.stringify(payload), "utf8");
}

describe("loadIgnoreMatcher", () => {
  test("only VS Code's files.exclude defaults are built in, at any depth and any case", async () => {
    const rootPath = await makeTempDir();
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    for (const denied of [".git/config", "a/.GIT/HEAD", ".svn/entries", "x/.hg/store", ".jj/repo", "docs/.DS_Store", "img/Thumbs.db", "a/b/thumbs.db"]) {
      expect(matcher.shouldIgnore(denied)).toBe(true);
    }
    for (const permitted of ["node_modules/x.js", ".venv/lib/site.py", ".env", ".env.local", "id_rsa", "a.swp", "notes~", "coverage/lcov.info", "build/renders/out.wav", "dist/index.html", "__pycache__/m.pyc", ".cache/x", "server.pem", "CVS/Entries"]) {
      expect(matcher.shouldIgnore(permitted)).toBe(false);
    }
    expect(matcher.shouldIgnore("node_modules", true)).toBe(false);
    expect(matcher.toChokidarIgnored()(path.join(rootPath, "build"))).toBe(false);
  });

  test("explicit exclusions win and negations cannot reopen built-ins", async () => {
    const rootPath = await makeTempDir();
    await writeUatuConfig(rootPath, { ignore: { exclude: ["build/renders/private/**", "node_modules/", "!.git/**"] } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("build/renders/out.wav")).toBe(false);
    expect(matcher.shouldIgnore("build/renders/private/take.wav")).toBe(true);
    expect(matcher.shouldIgnore("node_modules", true)).toBe(true);
    expect(matcher.shouldIgnore("pkg/node_modules/a.js")).toBe(true);
    expect(matcher.shouldIgnore(".git/config")).toBe(true);
  });

  test("only explicit valid legacy configuration changes the initial visibility default", async () => {
    const rootPath = await makeTempDir();
    expect((await loadIgnoreMatcher({ rootPath, respectGitignore: true })).initialShowIgnored).toBe(true);
    await writeUatuConfig(rootPath, { ignore: { respectGitignore: "invalid" } });
    expect((await loadIgnoreMatcher({ rootPath, respectGitignore: true })).initialShowIgnored).toBe(true);
    await writeUatuConfig(rootPath, { ignore: { respectGitignore: true } });
    expect((await loadIgnoreMatcher({ rootPath, respectGitignore: true })).initialShowIgnored).toBe(false);
    expect((await loadIgnoreMatcher({ rootPath, respectGitignore: false })).initialShowIgnored).toBe(true);
    expect((await loadIgnoreMatcher({ rootPath, respectGitignore: true, isSingleFileRoot: true })).initialShowIgnored).toBe(true);
    await writeUatuConfig(rootPath, { ignore: { respectGitignore: false } });
    expect((await loadIgnoreMatcher({ rootPath, respectGitignore: true })).initialShowIgnored).toBe(true);
  });
  test("dependency and output folders are not built-in exclusions", async () => {
    const rootPath = await makeTempDir();
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("node_modules/foo.js")).toBe(false);
    expect(matcher.shouldIgnore("dist/bundle.js")).toBe(false);
    expect(matcher.shouldIgnore("README.md")).toBe(false);
  });

  test(".uatu.json ignore.exclude patterns hide matching files", async () => {
    const rootPath = await makeTempDir();
    await writeUatuConfig(rootPath, { ignore: { exclude: ["*.lock"] } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("bun.lock")).toBe(true);
    expect(matcher.shouldIgnore("README.md")).toBe(false);
  });

  test("Git-ignore is visibility metadata, never exposure policy", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "*.log\n");
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
    expect(matcher.shouldIgnore("README.md")).toBe(false);
  });

  test("CLI --no-gitignore (respectGitignore: false) wins over .uatu.json ignore.respectGitignore: true", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "*.log\n");
    await writeUatuConfig(rootPath, { ignore: { respectGitignore: true } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
  });

  test(".uatu.json ignore.respectGitignore: false disables .gitignore when CLI is permissive", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "*.log\n");
    await writeUatuConfig(rootPath, { ignore: { respectGitignore: false } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
    // Built-in defaults still apply.
    expect(matcher.shouldIgnore(".git/config")).toBe(true);
  });

  test(".uatu.json ignore.exclude negation un-excludes something .gitignore excluded", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "*.log\n");
    await writeUatuConfig(rootPath, { ignore: { exclude: ["!debug.log"] } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
    expect(matcher.shouldIgnore("error.log")).toBe(false);
    expect(matcher.isVisibilityException?.("debug.log")).toBe(true);
    expect(matcher.isVisibilityException?.("error.log")).toBe(false);
  });

  test(".uatuignore is no longer honored", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".uatuignore"), "*.lock\n");
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("bun.lock")).toBe(false);
  });

  test("missing .gitignore and .uatu.json do not throw and only defaults apply", async () => {
    const rootPath = await makeTempDir();
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: true });
    expect(matcher.shouldIgnore("README.md")).toBe(false);
    expect(matcher.shouldIgnore(".git/anything")).toBe(true);
    expect(matcher.shouldIgnore("node_modules/anything")).toBe(false);
  });

  test("isSingleFileRoot skips .gitignore AND .uatu.json (defaults still apply)", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".gitignore"), "secret.md\n");
    await writeUatuConfig(rootPath, { ignore: { exclude: ["*.log"] } });
    const matcher = await loadIgnoreMatcher({
      rootPath,
      respectGitignore: true,
      isSingleFileRoot: true,
    });
    expect(matcher.shouldIgnore("secret.md")).toBe(false);
    expect(matcher.shouldIgnore("debug.log")).toBe(false);
    // Defaults still apply, even on single-file roots.
    expect(matcher.shouldIgnore(".git/config")).toBe(true);
  });

  test("toChokidarIgnored converts absolute paths and never ignores the watched root itself", async () => {
    const rootPath = await makeTempDir();
    await writeUatuConfig(rootPath, { ignore: { exclude: ["*.log"] } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    const ignored = matcher.toChokidarIgnored();
    expect(ignored(rootPath)).toBe(false);
    expect(ignored(path.join(rootPath, "debug.log"))).toBe(true);
    expect(ignored(path.join(rootPath, "README.md"))).toBe(false);
    // Outside the root: never ignore (not the matcher's responsibility).
    expect(ignored("/var/elsewhere/foo.log")).toBe(false);
  });

  test("toChokidarIgnored normalizes platform path separators to forward slashes", async () => {
    const rootPath = await makeTempDir();
    await writeUatuConfig(rootPath, { ignore: { exclude: ["nested/secret.txt"] } });
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    const ignored = matcher.toChokidarIgnored();
    // Constructing the path with the platform separator should still match the
    // forward-slash pattern after normalization.
    const nestedSecret = path.join(rootPath, "nested", "secret.txt");
    expect(ignored(nestedSecret)).toBe(true);
    const nestedOther = path.join(rootPath, "nested", "other.txt");
    expect(ignored(nestedOther)).toBe(false);
  });

  test("malformed .uatu.json falls back to defaults silently (git-data owns parse warnings)", async () => {
    const rootPath = await makeTempDir();
    await writeFile(path.join(rootPath, ".uatu.json"), "{not json", "utf8");
    const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore: false });
    expect(matcher.shouldIgnore("README.md")).toBe(false);
    expect(matcher.shouldIgnore(".git/anything")).toBe(true);
    expect(matcher.shouldIgnore("node_modules/anything")).toBe(false);
  });
});
