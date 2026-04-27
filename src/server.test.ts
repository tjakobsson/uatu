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
  renderDocument,
  resolveWatchedFileCandidates,
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

  test("respectGitignore defaults to true and is disabled by --no-gitignore", () => {
    const defaulted = parseCommand(["watch"]);
    if (defaulted.kind !== "watch") throw new Error("expected watch");
    expect(defaulted.options.respectGitignore).toBe(true);

    const opted = parseCommand(["watch", "--no-gitignore"]);
    if (opted.kind !== "watch") throw new Error("expected watch");
    expect(opted.options.respectGitignore).toBe(false);
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

  test("rejects binary files", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-root-"));
    tempDirectories.push(tempDirectory);
    const tempFile = path.join(tempDirectory, "image.png");
    await writeFile(tempFile, "not really an image");

    await expect(resolveWatchRoots([tempFile], tempDirectory)).rejects.toThrow(
      "watch path is a binary file",
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

  test("respects .uatuignore patterns at the watch root", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-scan-uatuignore-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, ".uatuignore"), "*.lock\n");
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");
    await writeFile(path.join(tempDirectory, "bun.lock"), "lockfile contents\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const paths = roots[0]?.docs.map(doc => doc.relativePath) ?? [];
    expect(paths).toContain("README.md");
    expect(paths).not.toContain("bun.lock");
    // Files filtered by `.uatuignore` are counted as hidden so the sidebar can
    // surface that to the user.
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

describe("renderDocument", () => {
  test("renders a markdown document through the markdown pipeline", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-md-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    await writeFile(filePath, "# Hello\n\nworld\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.title).toBe("Hello");
    expect(rendered.html).toContain("<p>world</p>");
  });

  test("renders a non-markdown text document as syntax-highlighted code", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-code-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "config.yaml");
    await writeFile(filePath, "key: value\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.title).toBe("config.yaml");
    expect(rendered.html).toContain('<pre><code class="hljs language-yaml">');
    expect(rendered.kind).toBe("text");
    expect(rendered.language).toBe("yaml");
  });

  test("emits markdown kind and null language for a Markdown document", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-md-kind-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    await writeFile(filePath, "# Hello\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.kind).toBe("markdown");
    expect(rendered.language).toBeNull();
  });

  test("title extraction ignores `#` lines inside fenced code blocks", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-title-fence-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    // No real heading — the only `#` lines live inside a fenced code block.
    // The title should fall back to the filename, NOT pick up "Lockfiles".
    await writeFile(
      filePath,
      "Some intro text.\n\n```gitignore\n# Lockfiles\n*.lock\n```\n",
    );

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.title).toBe("README");
  });

  test("title extraction picks up an HTML <h1> heading", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-title-html-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    await writeFile(
      filePath,
      `<h1 align="center">uatu</h1>\n\nSome content.\n\n\`\`\`gitignore\n# Lockfiles\n*.lock\n\`\`\`\n`,
    );

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.title).toBe("uatu");
  });

  test("title extraction prefers a Markdown `# Heading` over later content", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-title-md-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "doc.md");
    await writeFile(filePath, "# Real Title\n\nBody.\n\n```bash\n# comment in code\n```\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.title).toBe("Real Title");
  });

  test("rejects a binary document with an error", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-binary-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "logo.png");
    await writeFile(filePath, "not really png");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    expect(roots[0]?.docs.find(doc => doc.id === filePath)?.kind).toBe("binary");
    await expect(renderDocument(roots, filePath)).rejects.toThrow("document is binary");
  });

  test("rejects an unknown id with not-found", async () => {
    await expect(renderDocument([], "/nope")).rejects.toThrow("document not found");
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

  test("resolveWatchedFileCandidates maps a URL path to a file inside the root", () => {
    expect(resolveWatchedFileCandidates("/hero.svg", ["/repo"])).toEqual(["/repo/hero.svg"]);
    expect(resolveWatchedFileCandidates("/docs/intro.md", ["/repo"])).toEqual([
      "/repo/docs/intro.md",
    ]);
  });

  test("resolveWatchedFileCandidates rejects empty or root-only paths", () => {
    expect(resolveWatchedFileCandidates("", ["/repo"])).toEqual([]);
    expect(resolveWatchedFileCandidates("/", ["/repo"])).toEqual([]);
  });

  test("resolveWatchedFileCandidates rejects paths that escape the root", () => {
    expect(resolveWatchedFileCandidates("/../etc/passwd", ["/repo"])).toEqual([]);
    expect(resolveWatchedFileCandidates("/docs/../../etc/passwd", ["/repo"])).toEqual([]);
  });

  test("resolveWatchedFileCandidates returns all in-bounds candidates in root order", () => {
    // The caller stats each candidate and serves the first that exists, so a
    // miss under the first root must fall through to the next instead of 404ing.
    expect(resolveWatchedFileCandidates("/a.svg", ["/repo/docs", "/repo/notes"])).toEqual([
      "/repo/docs/a.svg",
      "/repo/notes/a.svg",
    ]);
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

  test("editing .uatuignore at runtime reapplies the new patterns", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-ignore-live-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const lockfile = path.join(tempDirectory, "package-lock.json");
    const ignoreFile = path.join(tempDirectory, ".uatuignore");
    await writeFile(readme, "# Readme\n");
    await writeFile(lockfile, "{}\n");
    await writeFile(ignoreFile, "");

    const session = createWatchSession(
      [{ kind: "dir", absolutePath: tempDirectory }],
      true,
      { usePolling: true },
    );

    try {
      await session.start();
      await waitUntil(() =>
        session.getRoots().flatMap(root => root.docs).some(doc => doc.id === lockfile),
      );

      await writeFile(ignoreFile, "package-lock.json\n");
      await waitUntil(
        () => session.getRoots().flatMap(root => root.docs).every(doc => doc.id !== lockfile),
        4000,
      );

      await writeFile(ignoreFile, "");
      await waitUntil(
        () => session.getRoots().flatMap(root => root.docs).some(doc => doc.id === lockfile),
        4000,
      );
    } finally {
      await session.stop();
    }
  });
});
