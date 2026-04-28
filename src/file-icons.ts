// Small registry of inline-SVG icons keyed by lowercased file extension or
// filename. Visually inspired by Nerd Font glyphs (rounded square + mono glyph)
// so the look is consistent across file types as we add more. Adding a new
// extension is just a new entry — no font loading, no runtime dependencies.

const MARKDOWN_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.6" /><path d="M3.5 10.5V6L5.5 8L7.5 6V10.5" /><path d="M11 6V10M11 10l1.5-1.5M11 10l-1.5-1.5" /></svg>`;

// "A" glyph for AsciiDoc — distinct from the Markdown "M" glyph.
const ASCIIDOC_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.6" /><path d="M4.5 10.5L6.5 6L8.5 10.5" /><path d="M5 9.2H8" /><path d="M10.5 6V10.5M10.5 6h2M10.5 8.2h1.5" /></svg>`;

const CODE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.6" /><path d="M5.5 7L3.5 8.5L5.5 10" /><path d="M10.5 7L12.5 8.5L10.5 10" /><path d="M9 6.5L7 11" /></svg>`;

const CONFIG_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.6" /><circle cx="8" cy="8" r="1.5" /><path d="M8 5.5V4M8 12V10.5M5.5 8H4M12 8H10.5M6.2 6.2L5.2 5.2M10.8 10.8L9.8 9.8M6.2 9.8L5.2 10.8M10.8 5.2L9.8 6.2" /></svg>`;

const IMAGE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.6" /><circle cx="6" cy="7" r="1" /><path d="M3 11.5L6 9L9.5 11.5L13 8" /></svg>`;

const ARCHIVE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.6" /><path d="M8 5.5V12.5" stroke-dasharray="1 1.4" /></svg>`;

const GENERIC_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" /><path d="M9 2v3h3" /></svg>`;

const ICONS_BY_EXTENSION: Record<string, string> = {
  ".md": MARKDOWN_ICON,
  ".markdown": MARKDOWN_ICON,
  ".adoc": ASCIIDOC_ICON,
  ".asciidoc": ASCIIDOC_ICON,
  ".ts": CODE_ICON,
  ".tsx": CODE_ICON,
  ".js": CODE_ICON,
  ".jsx": CODE_ICON,
  ".cjs": CODE_ICON,
  ".mjs": CODE_ICON,
  ".py": CODE_ICON,
  ".rb": CODE_ICON,
  ".go": CODE_ICON,
  ".rs": CODE_ICON,
  ".java": CODE_ICON,
  ".kt": CODE_ICON,
  ".sh": CODE_ICON,
  ".bash": CODE_ICON,
  ".zsh": CODE_ICON,
  ".c": CODE_ICON,
  ".h": CODE_ICON,
  ".cpp": CODE_ICON,
  ".cc": CODE_ICON,
  ".hpp": CODE_ICON,
  ".cs": CODE_ICON,
  ".swift": CODE_ICON,
  ".php": CODE_ICON,
  ".lua": CODE_ICON,
  ".sql": CODE_ICON,
  ".html": CODE_ICON,
  ".htm": CODE_ICON,
  ".xml": CODE_ICON,
  ".css": CODE_ICON,
  ".scss": CODE_ICON,
  ".less": CODE_ICON,
  ".json": CONFIG_ICON,
  ".jsonc": CONFIG_ICON,
  ".yaml": CONFIG_ICON,
  ".yml": CONFIG_ICON,
  ".toml": CONFIG_ICON,
  ".ini": CONFIG_ICON,
  ".env": CONFIG_ICON,
  ".png": IMAGE_ICON,
  ".jpg": IMAGE_ICON,
  ".jpeg": IMAGE_ICON,
  ".gif": IMAGE_ICON,
  ".webp": IMAGE_ICON,
  ".ico": IMAGE_ICON,
  ".svg": IMAGE_ICON,
  ".bmp": IMAGE_ICON,
  ".avif": IMAGE_ICON,
  ".zip": ARCHIVE_ICON,
  ".tar": ARCHIVE_ICON,
  ".gz": ARCHIVE_ICON,
  ".7z": ARCHIVE_ICON,
  ".rar": ARCHIVE_ICON,
};

const ICONS_BY_FILENAME: Record<string, string> = {
  dockerfile: CONFIG_ICON,
  makefile: CONFIG_ICON,
  ".gitignore": CONFIG_ICON,
  ".uatuignore": CONFIG_ICON,
  ".editorconfig": CONFIG_ICON,
};

export function fileIconForName(name: string): string {
  const lower = name.toLowerCase();

  const byName = ICONS_BY_FILENAME[lower];
  if (byName) {
    return byName;
  }

  for (const extension of Object.keys(ICONS_BY_EXTENSION)) {
    if (lower.endsWith(extension)) {
      return ICONS_BY_EXTENSION[extension] ?? GENERIC_ICON;
    }
  }

  return GENERIC_ICON;
}
