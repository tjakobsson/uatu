import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createWatchSession,
  DEFAULT_PORT,
  getAssetRoots,
  parseCommand,
  printStartupBanner,
  resolveWatchedFile,
  resolveWatchRoots,
  scanRoots,
  STARTUP_BANNER,
} from "./server";

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

  test("rejects non-markdown files", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-root-"));
    tempDirectories.push(tempDirectory);
    const tempFile = path.join(tempDirectory, "image.png");
    await writeFile(tempFile, "not really an image");

    await expect(resolveWatchRoots([tempFile], tempDirectory)).rejects.toThrow(
      "watch path must be a directory or a Markdown file",
    );
  });
});

describe("printStartupBanner", () => {
  test("prints the ASCII banner with a leading newline when stdout is a TTY", () => {
    const chunks: string[] = [];
    printStartupBanner({ isTTY: true, write: chunk => chunks.push(chunk) });
    const output = chunks.join("");
    expect(output.startsWith("\n")).toBe(true);
    expect(output).toContain(STARTUP_BANNER);
    expect(output).toContain("I observe. I follow. I render.");
  });

  test("writes nothing when stdout is not a TTY", () => {
    const chunks: string[] = [];
    printStartupBanner({ isTTY: false, write: chunk => chunks.push(chunk) });
    expect(chunks).toHaveLength(0);
  });
});

describe("scanRoots", () => {
  test("discovers markdown recursively and ignores known-junk directories and non-markdown files", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-scan-"));
    tempDirectories.push(tempDirectory);

    await mkdir(path.join(tempDirectory, "guides", "drafts"), { recursive: true });
    await mkdir(path.join(tempDirectory, ".git"), { recursive: true });
    await mkdir(path.join(tempDirectory, ".github"), { recursive: true });
    await mkdir(path.join(tempDirectory, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    await writeFile(path.join(tempDirectory, "guides", "setup.markdown"), "# Setup\n");
    await writeFile(path.join(tempDirectory, "guides", "drafts", "note.txt"), "ignored\n");
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
      "guides/setup.markdown",
      "README.md",
    ]);
  });

  test("returns a single-document root for a file entry", async () => {
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
    expect(roots[0]?.path).toBe(tempDirectory);
    expect(roots[0]?.label).toBe("README.md");
  });
});

describe("asset root helpers", () => {
  test("getAssetRoots returns dir paths for dirs and parent dirs for files", () => {
    const roots = getAssetRoots([
      { kind: "dir", absolutePath: "/repo/docs" },
      { kind: "file", absolutePath: "/repo/README.md", parentDir: "/repo" },
    ]);
    expect(roots).toEqual(["/repo/docs", "/repo"]);
  });

  test("resolveWatchedFile maps a URL path to a file inside the root", () => {
    expect(resolveWatchedFile("/hero.svg", ["/repo"])).toBe("/repo/hero.svg");
    expect(resolveWatchedFile("/docs/intro.md", ["/repo"])).toBe("/repo/docs/intro.md");
  });

  test("resolveWatchedFile rejects empty or root-only paths", () => {
    expect(resolveWatchedFile("", ["/repo"])).toBeNull();
    expect(resolveWatchedFile("/", ["/repo"])).toBeNull();
  });

  test("resolveWatchedFile rejects paths that escape the root", () => {
    expect(resolveWatchedFile("/../etc/passwd", ["/repo"])).toBeNull();
    expect(resolveWatchedFile("/docs/../../etc/passwd", ["/repo"])).toBeNull();
  });

  test("resolveWatchedFile resolves against the first root that contains the path", () => {
    // First-match wins: /a.svg under /repo/docs is /repo/docs/a.svg.
    expect(resolveWatchedFile("/a.svg", ["/repo/docs", "/repo/notes"])).toBe("/repo/docs/a.svg");
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  if (!predicate()) {
    throw new Error("condition not met within timeout");
  }
}

describe("watchSession scope", () => {
  test("pinning narrows visible roots to the selected file and unpin restores folder scope", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-pin-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const guide = path.join(tempDirectory, "guide.md");
    await writeFile(readme, "# Readme\n");
    await writeFile(guide, "# Guide\n");

    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true },
    );

    try {
      await session.start();
      await waitUntil(() => session.getRoots().some(root => root.docs.length >= 2));

      session.setScope({ kind: "file", documentId: readme });
      await waitUntil(() => {
        const docs = session.getRoots().flatMap(root => root.docs);
        return docs.length === 1 && docs[0]?.id === readme;
      });
      expect(session.getScope()).toEqual({ kind: "file", documentId: readme });

      session.setScope({ kind: "folder" });
      await waitUntil(() => session.getRoots().flatMap(root => root.docs).length >= 2);
      expect(session.getScope()).toEqual({ kind: "folder" });
    } finally {
      await session.stop();
    }
  });

  test("unlinking the pinned file reverts scope to folder automatically", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-pin-unlink-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const guide = path.join(tempDirectory, "guide.md");
    await writeFile(readme, "# Readme\n");
    await writeFile(guide, "# Guide\n");

    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true },
    );

    try {
      await session.start();
      await waitUntil(() => session.getRoots().some(root => root.docs.length >= 2));

      session.setScope({ kind: "file", documentId: readme });
      await waitUntil(() => {
        const docs = session.getRoots().flatMap(root => root.docs);
        return docs.length === 1 && docs[0]?.id === readme;
      });

      await unlink(readme);
      await waitUntil(
        () =>
          session.getScope().kind === "folder" &&
          session.getRoots().flatMap(root => root.docs).some(doc => doc.id === guide),
      );
      expect(session.getScope()).toEqual({ kind: "folder" });
    } finally {
      await session.stop();
    }
  });
});
