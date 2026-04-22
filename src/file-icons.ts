// Small registry of inline-SVG icons keyed by lowercased file extension.
// Visually inspired by Nerd Font glyphs (rounded square + mono glyph) so the
// look is consistent across file types as we add more. Adding a new extension
// is just a new entry in ICONS — no font loading, no runtime dependencies.

const MARKDOWN_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.6" /><path d="M3.5 10.5V6L5.5 8L7.5 6V10.5" /><path d="M11 6V10M11 10l1.5-1.5M11 10l-1.5-1.5" /></svg>`;

const GENERIC_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" /><path d="M9 2v3h3" /></svg>`;

const ICONS: Record<string, string> = {
  ".md": MARKDOWN_ICON,
  ".markdown": MARKDOWN_ICON,
};

export function fileIconForName(name: string): string {
  const lower = name.toLowerCase();
  for (const extension of Object.keys(ICONS)) {
    if (lower.endsWith(extension)) {
      return ICONS[extension] ?? GENERIC_ICON;
    }
  }
  return GENERIC_ICON;
}
