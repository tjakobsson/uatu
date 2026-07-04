import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { safeGit } from "../review/load";
import { findNonGitWatchEntries, resolveWatchRoots, scanRoots } from "./roots";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("resolveWatchRoots", () => {
  test("accepts a markdown file as a single-file entry", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-root-"));
    tempDirectories.push(tempDirectory);
    const tempFile = path.join(tempDirectory, "README.md");
    await writeFile(tempFile, "# Hello\n");

    const entries = await resolveWatchRoots([tempFile], tempDirectory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "file",
      absolutePath: tempFile,
      parentDir: tempDirectory,
    });
  });

  test("accepts a mix of directory and markdown file inputs", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-root-"));
    tempDirectories.push(tempDirectory);
    const tempFile = path.join(tempDirectory, "README.md");
    await writeFile(tempFile, "# Hello\n");

    const entries = await resolveWatchRoots([tempDirectory, tempFile], tempDirectory);
    expect(entries.map(entry => entry.kind).sort()).toEqual(["dir", "file"]);
  });

  test("rejects binary files", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-root-"));
    tempDirectories.push(tempDirectory);
    const tempFile = path.join(tempDirectory, "image.png");
    await writeFile(tempFile, "not really an image");

    await expect(resolveWatchRoots([tempFile], tempDirectory)).rejects.toThrow(
      "path is a binary file",
    );
  });

  test("accepts non-markdown text files", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-root-"));
    tempDirectories.push(tempDirectory);
    const tempFile = path.join(tempDirectory, "script.py");
    await writeFile(tempFile, "print('hello')\n");

    const entries = await resolveWatchRoots([tempFile], tempDirectory);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("file");
  });

  test("accepts an asciidoc file as a single-file entry", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-root-"));
    tempDirectories.push(tempDirectory);
    const tempFile = path.join(tempDirectory, "README.adoc");
    await writeFile(tempFile, "= Hello\n");

    const entries = await resolveWatchRoots([tempFile], tempDirectory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "file",
      absolutePath: tempFile,
      parentDir: tempDirectory,
    });
  });
});

describe("findNonGitWatchEntries", () => {
  test("accepts directory and file entries inside a git worktree", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "uatu-git-root-"));
    tempDirectories.push(repo);
    await safeGit(repo, ["init", "--initial-branch=main"]);
    const readme = path.join(repo, "README.md");
    await writeFile(readme, "# Readme\n");

    const entries = await resolveWatchRoots([repo, readme], repo);

    await expect(findNonGitWatchEntries(entries)).resolves.toEqual([]);
  });

  test("reports every entry outside a git worktree", async () => {
    const first = await mkdtemp(path.join(os.tmpdir(), "uatu-non-git-a-"));
    const second = await mkdtemp(path.join(os.tmpdir(), "uatu-non-git-b-"));
    tempDirectories.push(first, second);
    const note = path.join(second, "note.md");
    await writeFile(note, "# Note\n");

    const entries = await resolveWatchRoots([first, note], first);
    const nonGit = await findNonGitWatchEntries(entries);

    expect(nonGit.map(result => result.entry.absolutePath).sort()).toEqual([first, note].sort());
  });
});

describe("scanRoots", () => {
  test("discovers all non-binary files recursively, tags binary files as binary, and honors the hardcoded directory denylist", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-scan-"));
    tempDirectories.push(tempDirectory);

    await mkdir(path.join(tempDirectory, "guides", "drafts"), { recursive: true });
    await mkdir(path.join(tempDirectory, ".git"), { recursive: true });
    await mkdir(path.join(tempDirectory, ".github"), { recursive: true });
    await mkdir(path.join(tempDirectory, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    await writeFile(path.join(tempDirectory, "guides", "setup.markdown"), "# Setup\n");
    await writeFile(path.join(tempDirectory, "guides", "drafts", "note.txt"), "plain text\n");
    await writeFile(path.join(tempDirectory, "config.yaml"), "key: value\n");
    await writeFile(path.join(tempDirectory, "logo.png"), "not really png");
    // .git contents must stay hidden.
    await writeFile(path.join(tempDirectory, ".git", "config.md"), "# Should not appear\n");
    // node_modules contents must stay hidden.
    await writeFile(path.join(tempDirectory, "node_modules", "pkg", "README.md"), "# Should not appear\n");
    // Other dotdirs (not on the denylist) SHOULD be surfaced — they often hold
    // real markdown (e.g., .github/CONTRIBUTING.md, .claude/*.md).
    await writeFile(path.join(tempDirectory, ".github", "CONTRIBUTING.md"), "# Contributing\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.docs.map(doc => doc.relativePath)).toEqual([
      ".github/CONTRIBUTING.md",
      "config.yaml",
      "guides/drafts/note.txt",
      "guides/setup.markdown",
      "logo.png",
      "README.md",
    ]);

    const byPath = new Map(roots[0]!.docs.map(doc => [doc.relativePath, doc.kind]));
    expect(byPath.get("README.md")).toBe("markdown");
    expect(byPath.get("config.yaml")).toBe("text");
    expect(byPath.get("guides/drafts/note.txt")).toBe("text");
    expect(byPath.get("logo.png")).toBe("binary");
  });

  test("respects .uatu.json tree.exclude patterns at the watch root", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-scan-tree-exclude-"));
    tempDirectories.push(tempDirectory);
    await writeFile(
      path.join(tempDirectory, ".uatu.json"),
      JSON.stringify({ tree: { exclude: ["*.lock"] } }),
    );
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    await writeFile(path.join(tempDirectory, "bun.lock"), "lockfile contents\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const paths = roots[0]?.docs.map(doc => doc.relativePath) ?? [];
    expect(paths).toContain("README.md");
    expect(paths).not.toContain("bun.lock");
    // Files filtered by user-controlled patterns are counted as hidden so the
    // sidebar can surface that to the user.
    expect(roots[0]?.hiddenCount).toBe(1);
  });

  test("respects .gitignore by default and skips it when respectGitignore is false", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-scan-gitignore-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, ".gitignore"), "*.log\n");
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    await writeFile(path.join(tempDirectory, "debug.log"), "log line\n");

    const respected = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    expect(respected[0]?.docs.map(doc => doc.relativePath)).not.toContain("debug.log");

    const ignored = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }], {
      respectGitignore: false,
    });
    expect(ignored[0]?.docs.map(doc => doc.relativePath)).toContain("debug.log");
  });

  test("excludes secret-like files from directory roots", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-scan-secrets-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    await writeFile(path.join(tempDirectory, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(tempDirectory, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
    await writeFile(path.join(tempDirectory, "credentials.json"), "{}\n");
    await writeFile(path.join(tempDirectory, "id_ed25519"), "private key\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }], {
      respectGitignore: false,
    });
    const paths = roots[0]?.docs.map(doc => doc.relativePath) ?? [];

    expect(paths).toEqual(["README.md"]);
  });

  test("returns a single-document root for a file entry tagged with its kind", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-scan-file-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    await writeFile(filePath, "# Readme\n");

    const roots = await scanRoots([
      { kind: "file", absolutePath: filePath, parentDir: tempDirectory },
    ]);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.docs).toHaveLength(1);
    expect(roots[0]?.docs[0]?.id).toBe(filePath);
    expect(roots[0]?.docs[0]?.kind).toBe("markdown");
    expect(roots[0]?.path).toBe(tempDirectory);
    expect(roots[0]?.label).toBe("README.md");
  });
});
