// Diff view rendering. The single source of @pierre/diffs usage in the app —
// other code paths (Rendered / Source) MUST NOT import this module. Pierre and
// its Shiki highlighter are lazy-loaded on the first Pierre-path render so the
// initial bundle stays small for users who never open the Diff view.

import type { DiffStyle } from "./shared";

export type DocumentDiffPayload =
  | {
      kind: "text";
      baseRef: string;
      patch: string;
      bytes: number;
      addedLines: number;
      deletedLines: number;
      // When the server attached blob contents (small-enough files in a
      // git workspace) we feed them to Pierre's two-blob input so the
      // "N unmodified lines" chevrons can expand to arbitrary surrounding
      // context. Absent for large files, where Pierre falls back to the
      // patch-only metadata path.
      oldContents?: string;
      newContents?: string;
      oldPath?: string;
    }
  | { kind: "unchanged"; baseRef: string }
  | { kind: "binary"; baseRef: string }
  | { kind: "unsupported-no-git" };

// Performance cutoffs above which we skip Pierre entirely and render a
// lightweight escaped-HTML diff. Both are exported so tests can override.
export const DIFF_MAX_BYTES = 256 * 1024;
export const DIFF_MAX_LINES = 5000;

// Languages pre-loaded into Pierre's shared Shiki highlighter on first init.
// Mirrors the file-extension language map used by the source view; unknown
// languages fall back to Pierre's `text` plaintext path.
const PRELOADED_LANGS = [
  "text",
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "yaml",
  "markdown",
  "asciidoc",
  "python",
  "go",
  "rust",
  "shell",
  "css",
  "html",
];

type PierreModule = typeof import("@pierre/diffs");

let pierreModulePromise: Promise<PierreModule> | null = null;
let highlighterPromise: Promise<void> | null = null;
const loadedLangs = new Set<string>(PRELOADED_LANGS);

function getPierre(): Promise<PierreModule> {
  return (pierreModulePromise ??= import("@pierre/diffs"));
}

async function ensureHighlighter(): Promise<void> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const pierre = await getPierre();
    // Cast: Pierre types `langs` as a tightened BundledLanguage union;
    // our allowlist matches at runtime but uses plain string literals.
    await pierre.preloadHighlighter({
      themes: ["github-light"],
      langs: PRELOADED_LANGS as unknown as Parameters<typeof pierre.preloadHighlighter>[0]["langs"],
    });
  })();
  return highlighterPromise;
}

async function loadLanguage(lang: string): Promise<void> {
  if (loadedLangs.has(lang)) return;
  loadedLangs.add(lang);
  const pierre = await getPierre();
  await pierre.preloadHighlighter({
    themes: ["github-light"],
    langs: [lang] as unknown as Parameters<typeof pierre.preloadHighlighter>[0]["langs"],
  });
}

export type RenderDiffOptions = {
  // Default "unified" (stacked, classic git-diff layout). "split" puts
  // deletions and additions side-by-side inside Pierre.
  diffStyle?: DiffStyle;
  // Fired when the user clicks a segment of the in-host style toggle.
  // The app owns persistence and re-render — this module just renders
  // what it's told.
  onDiffStyleChange?: (next: DiffStyle) => void;
};

export async function renderDocumentDiff(
  host: HTMLElement,
  payload: DocumentDiffPayload,
  languageHint: string | null,
  options: RenderDiffOptions = {},
): Promise<void> {
  clearHost(host);

  switch (payload.kind) {
    case "unsupported-no-git":
      host.appendChild(stateCard("No git history available."));
      return;
    case "unchanged":
      host.appendChild(stateCard(`No changes against ${payload.baseRef}.`));
      return;
    case "binary":
      host.appendChild(stateCard(`Binary file changed against ${payload.baseRef}.`));
      return;
  }

  const exceedsBytes = payload.bytes >= DIFF_MAX_BYTES;
  const exceedsLines = payload.addedLines + payload.deletedLines >= DIFF_MAX_LINES;
  if (exceedsBytes || exceedsLines) {
    // Lightweight fallback renders a plain `<pre>` and has no notion of
    // a unified/split layout — the toolbar would do nothing here, so we
    // skip it. The state cards above are similarly toolbar-less.
    host.appendChild(renderLightweightFallback(payload.patch, exceedsBytes));
    return;
  }

  const diffStyle: DiffStyle = options.diffStyle ?? "unified";
  if (options.onDiffStyleChange) {
    host.appendChild(renderDiffStyleToggle(diffStyle, options.onDiffStyleChange));
  }
  const body = document.createElement("div");
  body.className = "uatu-diff-body";
  host.appendChild(body);
  await renderWithPierre(body, payload, languageHint, diffStyle);
}

async function renderWithPierre(
  host: HTMLElement,
  payload: Extract<DocumentDiffPayload, { kind: "text" }>,
  languageHint: string | null,
  diffStyle: DiffStyle,
): Promise<void> {
  // Anything thrown by Pierre or its Shiki peer is caught here and surfaced
  // as a state card so the user sees an explanation instead of an empty
  // pane. Without this guard, a render-time error in the dynamically loaded
  // dependency would leave `host` blank.
  try {
    const pierre = await getPierre();
    await ensureHighlighter();
    if (languageHint) {
      await loadLanguage(languageHint);
    }

    const diff = new pierre.FileDiff({
      theme: "github-light",
      diffStyle,
      lineDiffType: "word-alt",
      // Leave `expandUnchanged` unset (default false). The flag means
      // "show ALL unchanged regions pre-expanded", which would dump the
      // whole file into the diff view. With it off, the diff opens
      // collapsed with "N unmodified lines" chevrons. Clicking a chevron
      // is interactive by default whenever Pierre has the source to
      // expand to — i.e., the two-blob render path below.
    });

    // Two render paths, picked by what the server gave us:
    //
    //   - Both blobs present → feed `oldFile` + `newFile` so Pierre runs
    //     the diff itself and the chevrons can expand to any unchanged
    //     range. The header file names track the rename (oldPath → name).
    //
    //   - Patch-only fallback → parse the unified diff string and feed
    //     `fileDiff`. Chevrons render but expansion is bounded by whatever
    //     context git embedded in the patch (default ~3 lines).
    //
    // Pass `containerWrapper` (not `fileContainer`) in both cases: Pierre's
    // CSS lives in a `<diffs-container>` custom element that adopts the
    // stylesheet on construction; handing it our own `<div>` as
    // `fileContainer` skips that path and the diff renders unstyled.
    if (payload.oldContents !== undefined && payload.newContents !== undefined) {
      const newName = filenameFromPatch(payload.patch, "+++") ?? "file";
      const oldName = payload.oldPath ?? filenameFromPatch(payload.patch, "---") ?? newName;
      diff.render({
        oldFile: { name: oldName, contents: payload.oldContents },
        newFile: { name: newName, contents: payload.newContents },
        containerWrapper: host,
      });
    } else {
      const parsed = pierre.parsePatchFiles(payload.patch);
      const fileDiff = parsed[0]?.files[0];
      if (!fileDiff) {
        host.appendChild(stateCard("Diff could not be parsed."));
        return;
      }
      diff.render({ fileDiff, containerWrapper: host });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "render error";
    host.appendChild(stateCard(`Diff render failed: ${message}`));
  }
}

// Pull the `a/...` or `b/...` filename out of a unified diff's --- / +++
// header line. Returns null when the patch doesn't carry the expected
// shape (e.g. a wholly new file's `--- /dev/null`).
function filenameFromPatch(patch: string, prefix: "---" | "+++"): string | null {
  for (const line of patch.split("\n")) {
    if (!line.startsWith(`${prefix} `)) continue;
    const rest = line.slice(prefix.length + 1);
    if (rest === "/dev/null") return null;
    return rest.startsWith("a/") || rest.startsWith("b/") ? rest.slice(2) : rest;
  }
  return null;
}

function renderDiffStyleToggle(
  active: DiffStyle,
  onChange: (next: DiffStyle) => void,
): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "uatu-diff-toolbar";
  toolbar.setAttribute("role", "radiogroup");
  toolbar.setAttribute("aria-label", "Diff layout");

  const segments: Array<{ value: DiffStyle; label: string; title: string }> = [
    { value: "unified", label: "Unified", title: "Stacked layout (deletions then additions)" },
    { value: "split", label: "Split", title: "Side-by-side layout (deletions left, additions right)" },
  ];

  for (const segment of segments) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "uatu-diff-toolbar-segment";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(segment.value === active));
    button.setAttribute("data-style-value", segment.value);
    button.title = segment.title;
    button.textContent = segment.label;
    if (segment.value === active) {
      button.classList.add("is-active");
    }
    button.addEventListener("click", () => {
      if (segment.value === active) return;
      onChange(segment.value);
    });
    toolbar.appendChild(button);
  }

  return toolbar;
}

function stateCard(text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "uatu-diff-state";
  div.textContent = text;
  return div;
}

function renderLightweightFallback(patch: string, exceedsBytes: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "uatu-diff-fallback";

  const notice = document.createElement("div");
  notice.className = "uatu-diff-fallback-notice";
  notice.textContent = exceedsBytes
    ? "Large diff — rendered without syntax highlighting."
    : "Diff exceeds line cutoff — rendered without syntax highlighting.";
  wrap.appendChild(notice);

  const pre = document.createElement("pre");
  pre.className = "uatu-diff-fallback-pre";
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const span = document.createElement("span");
    span.className = classForDiffLine(line);
    span.textContent = i === lines.length - 1 ? line : line + "\n";
    pre.appendChild(span);
  }
  wrap.appendChild(pre);

  return wrap;
}

function classForDiffLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "uatu-diff-line-header";
  if (line.startsWith("@@")) return "uatu-diff-line-hunk";
  if (line.startsWith("+")) return "uatu-diff-line-added";
  if (line.startsWith("-")) return "uatu-diff-line-deleted";
  return "uatu-diff-line-context";
}

function clearHost(host: HTMLElement): void {
  while (host.firstChild) {
    host.removeChild(host.firstChild);
  }
}

// Test-only escape hatch: forget cached Pierre module and highlighter so
// unit tests can assert lazy-load behavior between cases. Production code
// MUST NOT call this.
export function __resetDiffViewCachesForTests(): void {
  pierreModulePromise = null;
  highlighterPromise = null;
  loadedLangs.clear();
  for (const lang of PRELOADED_LANGS) loadedLangs.add(lang);
}

// Test-only inspectors so unit tests can assert that the lazy caches are
// populated / unpopulated without re-importing the module.
export function __pierreModuleLoadedForTests(): boolean {
  return pierreModulePromise !== null;
}
export function __highlighterLoadedForTests(): boolean {
  return highlighterPromise !== null;
}
