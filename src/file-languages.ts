import type { BundledLanguage } from "@pierre/diffs";

// Maps a file name to a Shiki `BundledLanguage` identifier the preview's code
// render path passes to `@pierre/diffs`. One entry per extension (or filename),
// trivially extensible. Resolution returns `undefined` for unmapped names —
// the render path falls back to plain escaped text.

const LANGUAGES_BY_EXTENSION: Record<string, BundledLanguage> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".cts": "typescript",
  ".mts": "typescript",
  ".js": "javascript",
  ".jsx": "jsx",
  ".cjs": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".json": "json",
  ".jsonc": "jsonc",
  ".xml": "xml",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".toml": "toml",
  ".ini": "ini",
  ".sql": "sql",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".swift": "swift",
  ".lua": "lua",
  ".pl": "perl",
  ".r": "r",
  ".diff": "diff",
  ".patch": "diff",
  // Source-view of Markdown / AsciiDoc files uses these so the verbatim text
  // is highlighted as markup; the rendered (HTML) view does not depend on
  // these entries.
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "mdx",
  ".adoc": "asciidoc",
  ".asciidoc": "asciidoc",
};

const LANGUAGES_BY_FILENAME: Record<string, BundledLanguage> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
};

export function languageForName(name: string): BundledLanguage | undefined {
  const lower = name.toLowerCase();

  const byName = LANGUAGES_BY_FILENAME[lower];
  if (byName) {
    return byName;
  }

  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex <= 0) {
    return undefined;
  }

  return LANGUAGES_BY_EXTENSION[lower.slice(dotIndex)];
}

// The full set of languages this preview will ever ask Shiki to highlight.
// Used by the server-side highlighter pre-warm so the first preview request
// finds every supported grammar already loaded.
export function allConfiguredLanguages(): BundledLanguage[] {
  const set = new Set<BundledLanguage>();
  for (const lang of Object.values(LANGUAGES_BY_EXTENSION)) set.add(lang);
  for (const lang of Object.values(LANGUAGES_BY_FILENAME)) set.add(lang);
  // Mermaid blocks are intercepted before highlighting, but include the
  // grammar so any `[source,mermaid]` listing that somehow slips past the
  // interception still renders as readable code rather than crashing the
  // request.
  set.add("mermaid");
  return [...set];
}
