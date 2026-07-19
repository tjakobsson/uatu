// System color-scheme tracking. CSS switches on its own via the
// `light-dark()` tokens in styles.css — this module exists for the
// surfaces that are NOT pure CSS (Mermaid theme inputs, the sidebar tree
// library) and for the `theme-color` meta, which browsers don't re-derive
// from the page. Wired once from shell/boot.ts, like the mono applier.

export type ColorScheme = "light" | "dark";

export type ColorSchemeListener = (scheme: ColorScheme) => void;

// The light value is the pre-existing brand navy from index.html — light
// appearance must not change with the theme system. The dark value is the
// dark chrome background (`:root` background in styles.css); keep in sync.
const THEME_COLOR: Record<ColorScheme, string> = {
  light: "#0a1c38",
  dark: "#0d1117",
};

export function themeColorFor(scheme: ColorScheme): string {
  return THEME_COLOR[scheme];
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

const listeners = new Set<ColorSchemeListener>();

let mediaQuery: MediaQueryList | undefined;

export function activeColorScheme(): ColorScheme {
  const query = mediaQuery ?? window.matchMedia(DARK_QUERY);
  return query.matches ? "dark" : "light";
}

/** Subscribe to scheme changes. Returns an unsubscribe function. */
export function onColorSchemeChange(listener: ColorSchemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Exposed for tests; production dispatch happens via the media listener. */
export function dispatchColorScheme(scheme: ColorScheme): void {
  for (const listener of listeners) {
    listener(scheme);
  }
}

function applyThemeColorMeta(scheme: ColorScheme): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = themeColorFor(scheme);
}

export function initColorSchemeTracking(): void {
  if (mediaQuery) {
    return;
  }
  mediaQuery = window.matchMedia(DARK_QUERY);
  applyThemeColorMeta(activeColorScheme());
  mediaQuery.addEventListener("change", () => {
    const scheme = activeColorScheme();
    applyThemeColorMeta(scheme);
    dispatchColorScheme(scheme);
  });
}
