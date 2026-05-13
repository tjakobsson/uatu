// Server-side rendering helpers for the @pierre/diffs File component.
//
// Two entry points:
//   - renderWholeFileCode(name, contents, lang?): full source-view rendering
//     via @pierre/diffs/ssr `preloadFile`. Returns prerendered HTML for the
//     whole-file `<pre data-file>` element plus the raw source the browser
//     needs to hand to `File.hydrate()`. The shared icon sprite is stripped
//     from the per-render output so it can be emitted once in the SPA shell
//     (otherwise repeated renders would collide on element IDs).
//   - renderInlineCode(source, lang): synchronous token-highlighted HTML for
//     embedding inside Markdown / AsciiDoc fenced blocks. Uses the shared
//     Shiki highlighter that `@pierre/diffs/preloadHighlighter` warmed at
//     server startup. No File chrome, no line numbers, no icon sprite.

import { preloadFile, type PreloadedFileResult } from "@pierre/diffs/ssr";
import type { BundledLanguage, ThemesType } from "@pierre/diffs";
import { SVGSpriteSheet } from "@pierre/diffs";

import {
  DARK_THEME,
  LIGHT_THEME,
  requireCodeHighlighter,
} from "./highlighter";

const THEMES: ThemesType = { light: LIGHT_THEME, dark: DARK_THEME };

const SPRITE_PATTERN = /<svg data-icon-sprite[^>]*>[\s\S]*?<\/svg>/;
// The inline core-CSS block is hoisted out and served from a single endpoint
// (`/_pierre/diffs-core.css`) so it loads once per browser session instead of
// being re-shipped ~38 KB per source-view response. See highlighter.ts for the
// extraction at startup and cli.ts/e2e-server.ts for the route registration.
const CORE_CSS_STYLE_PATTERN = /<style data-core-css[^>]*>[\s\S]*?<\/style>/;

// The SPA shell injects this once so per-render output can omit it without
// breaking <use href="#diffs-icon-..."> references.
export function diffsIconSpriteHtml(): string {
  return SVGSpriteSheet;
}

export type WholeFileRender = {
  // The prerendered HTML for the file's `<pre data-file>` element (plus the
  // adjacent theme `<style>` block that @pierre/diffs emits). Safe to set as
  // innerHTML of the source-view container.
  html: string;
  // FileContents shape consumed by `File.hydrate()` on the client. The
  // browser receives this via the document API alongside the rendered HTML
  // and feeds it into hydration to attach interactivity (gutter utility,
  // selection highlighting, future per-line features).
  hydration: {
    name: string;
    contents: string;
    lang: BundledLanguage | undefined;
  };
};

export async function renderWholeFileCode(
  name: string,
  contents: string,
  lang: BundledLanguage | undefined,
): Promise<WholeFileRender> {
  const file: PreloadedFileResult<unknown>["file"] = lang
    ? { name, contents, lang }
    : { name, contents };
  const result = await preloadFile({
    file,
    options: {
      theme: THEMES,
      themeType: "light",
      // uatu's preview header already shows the active document's title and
      // path above the body — letting the File component render its own
      // filename strip duplicates that chrome (and the strip's stacking
      // context punches through uatu's sticky preview-header blur). The full
      // header machinery comes back when the diff-view follow-on change
      // lands, where the per-file header carries useful metadata.
      disableFileHeader: true,
    },
  });
  // Strip both the icon sprite and the inline core-CSS block. The SPA shell
  // carries one canonical copy of the sprite (injected at boot via
  // `ensureDiffsIconSprite`) and pulls the core CSS once via a `<link>` to
  // `/_pierre/diffs-core.css`. Per-render output is now just the
  // <div class="uatu-source-pre"><pre data-file>…</pre></div> shape that
  // actually changes per file — saves ~38 KB of HTML on every source-view
  // response, with corresponding wins in CSSOM parse cost on the client.
  const html = result.prerenderedHTML
    .replace(SPRITE_PATTERN, "")
    .replace(CORE_CSS_STYLE_PATTERN, "");
  return {
    html,
    hydration: { name, contents, lang },
  };
}

// Synchronous highlight for fenced / inline blocks. The shared highlighter is
// already warm by the time render code runs (server startup awaits the
// preload), so this never pays grammar-load cost in the request path.
//
// `code.textContent` of the returned HTML contains the original source (no
// gutter, no line wrappers, no extra characters) — fenced blocks have no
// line-number requirements so we keep the structure flat for the existing
// copy-to-clipboard helper.
export function renderInlineCode(
  source: string,
  lang: BundledLanguage | undefined,
): string {
  const highlighter = requireCodeHighlighter();
  const safeLang = lang ? resolveLoadedLanguage(highlighter, lang) : "text";
  return highlighter.codeToHtml(source, {
    lang: safeLang,
    themes: THEMES,
    defaultColor: false,
  });
}

// Shiki throws if a language isn't loaded. uatu's preloaded set is bounded
// (see allConfiguredLanguages); anything outside that set — including the
// arbitrary info strings users sometimes write on fenced blocks — degrades to
// plain-text rendering rather than crashing the render.
function resolveLoadedLanguage(
  highlighter: ReturnType<typeof requireCodeHighlighter>,
  lang: BundledLanguage,
): BundledLanguage | "text" {
  const loaded = new Set(highlighter.getLoadedLanguages());
  return loaded.has(lang) ? lang : "text";
}
