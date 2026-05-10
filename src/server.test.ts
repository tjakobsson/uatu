import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  attachWatcherCrashGuard,
  buildWatcherIgnorePredicate,
  createStatePayload,
  createWatchSession,
  canSetFileScope,
  DEFAULT_PORT,
  findNonGitWatchEntries,
  getAssetRoots,
  parseCommand,
  prefersHtmlNavigation,
  printIndexingStatus,
  printStartupBanner,
  renderDocument,
  resolveStaticFileRequest,
  resolveViewableDocument,
  resolveWatchRoots,
  scanRoots,
  spaShellResponse,
  staticFileResponse,
  STARTUP_BANNER,
  usageText,
} from "./server";
import { EventEmitter } from "node:events";
import type { IgnoreMatcher } from "./ignore-engine";
import { safeGit } from "./review-load";

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
    expect(parsed.options.portExplicit).toBe(false);
    expect(parsed.options.force).toBe(false);
  });

  test("accepts positional roots and startup flags", () => {
    const parsed = parseCommand(["watch", "docs", "notes", "--force", "--no-open", "--no-follow", "--port", "5000"]);
    expect(parsed.kind).toBe("watch");

    if (parsed.kind !== "watch") {
      return;
    }

    expect(parsed.options.rootPaths).toEqual(["docs", "notes"]);
    expect(parsed.options.openBrowser).toBe(false);
    expect(parsed.options.follow).toBe(false);
    expect(parsed.options.port).toBe(5000);
    expect(parsed.options.portExplicit).toBe(true);
    expect(parsed.options.force).toBe(true);
  });

  test("accepts --port 0 for an ephemeral kernel-assigned port", () => {
    const parsed = parseCommand(["watch", "--port", "0"]);
    expect(parsed.kind).toBe("watch");
    if (parsed.kind !== "watch") return;
    expect(parsed.options.port).toBe(0);
    expect(parsed.options.portExplicit).toBe(true);
  });

  test("rejects negative or out-of-range ports", () => {
    expect(() => parseCommand(["watch", "--port", "-1"])).toThrow();
    expect(() => parseCommand(["watch", "--port", "70000"])).toThrow();
    expect(() => parseCommand(["watch", "--port", "abc"])).toThrow();
  });

  test("respectGitignore defaults to true and is disabled by --no-gitignore", () => {
    const defaulted = parseCommand(["watch"]);
    if (defaulted.kind !== "watch") throw new Error("expected watch");
    expect(defaulted.options.respectGitignore).toBe(true);

    const opted = parseCommand(["watch", "--no-gitignore"]);
    if (opted.kind !== "watch") throw new Error("expected watch");
    expect(opted.options.respectGitignore).toBe(false);
  });

  test("usage documents the --force flag", () => {
    expect(usageText()).toContain("--force");
  });

  test("startupMode defaults to undefined when --mode is not provided", () => {
    const parsed = parseCommand(["watch"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.startupMode).toBeUndefined();
  });

  test("--mode=author parses as the author startup mode", () => {
    const parsed = parseCommand(["watch", "--mode=author"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.startupMode).toBe("author");
  });

  test("--mode review (space form) parses as the review startup mode", () => {
    const parsed = parseCommand(["watch", "--mode", "review"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.startupMode).toBe("review");
  });

  test("--mode=review forces follow off even without --no-follow", () => {
    const parsed = parseCommand(["watch", "--mode=review"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.startupMode).toBe("review");
    expect(parsed.options.follow).toBe(false);
  });

  test("--mode=author leaves the existing follow default intact", () => {
    const parsed = parseCommand(["watch", "--mode=author"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.startupMode).toBe("author");
    expect(parsed.options.follow).toBe(true);
  });

  test("--mode rejects unknown values with a clear error", () => {
    expect(() => parseCommand(["watch", "--mode=write"])).toThrow(/invalid --mode value/);
    expect(() => parseCommand(["watch", "--mode", "diff"])).toThrow(/invalid --mode value/);
  });

  test("--mode requires a value in the space form", () => {
    expect(() => parseCommand(["watch", "--mode"])).toThrow(/missing value for --mode/);
  });

  test("usage documents the --mode flag", () => {
    expect(usageText()).toContain("--mode");
  });

  test("debug defaults to false; watchdog defaults to enabled", () => {
    const parsed = parseCommand(["watch"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.debug).toBe(false);
    expect(parsed.options.watchdogEnabled).toBe(true);
    expect(parsed.options.watchdogTimeoutMs).toBeUndefined();
  });

  test("--debug enables verbose metrics history", () => {
    const parsed = parseCommand(["watch", "--debug"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.debug).toBe(true);
  });

  test("--no-watchdog suppresses the watchdog subprocess", () => {
    const parsed = parseCommand(["watch", "--no-watchdog"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.watchdogEnabled).toBe(false);
  });

  test("--watchdog-timeout=<ms> parses as a positive integer", () => {
    const parsed = parseCommand(["watch", "--watchdog-timeout=60000"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.watchdogTimeoutMs).toBe(60_000);
  });

  test("--watchdog-timeout (space form) requires a positive value", () => {
    const parsed = parseCommand(["watch", "--watchdog-timeout", "5000"]);
    if (parsed.kind !== "watch") throw new Error("expected watch");
    expect(parsed.options.watchdogTimeoutMs).toBe(5_000);
    expect(() => parseCommand(["watch", "--watchdog-timeout"])).toThrow(
      /missing value for --watchdog-timeout/,
    );
    expect(() => parseCommand(["watch", "--watchdog-timeout=0"])).toThrow(
      /invalid --watchdog-timeout/,
    );
    expect(() => parseCommand(["watch", "--watchdog-timeout=-50"])).toThrow(
      /invalid --watchdog-timeout/,
    );
  });

  test("UATU_DEBUG env var enables debug mode when --debug is absent", () => {
    const previous = process.env.UATU_DEBUG;
    process.env.UATU_DEBUG = "1";
    try {
      const parsed = parseCommand(["watch"]);
      if (parsed.kind !== "watch") throw new Error("expected watch");
      expect(parsed.options.debug).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.UATU_DEBUG;
      } else {
        process.env.UATU_DEBUG = previous;
      }
    }
  });

  test("usage documents the diagnostic flags", () => {
    const text = usageText();
    expect(text).toContain("--debug");
    expect(text).toContain("--no-watchdog");
    expect(text).toContain("--watchdog-timeout");
  });
});

describe("createStatePayload", () => {
  test("omits startupMode when not provided", () => {
    const payload = createStatePayload([], true, null, { kind: "folder" }, []);
    expect("startupMode" in payload).toBe(false);
  });

  test("includes startupMode when provided", () => {
    const payload = createStatePayload([], false, null, { kind: "folder" }, [], "review");
    expect(payload.startupMode).toBe("review");
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

  test("prints and clears indexing status when stdout is a TTY", () => {
    const chunks: string[] = [];
    const clear = printIndexingStatus([{ kind: "dir", absolutePath: "/repo" }], {
      isTTY: true,
      write: chunk => chunks.push(chunk),
    });

    expect(chunks.join("")).toContain("Indexing /repo...");
    clear();
    expect(chunks.join("")).toContain("\r");
  });

  test("writes no indexing status when stdout is not a TTY", () => {
    const chunks: string[] = [];
    const clear = printIndexingStatus([{ kind: "dir", absolutePath: "/repo" }], {
      isTTY: false,
      write: chunk => chunks.push(chunk),
    });

    clear();
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
    expect(rendered.html).toContain('<pre class="uatu-source-pre"><code class="hljs language-yaml">');
    expect(rendered.kind).toBe("text");
    expect(rendered.view).toBe("source");
    expect(rendered.language).toBe("yaml");
  });

  test("renders an asciidoc document through the asciidoc pipeline", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-adoc-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.adoc");
    await writeFile(filePath, "= Hello\n\nworld\n\nNOTE: heads up\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath);
    expect(rendered.kind).toBe("asciidoc");
    expect(rendered.language).toBeNull();
    expect(rendered.title).toBe("Hello");
    expect(rendered.html).toContain("admonitionblock");
    expect(rendered.html).toContain("<p>world</p>");
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

  test("source view of a markdown document returns verbatim text in a uatu-source-pre block", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-md-source-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    const verbatim = "# Hello\n\nworld\n";
    await writeFile(filePath, verbatim);

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath, { view: "source" });
    expect(rendered.title).toBe("README.md");
    expect(rendered.kind).toBe("markdown");
    expect(rendered.view).toBe("source");
    expect(rendered.language).toBe("markdown");
    expect(rendered.html).toContain('<pre class="uatu-source-pre">');
    // Verbatim source must be present (entity-encoded) — markdown markup is
    // displayed, not parsed.
    expect(rendered.html).toContain("# Hello");
    // Rendered HTML for the markdown body MUST NOT appear in source view.
    expect(rendered.html).not.toContain("<p>world</p>");
  });

  test("source view of an asciidoc document returns verbatim text in a uatu-source-pre block", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-adoc-source-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.adoc");
    await writeFile(filePath, "= Hello\n\nworld\n\nNOTE: heads up\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath, { view: "source" });
    expect(rendered.title).toBe("README.adoc");
    expect(rendered.kind).toBe("asciidoc");
    expect(rendered.view).toBe("source");
    expect(rendered.language).toBe("asciidoc");
    expect(rendered.html).toContain('<pre class="uatu-source-pre">');
    expect(rendered.html).toContain("= Hello");
  });

  test("rendered view of a markdown document returns parsed HTML and the rendered view marker", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-md-rendered-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "README.md");
    await writeFile(filePath, "# Hello\n\nworld\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath, { view: "rendered" });
    expect(rendered.kind).toBe("markdown");
    expect(rendered.view).toBe("rendered");
    expect(rendered.html).toContain("<p>world</p>");
    expect(rendered.html).not.toContain("uatu-source-pre");
  });

  test("source view forced for text/source files even when rendered is requested", async () => {
    // Text/source files have no separate rendered representation, so a
    // request for view=rendered still produces source rendering.
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-render-text-rendered-"));
    tempDirectories.push(tempDirectory);
    const filePath = path.join(tempDirectory, "config.yaml");
    await writeFile(filePath, "key: value\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const rendered = await renderDocument(roots, filePath, { view: "rendered" });
    expect(rendered.kind).toBe("text");
    expect(rendered.view).toBe("source");
    expect(rendered.html).toContain('<pre class="uatu-source-pre">');
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

  test("resolveStaticFileRequest rejects path traversal via double-dot", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-traversal-"));
    tempDirectories.push(tempDirectory);

    const resolved = await resolveStaticFileRequest(
      "/../etc/passwd",
      [{ kind: "dir", absolutePath: tempDirectory }],
    );

    expect(resolved).toEqual({ status: "not-found" });
  });

  test("resolveStaticFileRequest rejects path traversal via percent-encoded dots", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-encoded-traversal-"));
    tempDirectories.push(tempDirectory);

    const resolved = await resolveStaticFileRequest(
      "/%2e%2e/secret.txt",
      [{ kind: "dir", absolutePath: tempDirectory }],
    );

    expect(resolved).toEqual({ status: "not-found" });
  });

  test("resolveStaticFileRequest rejects files hidden by ignore rules", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-ignore-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, ".gitignore"), "secret.txt\n");
    await writeFile(path.join(tempDirectory, "secret.txt"), "hidden\n");

    const resolved = await resolveStaticFileRequest(
      "/secret.txt",
      [{ kind: "dir", absolutePath: tempDirectory }],
      { respectGitignore: true },
    );

    expect(resolved).toEqual({ status: "not-found" });
  });

  test("resolveStaticFileRequest applies ignore rules to single-file watch assets", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-file-ignore-"));
    tempDirectories.push(tempDirectory);
    const readmePath = path.join(tempDirectory, "README.md");
    await writeFile(readmePath, "# Readme\n");
    await writeFile(path.join(tempDirectory, ".gitignore"), "secret.txt\n");
    await writeFile(path.join(tempDirectory, "secret.txt"), "hidden\n");

    const resolved = await resolveStaticFileRequest(
      "/secret.txt",
      [{ kind: "file", absolutePath: readmePath, parentDir: tempDirectory }],
      { respectGitignore: true },
    );

    expect(resolved).toEqual({ status: "not-found" });
  });

  test("resolveStaticFileRequest respects --no-gitignore", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-no-gitignore-"));
    tempDirectories.push(tempDirectory);
    const secretPath = path.join(tempDirectory, "hidden.txt");
    await writeFile(path.join(tempDirectory, ".gitignore"), "hidden.txt\n");
    await writeFile(secretPath, "visible when gitignore disabled\n");

    const resolved = await resolveStaticFileRequest(
      "/hidden.txt",
      [{ kind: "dir", absolutePath: tempDirectory }],
      { respectGitignore: false },
    );

    expect(resolved).toEqual({ status: "found", filePath: await realpath(secretPath) });
  });

  test("resolveStaticFileRequest rejects symlink escapes", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-symlink-"));
    const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-outside-"));
    tempDirectories.push(tempDirectory, outsideDirectory);
    const outsideFile = path.join(outsideDirectory, "outside.txt");
    await writeFile(outsideFile, "outside\n");
    await symlink(outsideFile, path.join(tempDirectory, "linked.txt"));

    const resolved = await resolveStaticFileRequest(
      "/linked.txt",
      [{ kind: "dir", absolutePath: tempDirectory }],
    );

    expect(resolved).toEqual({ status: "not-found" });
  });

  test("resolveStaticFileRequest rejects malformed URL encoding", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-bad-url-"));
    tempDirectories.push(tempDirectory);

    const resolved = await resolveStaticFileRequest(
      "/%GG",
      [{ kind: "dir", absolutePath: tempDirectory }],
    );

    expect(resolved).toEqual({ status: "not-found" });
  });

  test("resolveStaticFileRequest rejects secret-like files", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-static-secret-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, ".env.local"), "TOKEN=secret\n");

    const resolved = await resolveStaticFileRequest(
      "/.env.local",
      [{ kind: "dir", absolutePath: tempDirectory }],
    );

    expect(resolved).toEqual({ status: "not-found" });
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

  test("canSetFileScope rejects unknown, ignored, secret-like, and binary document ids", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-pin-invalid-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const ignored = path.join(tempDirectory, "ignored.txt");
    const secret = path.join(tempDirectory, ".env.local");
    const binary = path.join(tempDirectory, "logo.png");
    await writeFile(
      path.join(tempDirectory, ".uatu.json"),
      JSON.stringify({ tree: { exclude: ["ignored.txt"] } }),
    );
    await writeFile(readme, "# Readme\n");
    await writeFile(ignored, "ignored\n");
    await writeFile(secret, "TOKEN=secret\n");
    await writeFile(binary, "not really png");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);

    expect(canSetFileScope(roots, readme)).toBe(true);
    expect(canSetFileScope(roots, path.join(tempDirectory, "missing.md"))).toBe(false);
    expect(canSetFileScope(roots, ignored)).toBe(false);
    expect(canSetFileScope(roots, secret)).toBe(false);
    expect(canSetFileScope(roots, binary)).toBe(false);
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

  test("editing .uatu.json tree.exclude at runtime reapplies the new patterns", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-ignore-live-"));
    tempDirectories.push(tempDirectory);
    const readme = path.join(tempDirectory, "README.md");
    const lockfile = path.join(tempDirectory, "package-lock.json");
    const uatuJson = path.join(tempDirectory, ".uatu.json");
    await writeFile(readme, "# Readme\n");
    await writeFile(lockfile, "{}\n");
    await writeFile(uatuJson, JSON.stringify({ tree: { exclude: [] } }));

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

      await writeFile(uatuJson, JSON.stringify({ tree: { exclude: ["package-lock.json"] } }));
      await waitUntil(
        () => session.getRoots().flatMap(root => root.docs).every(doc => doc.id !== lockfile),
        4000,
      );

      await writeFile(uatuJson, JSON.stringify({ tree: { exclude: [] } }));
      await waitUntil(
        () => session.getRoots().flatMap(root => root.docs).some(doc => doc.id === lockfile),
        4000,
      );
    } finally {
      await session.stop();
    }
  });
});

describe("prefersHtmlNavigation", () => {
  test("returns true for a typical browser top-level navigation Accept header", () => {
    const request = new Request("http://localhost/doc.md", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
    });
    expect(prefersHtmlNavigation(request)).toBe(true);
  });

  test("returns false when Accept is */* only (curl default)", () => {
    const request = new Request("http://localhost/doc.md", {
      headers: { accept: "*/*" },
    });
    expect(prefersHtmlNavigation(request)).toBe(false);
  });

  test("returns false when Accept is missing", () => {
    const request = new Request("http://localhost/doc.md");
    expect(prefersHtmlNavigation(request)).toBe(false);
  });

  test("returns false for an <img> sub-resource Accept header", () => {
    const request = new Request("http://localhost/hero.svg", {
      headers: { accept: "image/avif,image/webp,*/*;q=0.8" },
    });
    expect(prefersHtmlNavigation(request)).toBe(false);
  });

  test("returns true when Accept lists text/html with q above other types", () => {
    const request = new Request("http://localhost/doc.md", {
      headers: { accept: "text/html;q=1.0,application/xml;q=0.5" },
    });
    expect(prefersHtmlNavigation(request)).toBe(true);
  });
});

describe("resolveViewableDocument", () => {
  test("returns the matching non-binary document for a known path", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-resolve-doc-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const doc = resolveViewableDocument("/README.md", roots);
    expect(doc?.relativePath).toBe("README.md");
    expect(doc?.kind).toBe("markdown");
  });

  test("returns null for a binary file even if it exists in the index", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-resolve-binary-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "logo.png"), "not really png");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    expect(resolveViewableDocument("/logo.png", roots)).toBeNull();
  });

  test("returns null for an unknown path", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-resolve-unknown-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    expect(resolveViewableDocument("/missing.md", roots)).toBeNull();
  });

  test("returns null for malformed percent-encoding", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-resolve-malformed-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    expect(resolveViewableDocument("/%GG", roots)).toBeNull();
  });

  test("decodes percent-encoded path segments before lookup", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-resolve-encoded-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "hello world.md"), "# Hi\n");

    const roots = await scanRoots([{ kind: "dir", absolutePath: tempDirectory }]);
    const doc = resolveViewableDocument("/hello%20world.md", roots);
    expect(doc?.relativePath).toBe("hello world.md");
  });
});

describe("Accept-based navigation dispatch", () => {
  const SHELL_MARKER = "<!-- spa-shell-test-marker -->";

  async function withDispatchServer<T>(
    rootDirectory: string,
    block: (origin: string) => Promise<T>,
  ): Promise<T> {
    const session = createWatchSession(
      [{ kind: "dir", absolutePath: rootDirectory }],
      true,
      { usePolling: true },
    );
    await session.start();
    await waitUntil(() => session.getRoots().some(root => root.docs.length >= 1));

    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        routes: {
          "/": () =>
            new Response(`<!doctype html><html><body>${SHELL_MARKER}</body></html>`, {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
        },
        fetch: async request => {
          const requestUrl = new URL(request.url);
          if (prefersHtmlNavigation(request)) {
            const doc = resolveViewableDocument(
              requestUrl.pathname,
              session.getUnscopedRoots(),
            );
            if (doc) {
              return await spaShellResponse(server!);
            }
          }
          const response = await staticFileResponse(requestUrl.pathname, [
            { kind: "dir", absolutePath: rootDirectory },
          ]);
          if (response) {
            return response;
          }
          return new Response("Not Found", { status: 404 });
        },
      });

      const origin = `http://${server.hostname}:${server.port}`;
      return await block(origin);
    } finally {
      server?.stop(true);
      await session.stop();
    }
  }

  test("HTML-preferring navigation to a known doc returns the SPA shell, not raw markdown", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-dispatch-shell-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/README.md`, {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain(SHELL_MARKER);
      expect(body).not.toContain("# Hello");
    });
  });

  test("Accept: */* request to the same path returns raw bytes via the static fallback", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-dispatch-raw-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/README.md`, {
        headers: { accept: "*/*" },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toBe("# Hello\n");
      expect(body).not.toContain(SHELL_MARKER);
    });
  });

  test("HTML-preferring navigation to a binary file falls through to the static fallback", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-dispatch-binary-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "logo.png"), "not really png");

    await withDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/logo.png`, {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toBe("not really png");
      expect(body).not.toContain(SHELL_MARKER);
    });
  });

  test("HTML-preferring navigation to an unknown path returns the static fallback's 404", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-dispatch-unknown-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Hello\n");

    await withDispatchServer(tempDirectory, async origin => {
      const response = await fetch(`${origin}/typo-not-a-real-doc`, {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        },
      });
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).not.toContain(SHELL_MARKER);
    });
  });
});

describe("buildWatcherIgnorePredicate", () => {
  test("ignores any path with a `.git` segment between it and a watched root", () => {
    const root = "/tmp/uatu-watch-root";
    const predicate = buildWatcherIgnorePredicate([root], new Map<string, IgnoreMatcher>());

    expect(predicate(path.join(root, ".git", "index.lock"))).toBe(true);
    expect(predicate(path.join(root, ".git", "refs", "heads", "main"))).toBe(true);
    expect(predicate(path.join(root, "nested", ".git", "HEAD"))).toBe(true);
  });

  test("does not ignore regular files outside `.git/`", () => {
    const root = "/tmp/uatu-watch-root";
    const predicate = buildWatcherIgnorePredicate([root], new Map<string, IgnoreMatcher>());

    expect(predicate(path.join(root, "README.md"))).toBe(false);
    expect(predicate(path.join(root, "src", "index.ts"))).toBe(false);
    // Substring-only matchers would false-positive on `something.git/`, so
    // verify the segment-equality check distinguishes those.
    expect(predicate(path.join(root, "something.git", "file.md"))).toBe(false);
  });

  test("returns false for paths outside any watched root", () => {
    const root = "/tmp/uatu-watch-root";
    const predicate = buildWatcherIgnorePredicate([root], new Map<string, IgnoreMatcher>());

    expect(predicate("/elsewhere/.git/index.lock")).toBe(false);
    expect(predicate("/elsewhere/README.md")).toBe(false);
  });

  test("defers to the per-root IgnoreMatcher for non-`.git` paths", () => {
    const root = "/tmp/uatu-watch-root";
    const matcherCache = new Map<string, IgnoreMatcher>();
    matcherCache.set(root, {
      shouldIgnore: (rel: string) => rel === "secret.txt",
      toChokidarIgnored: () => (testPath: string) =>
        path.relative(root, testPath) === "secret.txt",
    });
    const predicate = buildWatcherIgnorePredicate([root], matcherCache);

    expect(predicate(path.join(root, "secret.txt"))).toBe(true);
    expect(predicate(path.join(root, "README.md"))).toBe(false);
  });
});

describe("attachWatcherCrashGuard", () => {
  test("attaches an `error` listener so a synthetic EINVAL does not throw", () => {
    const emitter = new EventEmitter();
    attachWatcherCrashGuard(emitter);

    const synthetic = Object.assign(new Error("synthetic"), { code: "EINVAL" });
    // Without an `error` listener, EventEmitter throws synchronously on emit.
    // The listener installed by attachWatcherCrashGuard must absorb this.
    expect(() => emitter.emit("error", synthetic)).not.toThrow();
    expect(emitter.listenerCount("error")).toBeGreaterThan(0);
  });
});

describe("createWatchSession watcher resilience", () => {
  test("a synthetic EINVAL on the underlying watcher does not crash the host", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "uatu-watcher-resilience-"));
    tempDirectories.push(tempDirectory);
    await writeFile(path.join(tempDirectory, "README.md"), "# Readme\n");

    const entries = await resolveWatchRoots([tempDirectory], tempDirectory);
    const session = createWatchSession(entries, true, { respectGitignore: false });
    await session.start();

    try {
      const internal = (session as unknown as {
        _internalWatcher(): NodeJS.EventEmitter | null;
      })._internalWatcher();
      expect(internal).not.toBeNull();

      const synthetic = Object.assign(new Error("synthetic EINVAL on .git/index.lock"), {
        code: "EINVAL",
        errno: -22,
      });
      expect(() => internal!.emit("error", synthetic)).not.toThrow();
      expect(session.getRoots()).toBeDefined();
    } finally {
      await session.stop();
    }
  });
});

