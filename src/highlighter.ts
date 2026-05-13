import {
  getHighlighterIfLoaded,
  isHighlighterLoaded,
  preloadHighlighter,
  type DiffsHighlighter,
  type DiffsThemeNames,
} from "@pierre/diffs";
import { preloadFile } from "@pierre/diffs/ssr";

import { allConfiguredLanguages } from "./file-languages";

// One pair of themes drives both fenced-code rendering and the whole-file
// source view. They map onto uatu's existing light / dark preference signal
// (see `@pierre/diffs`'s `themeType` in BaseCodeOptions). github-light-default
// and github-dark-default match the visual language uatu shipped with hljs's
// GitHub theme, minimizing visual churn for existing users.
export const LIGHT_THEME: DiffsThemeNames = "github-light-default";
export const DARK_THEME: DiffsThemeNames = "github-dark-default";

let preloadPromise: Promise<void> | null = null;
let pierreDiffsCoreCSS: string | null = null;

// Kick off the shared Shiki highlighter load AND extract @pierre/diffs's
// per-render "core CSS" block into a single cached copy. Idempotent:
// subsequent callers during the same process get the same promise. Must be
// awaited before the HTTP server's "ready" announcement so the first preview
// request finds the highlighter resolved and the core-CSS endpoint warm.
//
// Why extract the CSS here: every `preloadFile` response inlines a
// ~38 KB `<style data-core-css>` block carrying the File component's grid +
// theme rules. Re-shipping it per source render is wasteful and slows large-
// file rendering noticeably. We do one throwaway preloadFile on a tiny
// payload to capture the block, then strip it from real renders and serve
// the cached copy from a single endpoint that the SPA shell links once.
export function preloadCodeHighlighter(): Promise<void> {
  if (preloadPromise) {
    return preloadPromise;
  }
  preloadPromise = (async () => {
    await preloadHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: allConfiguredLanguages(),
    });
    // Warmup render — the FileContents only needs `name` + `contents`; the
    // result's prerenderedHTML carries the inline core-CSS block we want.
    const warmup = await preloadFile({
      file: { name: "uatu-warmup.txt", contents: "" },
      options: { themeType: "light", disableFileHeader: true },
    });
    const match = warmup.prerenderedHTML.match(
      /<style data-core-css[^>]*>([\s\S]*?)<\/style>/,
    );
    pierreDiffsCoreCSS = match ? match[1] : "";
  })();
  return preloadPromise;
}

// Cached copy of @pierre/diffs's File-component grid + theme CSS, served from
// a single endpoint and linked once in the SPA shell. Same lifecycle as the
// highlighter preload — call sites are expected to be downstream of the
// HTTP "ready" gate (cli.ts awaits `preloadCodeHighlighter()` before binding).
export function getPierreDiffsCoreCSS(): string {
  if (pierreDiffsCoreCSS === null) {
    throw new Error(
      "pierre-diffs core CSS not loaded — preloadCodeHighlighter() must be awaited first",
    );
  }
  return pierreDiffsCoreCSS;
}

// Synchronous check used by the test that asserts the first preview request
// pays no grammar-load cost. Mirrors @pierre/diffs's own check rather than
// re-implementing it.
export function isCodeHighlighterReady(): boolean {
  return isHighlighterLoaded(getHighlighterIfLoaded());
}

// Synchronous access for render paths that run after the preload has been
// awaited. Throws if called before `preloadCodeHighlighter()` resolves —
// callers are expected to be downstream of the HTTP "ready" gate.
export function requireCodeHighlighter(): DiffsHighlighter {
  const h = getHighlighterIfLoaded();
  if (!h) {
    throw new Error(
      "code highlighter not loaded; preloadCodeHighlighter() must be awaited before rendering",
    );
  }
  return h;
}
