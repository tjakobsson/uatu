// Maps a file name to the highlight.js language identifier the preview's code
// render path should use. Mirrors the shape of `file-icons.ts`: one entry per
// extension (or filename), trivially extensible. Resolution returns `undefined`
// for unmapped names — the render path falls back to escaped plain text.

const LANGUAGES_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".cts": "typescript",
  ".mts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
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
  ".jsonc": "json",
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
};

const LANGUAGES_BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
};

export function languageForName(name: string): string | undefined {
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
