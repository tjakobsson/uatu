import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_PORT, parseCommand, resolveWatchRoots, scanRoots } from "./server";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("parseCommand", () => {
  test("defaults watch roots, follow, and open behavior", () => {
    const parsed = parseCommand(["watch"]);
    expect(parsed.kind).toBe("watch");

    if (parsed.kind !== "watch") {
      return;
    }

    expect(parsed.options.rootPaths).toEqual(["."]);
    expect(parsed.options.follow).toBe(true);
    expect(parsed.options.openBrowser).toBe(true);
    expect(parsed.options.port).toBe(DEFAULT_PORT);
  });

  test("accepts positional roots and startup flags", () => {
    const parsed = parseCommand(["watch", "docs", "notes", "--no-open", "--no-follow", "--port", "5000"]);
    expect(parsed.kind).toBe("watch");

    if (parsed.kind !== "watch") {
      return;
    }

    expect(parsed.options.rootPaths).toEqual(["docs", "notes"]);
    expect(parsed.options.openBrowser).toBe(false);
    expect(parsed.options.follow).toBe(false);
    expect(parsed.options.port).toBe(5000);
  });
});

describe("resolveWatchRoots", () => {
  test("rejects non-directories", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-root-"));
    tempDirectories.push(tempDirectory);
    const tempFile = path.join(tempDirectory, "README.md");
    await writeFile(tempFile, "# Hello\n");

    await expect(resolveWatchRoots([tempFile], tempDirectory)).rejects.toThrow("watch root is not a directory");
  });
});

describe("scanRoots", () => {
  test("discovers markdown recursively and ignores hidden or non-markdown files", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-scan-"));
    tempDirectories.push(tempDirectory);

    await mkdir(path.join(tempDirectory, "guides", "drafts"), { recursive: true });
    await mkdir(path.join(tempDirectory, ".hidden"), { recursive: true });
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    await writeFile(path.join(tempDirectory, "guides", "setup.markdown"), "# Setup\n");
    await writeFile(path.join(tempDirectory, "guides", "drafts", "note.txt"), "ignored\n");
    await writeFile(path.join(tempDirectory, ".hidden", "secret.md"), "# Hidden\n");

    const roots = await scanRoots([tempDirectory]);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.docs.map(doc => doc.relativePath)).toEqual(["guides/setup.markdown", "README.md"]);
  });
});
