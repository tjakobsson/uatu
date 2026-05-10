import { closeMermaidViewer, ensureMermaidViewer } from "./mermaid-viewer";
import { renderMermaidDiagrams, replaceMermaidCodeBlocks, type MermaidThemeInputs } from "./preview";
import { captureTerminalToken, mountTerminalPanel, type TerminalPanelHandle } from "./terminal";
import {
  TERMINAL_MAX_PANES,
  TERMINAL_RIGHT_DOCK_VIEWPORT_MIN,
  clampTerminalHeight as clampTerminalHeightShared,
  clampTerminalWidth as clampTerminalWidthShared,
  readTerminalPanelState,
  readTerminalVisiblePreference as readTerminalVisiblePreferenceShared,
  writeTerminalPanelState,
  writeTerminalVisiblePreference as writeTerminalVisiblePreferenceShared,
  type StorageLike,
  type TerminalDisplayMode,
  type TerminalDock,
  type TerminalPanelState,
  type TerminalPaneRecord,
} from "./terminal-pane-state";
import {
  createSelectionInspector,
  formatReference,
  type PaneState as InspectorPaneState,
  type SelectionInspector,
} from "./selection-inspector";
import {
  DEFAULT_MODE,
  defaultDocumentId,
  hasDocument,
  nextSelectedDocumentId,
  readModePreference,
  readViewModePreference,
  reviewBurdenHeadlineLabel,
  shouldRefreshPreview,
  writeModePreference,
  writeViewModePreference,
  type BuildSummary,
  type DocumentMeta,
  type Mode,
  type RepositoryReviewSnapshot,
  type RootGroup,
  type Scope,
  type StatePayload,
  type ViewMode,
} from "./shared";
import { nextStaleHint, type StaleHint } from "./stale-hint";
import { TreeView, type GitStatusForView } from "./tree-view";

type RenderedDocumentAuthor = { name: string; email?: string };

type RenderedDocumentMetadata = {
  title?: string;
  authors?: RenderedDocumentAuthor[];
  date?: string;
  revision?: string;
  description?: string;
  tags?: string[];
  status?: string;
  extras?: Record<string, string>;
};

type RenderedDocument = {
  id: string;
  title: string;
  path: string;
  html: string;
  kind: "markdown" | "asciidoc" | "text";
  view: ViewMode;
  language: string | null;
  metadata?: RenderedDocumentMetadata;
};

const SIDEBAR_COLLAPSED_KEY = "uatu:sidebar-collapsed";
const SIDEBAR_PANES_KEY_PREFIX = "uatu:sidebar-panes:";
const SIDEBAR_WIDTH_KEY = "uatu:sidebar-width";
const GIT_LOG_LIMIT_KEY = "uatu:git-log-limit";
// Persists the user's last open/closed choice for the document metadata card
// across documents and reloads. The expectation is "if I opened it once, I
// want to see it on every other doc too" — and the converse for closing.
const METADATA_CARD_OPEN_KEY = "uatu:metadata-card-open";

function readMetadataCardOpenPreference(): boolean {
  try {
    return window.localStorage.getItem(METADATA_CARD_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMetadataCardOpenPreference(open: boolean): void {
  try {
    window.localStorage.setItem(METADATA_CARD_OPEN_KEY, open ? "1" : "0");
  } catch {
    // best-effort persistence; localStorage may be disabled
  }
}

const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 620;
const ALL_PANE_DEFS = [
  { id: "change-overview", label: "Change Overview" },
  { id: "files", label: "Files" },
  { id: "git-log", label: "Git Log" },
  { id: "selection-inspector", label: "Selection Inspector" },
] as const;
type PaneId = (typeof ALL_PANE_DEFS)[number]["id"];
type PaneDef = (typeof ALL_PANE_DEFS)[number];
type PaneState = Record<PaneId, { visible: boolean; collapsed: boolean; height: number | null }>;

const AUTHOR_HIDDEN_PANES: ReadonlySet<PaneId> = new Set(["git-log", "selection-inspector"]);

const PANE_DEFS_BY_MODE: Record<Mode, readonly PaneDef[]> = {
  // Author hides Git Log (past commits are a Review concern) and Selection
  // Inspector (Author's Follow auto-switches the active preview, which would
  // routinely yank captured selections out from under the pane).
  author: ALL_PANE_DEFS.filter(pane => !AUTHOR_HIDDEN_PANES.has(pane.id)),
  review: ALL_PANE_DEFS,
};

function paneDefsForMode(mode: Mode): readonly PaneDef[] {
  return PANE_DEFS_BY_MODE[mode];
}

function paneStorageKeyForMode(mode: Mode): string {
  return `${SIDEBAR_PANES_KEY_PREFIX}${mode}`;
}
type PreviewMode =
  | { kind: "document" }
  | { kind: "review-score"; repositoryId: string }
  | { kind: "commit"; repositoryId: string; sha: string }
  | { kind: "empty" };
type CommitPreviewParams = { repositoryId: string; sha: string };
type CommitPreviewResolution =
  | {
      kind: "found";
      repository: RepositoryReviewSnapshot;
      commit: RepositoryReviewSnapshot["commitLog"][number];
    }
  | { kind: "missing-repository"; repositoryId: string; sha: string }
  | { kind: "missing-commit"; repository: RepositoryReviewSnapshot; sha: string };

const appShellElement = document.querySelector<HTMLDivElement>(".app-shell");
const previewBaseElement = document.querySelector<HTMLBaseElement>("#preview-base");
const treeElement = document.querySelector<HTMLDivElement>("#tree");
const treeEmptyMessageElement = document.querySelector<HTMLElement>("#tree-empty-message");
const changeOverviewElement = document.querySelector<HTMLDivElement>("#change-overview");
const gitLogElement = document.querySelector<HTMLDivElement>("#git-log");
const gitLogLimitElement = document.querySelector<HTMLSelectElement>("#git-log-limit");
const panelsToggleElement = document.querySelector<HTMLButtonElement>("#panels-toggle");
const panelsMenuElement = document.querySelector<HTMLDivElement>("#panels-menu");
const sidebarResizerElement = document.querySelector<HTMLDivElement>("#sidebar-resizer");
const previewElement = document.querySelector<HTMLElement>("#preview");
const previewTitleElement = document.querySelector<HTMLElement>("#preview-title");
const previewPathElement = document.querySelector<HTMLElement>("#preview-path");
const previewTypeElement = document.querySelector<HTMLElement>("#preview-type");
const followToggleElement = document.querySelector<HTMLButtonElement>("#follow-toggle");
const modeControlElement = document.querySelector<HTMLDivElement>("#mode-control");
const modeAuthorButton = document.querySelector<HTMLButtonElement>("#mode-author");
const modeReviewButton = document.querySelector<HTMLButtonElement>("#mode-review");
const viewControlElement = document.querySelector<HTMLDivElement>("#view-control");
const viewRenderedButton = document.querySelector<HTMLButtonElement>("#view-rendered");
const viewSourceButton = document.querySelector<HTMLButtonElement>("#view-source");
const previewShellElement = document.querySelector<HTMLElement>(".preview-shell");
const staleHintElement = document.querySelector<HTMLDivElement>("#stale-hint");
const staleHintMessageElement = document.querySelector<HTMLElement>("#stale-hint-message");
const staleHintActionElement = document.querySelector<HTMLButtonElement>("#stale-hint-action");
const documentCountElement = document.querySelector<HTMLElement>("#document-count");
const connectionStateElement = document.querySelector<HTMLElement>("#connection-state");
const connectionLabelElement = connectionStateElement?.querySelector<HTMLElement>(".connection-label") ?? null;
const buildBadgeElement = document.querySelector<HTMLElement>("#build-badge");
const sidebarCollapseElement = document.querySelector<HTMLButtonElement>("#sidebar-collapse");
const sidebarExpandElement = document.querySelector<HTMLButtonElement>("#sidebar-expand");
const selectionInspectorEmptyElement = document.querySelector<HTMLElement>(
  "[data-selection-inspector-empty]",
);
const selectionInspectorControlElement = document.querySelector<HTMLButtonElement>(
  "[data-selection-inspector-control]",
);
const selectionInspectorStatusElement = document.querySelector<HTMLElement>(
  "[data-selection-inspector-status]",
);

if (
  !appShellElement ||
  !previewBaseElement ||
  !treeElement ||
  !treeEmptyMessageElement ||
  !changeOverviewElement ||
  !gitLogElement ||
  !gitLogLimitElement ||
  !panelsToggleElement ||
  !panelsMenuElement ||
  !sidebarResizerElement ||
  !previewElement ||
  !previewTitleElement ||
  !previewPathElement ||
  !previewTypeElement ||
  !followToggleElement ||
  !modeControlElement ||
  !modeAuthorButton ||
  !modeReviewButton ||
  !viewControlElement ||
  !viewRenderedButton ||
  !viewSourceButton ||
  !previewShellElement ||
  !staleHintElement ||
  !staleHintMessageElement ||
  !staleHintActionElement ||
  !documentCountElement ||
  !connectionStateElement ||
  !connectionLabelElement ||
  !buildBadgeElement ||
  !sidebarCollapseElement ||
  !sidebarExpandElement ||
  !selectionInspectorEmptyElement ||
  !selectionInspectorControlElement ||
  !selectionInspectorStatusElement
) {
  throw new Error("uatu UI failed to initialize");
}

const appState = {
  roots: [] as RootGroup[],
  repositories: [] as RepositoryReviewSnapshot[],
  selectedId: null as string | null,
  previewMode: { kind: "document" } as PreviewMode,
  followEnabled: true,
  // Snapshot of the user's Follow choice while they were last in Author mode.
  // Captured when transitioning Author → Review (since Review forces Follow
  // off to honor the "no auto-switching" contract) and restored on the
  // reverse transition. Default `true` matches Author's natural default for
  // first-time users who boot directly into Review and then switch back.
  authorFollowPreference: true,
  // Author / Review posture. Resolved on boot from the CLI startupMode override
  // (when present) or persisted localStorage; falls back to DEFAULT_MODE.
  mode: DEFAULT_MODE as Mode,
  // Source / Rendered view preference for documents with a non-trivial
  // rendered representation (Markdown / AsciiDoc). Global, not per-document;
  // matches the persistence pattern of `mode` and Follow. Resolved on boot
  // from localStorage; defaults to "rendered". Files without a separate
  // rendered representation (text / source / code) ignore this — the server
  // forces source rendering for them.
  viewMode: readViewModePreference(safeLocalStorage()) as ViewMode,
  // Per-active-file stale-content hint state. Only set in Review mode; cleared
  // by manual navigation, mode switch back to Author, or refresh action.
  staleHint: null as StaleHint | null,
  scope: { kind: "folder" } as Scope,
  panes: readPaneState(DEFAULT_MODE),
  gitLogLimit: readGitLogLimitPreference(),
};

initSidebarCollapse();
initSidebarPanes();
initSidebarWidth();
initGitLogControls();
initInPageAnchorHandler();
initCrossDocAnchorHandler();

const selectionInspector: SelectionInspector = createSelectionInspector({
  previewElement,
  getActiveDocumentPath: activeDocumentPath,
  isSourceView: () => isPreviewSourceView(),
});
selectionInspector.subscribe(renderSelectionInspector);

function activeDocumentPath(): string | null {
  if (appState.previewMode.kind !== "document") {
    return null;
  }
  if (!appState.selectedId) {
    return null;
  }
  const doc = findDocumentById(appState.selectedId);
  return doc?.relativePath ?? null;
}

// Whether the active preview body is currently rendered as the whole-file
// source `<pre class="uatu-source-pre">` block. True for any view-mode that
// produces source rendering, including text/source files and Markdown /
// AsciiDoc when the user has flipped to Source view.
function isPreviewSourceView(): boolean {
  return previewElement.querySelector("pre.uatu-source-pre") !== null;
}

let copyResetTimeoutId: number | null = null;

function showCopyConfirmation(): void {
  selectionInspectorStatusElement.textContent = "Copied";
  if (copyResetTimeoutId !== null) {
    window.clearTimeout(copyResetTimeoutId);
  }
  copyResetTimeoutId = window.setTimeout(() => {
    selectionInspectorStatusElement.textContent = "";
    copyResetTimeoutId = null;
  }, 1000);
}

async function copyToClipboard(text: string): Promise<void> {
  // Prefer the modern API (works on localhost which is a secure context).
  // Fall back to a hidden-textarea + execCommand if the API is missing or
  // throws — defensive against locked-down browsers, even though uatu's
  // localhost target rarely hits that path.
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to legacy path below.
  }
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  scratch.select();
  try {
    document.execCommand("copy");
  } catch {
    // Best effort — swallow the error so the caller's `.then()` still
    // runs and the user sees the "Copied" flash. The localhost target
    // makes this fallback path rare in practice; if it ever fires AND
    // execCommand also fails, the user gets a false-positive
    // confirmation. Acceptable at this scale; revisit if real users
    // report broken pastes.
  } finally {
    document.body.removeChild(scratch);
  }
}

function renderSelectionInspector(state: InspectorPaneState): void {
  if (state.kind === "placeholder") {
    selectionInspectorEmptyElement.hidden = false;
    selectionInspectorControlElement.hidden = true;
    selectionInspectorControlElement.textContent = "";
    selectionInspectorControlElement.dataset.state = "placeholder";
    selectionInspectorControlElement.removeAttribute("title");
    return;
  }

  selectionInspectorEmptyElement.hidden = true;
  selectionInspectorControlElement.hidden = false;

  if (state.kind === "hint") {
    selectionInspectorControlElement.dataset.state = "hint";
    selectionInspectorControlElement.textContent =
      "Switch to Source view to capture a line range.";
    selectionInspectorControlElement.title =
      "Click to flip the preview to Source view, where line ranges can be captured.";
    return;
  }

  // state.kind === "reference"
  const label = formatReference(state.record);
  selectionInspectorControlElement.dataset.state = "reference";
  selectionInspectorControlElement.textContent = label;
  selectionInspectorControlElement.title = `Click to copy ${label} to the clipboard.`;
}

selectionInspectorControlElement.addEventListener("click", event => {
  event.preventDefault();
  const state = selectionInspector.current();
  if (state.kind === "hint") {
    applyViewMode("source");
    return;
  }
  if (state.kind === "reference") {
    void copyToClipboard(formatReference(state.record)).then(() => {
      showCopyConfirmation();
    });
  }
});

// Intercept clicks on in-page anchor links (`<a href="#x">`) in the preview and
// scroll the matching element into view directly. Letting the browser handle
// these natively would resolve them against `<base href>` (set per-document to
// the doc's directory so relative image URLs work), which means a TOC link
// inside e.g. `guides/setup.adoc` resolves to `/guides/#x` and triggers a full
// navigation to the server's static fallback — returning 404. Intercepting
// gives us same-document scroll regardless of the base href.
function initInPageAnchorHandler() {
  previewElement.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const anchor = target.closest("a");
    if (!anchor) {
      return;
    }
    const href = anchor.getAttribute("href");
    if (!href || !href.startsWith("#") || href === "#") {
      return;
    }
    // Don't override modifier-clicks the user explicitly intended (open in new
    // tab, etc.) — the browser will do something reasonable with the resolved
    // URL even if it's not a same-doc fragment.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    // decodeURIComponent throws URIError on malformed percent-sequences
    // (e.g. `#bad%GGid`). Treat that as "let the browser handle it" rather
    // than swallowing the click silently with an uncaught error.
    let id: string;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    const element = previewElement.querySelector(`[id="${cssEscape(id)}"]`);
    if (!(element instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function cssEscape(value: string): string {
  // Conservative escape for use inside [id="..."] attribute selectors. Only
  // backslashes and double quotes need escaping for that context.
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

// Intercept clicks on cross-document anchors (`<a href="other.adoc">`,
// `<a href="guides/setup.md">`, etc.) and switch the preview to the linked
// document via the existing in-app load path. Without this, the browser
// performs a full navigation to that URL — the static-file fallback then
// serves the raw `.adoc`/`.md` text (or triggers a download), bypassing the
// renderer entirely. We only intercept when the resolved URL maps to a
// non-binary document we know about; everything else (binary files,
// off-root paths, external URLs, modifier-clicks, target="_blank") falls
// through to the browser's default behavior.
function initCrossDocAnchorHandler() {
  previewElement.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const anchor = target.closest("a");
    if (!anchor) {
      return;
    }

    // Modifier-clicks → respect the user's intent (open in new tab, etc.).
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    // target="_blank" / "_parent" / etc. → don't override.
    const explicitTarget = anchor.getAttribute("target");
    if (explicitTarget && explicitTarget !== "_self") {
      return;
    }

    const rawHref = anchor.getAttribute("href");
    if (!rawHref) {
      return;
    }

    // Fragment-only links are handled by initInPageAnchorHandler.
    if (rawHref.startsWith("#")) {
      return;
    }

    // anchor.href is the DOM-resolved absolute URL (it already accounts for
    // the per-document `<base href>`), which is what we need to map back to a
    // document path.
    let resolved: URL;
    try {
      resolved = new URL(anchor.href);
    } catch {
      return;
    }

    // `URL.origin` is `"null"` for `mailto:`/`javascript:`/`blob:`/etc., and
    // `window.location.origin` is always an `http(s)://host` triple, so this
    // single check eliminates both off-origin URLs and non-http(s) protocols.
    if (resolved.origin !== window.location.origin) {
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(resolved.pathname);
    } catch {
      return;
    }
    const relativePath = pathname.replace(/^\/+/, "");
    if (!relativePath) {
      return;
    }

    const doc = findDocumentByRelativePath(relativePath);
    if (!doc) {
      return;
    }

    // Binary docs are non-clickable in the sidebar but a hand-authored link
    // to one (e.g. a PDF) should still let the browser fetch it.
    if (doc.kind === "binary") {
      return;
    }

    event.preventDefault();
    appState.followEnabled = false;
    appState.selectedId = doc.id;
    appState.previewMode = { kind: "document" };
    pushSelection(doc.id, doc.relativePath);
    syncFollowToggle();
    renderSidebar();
    void loadDocument(doc.id).then(() => {
      if (resolved.hash) {
        scrollToFragment(resolved.hash.slice(1));
      }
    });
  });
}

function findDocumentByRelativePath(relativePath: string): DocumentMeta | null {
  for (const root of appState.roots) {
    const doc = root.docs.find(candidate => candidate.relativePath === relativePath);
    if (doc) {
      return doc;
    }
  }
  return null;
}

function findDocumentById(documentId: string): DocumentMeta | null {
  for (const root of appState.roots) {
    const doc = root.docs.find(candidate => candidate.id === documentId);
    if (doc) {
      return doc;
    }
  }
  return null;
}

// Build a same-origin URL for a document. Per-segment percent-encoding mirrors
// the cross-doc handler's decode: each path segment is encoded individually so
// `/` separators stay as path separators and other special characters
// (spaces, unicode, `#`, `?`) are escaped.
function buildDocumentPath(relativePath: string): string {
  return "/" + relativePath.split("/").map(encodeURIComponent).join("/");
}

// Push a new history entry for a user-initiated selection change. No-op when
// the URL already matches the target — clicking the currently active doc
// must not grow the back stack.
function pushSelection(documentId: string, relativePath: string) {
  const url = buildDocumentPath(relativePath);
  if (window.location.pathname === url) {
    return;
  }
  window.history.pushState({ documentId }, "", url);
}

function pushReviewScore(repositoryId: string) {
  const url = new URL("/", window.location.origin);
  url.searchParams.set("reviewScore", repositoryId);
  const nextPath = `${url.pathname}${url.search}`;
  if (window.location.pathname === url.pathname && window.location.search === url.search) {
    return;
  }
  window.history.pushState({ reviewScoreRepositoryId: repositoryId }, "", nextPath);
}

function buildCommitPreviewPath(repositoryId: string, sha: string): string {
  const url = new URL("/", window.location.origin);
  url.searchParams.set("repository", repositoryId);
  url.searchParams.set("commit", sha);
  return `${url.pathname}${url.search}`;
}

function pushCommitPreview(repositoryId: string, sha: string) {
  const nextPath = buildCommitPreviewPath(repositoryId, sha);
  const currentPath = `${window.location.pathname}${window.location.search}`;
  if (currentPath === nextPath) {
    return;
  }
  window.history.pushState({ commitRepositoryId: repositoryId, commitSha: sha }, "", nextPath);
}

// Replace the current history entry with a new selection. Used for follow-mode
// auto-switches (so the URL stays accurate without polluting the back stack)
// and on initial boot (so `history.state` carries the document id for
// subsequent popstate resolution — the initial entry has `state === null`
// until we set it). The hash is preserved on the boot path so a deep link
// like `/guides/setup.md#installation` still scrolls to the named heading.
function replaceSelection(documentId: string, relativePath: string) {
  const url = buildDocumentPath(relativePath) + window.location.hash;
  window.history.replaceState({ documentId }, "", url);
}

function scrollToFragment(rawId: string) {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return;
  }
  // Headings emerge from sanitize with `user-content-` prefixed onto every
  // id; mirror the same prefix on incoming fragments so a `#section` link
  // lands on the prefixed heading id without authors having to know.
  const candidates = id.startsWith("user-content-") ? [id] : [`user-content-${id}`, id];
  for (const candidate of candidates) {
    const element = previewElement.querySelector(`[id="${cssEscape(candidate)}"]`);
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
}

followToggleElement.addEventListener("click", () => {
  if (appState.scope.kind === "file") {
    return;
  }
  const wasEnabled = appState.followEnabled;
  appState.followEnabled = !wasEnabled;
  syncFollowToggle();

  // Enabling follow should "catch up" to the latest changed file rather than
  // wait for the next change event — otherwise the user clicks Follow and
  // nothing visible happens until a file is touched.
  if (!wasEnabled && appState.followEnabled) {
    const latestId = defaultDocumentId(appState.roots);
    if (latestId && latestId !== appState.selectedId) {
      appState.selectedId = latestId;
      appState.previewMode = { kind: "document" };
      const latestDoc = findDocumentById(latestId);
      if (latestDoc) {
        pushSelection(latestId, latestDoc.relativePath);
      }
      renderSidebar();
      void loadDocument(latestId);
    }
  }
});

sidebarCollapseElement.addEventListener("click", () => setSidebarCollapsed(true));
sidebarExpandElement.addEventListener("click", () => setSidebarCollapsed(false));

gitLogElement.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const anchor = target.closest<HTMLAnchorElement>("a[data-repository-id][data-commit-sha]");
  if (!anchor) {
    return;
  }

  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    anchor.hasAttribute("download")
  ) {
    return;
  }

  const explicitTarget = anchor.getAttribute("target");
  if (explicitTarget && explicitTarget !== "_self") {
    return;
  }

  let resolved: URL;
  try {
    resolved = new URL(anchor.href);
  } catch {
    return;
  }
  if (resolved.origin !== window.location.origin) {
    return;
  }

  const repositoryId = anchor.dataset.repositoryId;
  const sha = anchor.dataset.commitSha;
  if (!repositoryId || !sha) {
    return;
  }

  event.preventDefault();
  applyStaleHint(nextStaleHint(appState.staleHint, { kind: "manual-navigation" }));
  activateCommitPreview({ repositoryId, sha }, { pushHistory: true });
});

changeOverviewElement.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest<HTMLButtonElement>("button[data-review-score-repository-id]");
  if (!button) {
    return;
  }

  const repository = appState.repositories.find(candidate => candidate.id === button.dataset.reviewScoreRepositoryId);
  if (!repository || repository.reviewLoad.status !== "available") {
    return;
  }

  appState.followEnabled = false;
  appState.selectedId = null;
  appState.previewMode = { kind: "review-score", repositoryId: repository.id };
  applyStaleHint(nextStaleHint(appState.staleHint, { kind: "manual-navigation" }));
  syncFollowToggle();
  pushReviewScore(repository.id);
  renderSidebar();
  renderReviewScoreDetails(repository);
});

function initGitLogControls() {
  gitLogLimitElement.value = String(appState.gitLogLimit);
  gitLogLimitElement.addEventListener("change", () => {
    const nextLimit = Number.parseInt(gitLogLimitElement.value, 10);
    appState.gitLogLimit = isGitLogLimit(nextLimit) ? nextLimit : 25;
    persistGitLogLimit();
    renderGitLog();
  });
}

// Handle browser back/forward navigation. The browser has already moved the
// URL by the time this fires, so we re-resolve the new pathname against the
// current root index and load that document — without ourselves pushing or
// replacing history. Follow mode is disabled here for the same reason a
// sidebar click disables it: a back press is an explicit navigation intent
// that would otherwise be immediately undone by the next file-change-driven
// auto-switch.
window.addEventListener("popstate", () => {
  if (appState.followEnabled) {
    appState.followEnabled = false;
    syncFollowToggle();
  }
  applyStaleHint(nextStaleHint(appState.staleHint, { kind: "manual-navigation" }));

  const reviewScoreRepositoryId = reviewScoreRepositoryIdFromUrl();
  if (reviewScoreRepositoryId) {
    const repository = appState.repositories.find(candidate => candidate.id === reviewScoreRepositoryId);
    appState.previewMode = { kind: "review-score", repositoryId: reviewScoreRepositoryId };
    appState.selectedId = null;
    renderSidebar();
    if (repository) {
      renderReviewScoreDetails(repository);
    } else {
      renderEmptyPreview("Review score unavailable", "Repository data is not available for this score view.");
    }
    return;
  }

  const commitPreview = commitPreviewParamsFromUrl();
  if (commitPreview) {
    activateCommitPreview(commitPreview, { pushHistory: false });
    return;
  }

  let urlRelativePath = "";
  try {
    urlRelativePath = decodeURIComponent(window.location.pathname).replace(/^\/+/, "");
  } catch {
    urlRelativePath = "";
  }

  if (!urlRelativePath) {
    const fallbackId = defaultDocumentId(appState.roots);
    if (fallbackId) {
      appState.selectedId = fallbackId;
      appState.previewMode = { kind: "document" };
      renderSidebar();
      void loadDocument(fallbackId);
    } else {
      appState.selectedId = null;
      appState.previewMode = { kind: "empty" };
      renderSidebar();
      renderEmptyPreview("No document selected", "Waiting for viewable files");
    }
    return;
  }

  const requestedDoc = findDocumentByRelativePath(urlRelativePath);
  if (requestedDoc && requestedDoc.kind !== "binary") {
    appState.selectedId = requestedDoc.id;
    appState.previewMode = { kind: "document" };
    renderSidebar();
    void loadDocument(requestedDoc.id).then(() => {
      if (window.location.hash) {
        scrollToFragment(window.location.hash.slice(1));
      }
    });
    return;
  }

  if (appState.scope.kind === "file") {
    const pinnedDoc = appState.selectedId ? findDocumentById(appState.selectedId) : null;
    renderSidebar();
    renderEmptyPreview(
      "Session pinned",
      pinnedDoc
        ? `Session pinned to ${pinnedDoc.relativePath}. Unpin to view other documents.`
        : "Session pinned to another file. Unpin to view other documents.",
    );
    return;
  }

  appState.selectedId = null;
  appState.previewMode = { kind: "empty" };
  renderSidebar();
  renderEmptyPreview("Document not found", `Document not found at ${urlRelativePath}.`);
});

function reviewScoreRepositoryIdFromUrl(): string | null {
  const value = new URL(window.location.href).searchParams.get("reviewScore");
  return value && value.trim() ? value : null;
}

function commitPreviewParamsFromUrl(): CommitPreviewParams | null {
  const url = new URL(window.location.href);
  if (url.pathname !== "/") {
    return null;
  }

  const repositoryId = url.searchParams.get("repository");
  const sha = url.searchParams.get("commit");
  if (!repositoryId || !repositoryId.trim() || !sha || !sha.trim()) {
    return null;
  }

  return { repositoryId, sha };
}

function resolveCommitPreview(params: CommitPreviewParams): CommitPreviewResolution {
  const repository = appState.repositories.find(candidate => candidate.id === params.repositoryId);
  if (!repository) {
    return { repositoryId: params.repositoryId, sha: params.sha, kind: "missing-repository" };
  }

  const commit = repository.commitLog.find(candidate => candidate.sha === params.sha);
  if (!commit) {
    return { kind: "missing-commit", repository, sha: params.sha };
  }

  return { kind: "found", repository, commit };
}

function activateCommitPreview(params: CommitPreviewParams, options: { pushHistory: boolean }) {
  appState.followEnabled = false;
  appState.selectedId = null;
  appState.previewMode = { kind: "commit", ...params };
  syncFollowToggle();
  if (options.pushHistory) {
    pushCommitPreview(params.repositoryId, params.sha);
  }
  renderSidebar();
  renderCommitPreview(params);
}

function renderCommitPreview(params: CommitPreviewParams) {
  const resolved = resolveCommitPreview(params);
  if (resolved.kind === "found") {
    renderCommitMessage(resolved.repository, resolved.commit);
    return;
  }

  renderCommitPreviewUnavailable(resolved);
}

function renderCommitPreviewUnavailable(resolved: Exclude<CommitPreviewResolution, { kind: "found" }>) {
  if (resolved.kind === "missing-repository") {
    renderEmptyPreview(
      "Commit preview unavailable",
      `Repository data is not available for commit ${resolved.sha}.`,
    );
    return;
  }

  renderEmptyPreview(
    "Commit preview unavailable",
    `Commit ${resolved.sha} is not available in the current Git Log data for ${resolved.repository.label}.`,
  );
}

// Pull the URL token into sessionStorage and strip it from `location.search`
// before anything else reads the URL. Pathname/hash are preserved.
captureTerminalToken();

// Inject PWA links at runtime rather than declaring them in index.html. Bun's
// HTML bundler tries to resolve every <link href="..."> as a build-time
// asset, but `/manifest.webmanifest` and `/assets/icon-*.png` are routes
// served by the uatu server — there's no source file to bundle. Adding them
// from JS bypasses the bundler entirely.
function injectPwaLinks() {
  if (typeof document === "undefined") return;
  const head = document.head;
  if (!head) return;
  if (head.querySelector('link[rel="manifest"]')) return;
  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "/manifest.webmanifest";
  head.appendChild(manifest);
  for (const size of ["192", "512"] as const) {
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.type = "image/png";
    icon.setAttribute("sizes", `${size}x${size}`);
    icon.href = `/assets/icon-${size}.png`;
    head.appendChild(icon);
  }
}
injectPwaLinks();

// Register the pass-through service worker so Edge/Chrome/Brave surface the
// PWA install affordance. Failures are logged once and otherwise ignored —
// uatu does not depend on the worker for any feature, only its presence.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch(error => {
        console.warn("uatu: service worker registration failed", error);
      });
  });
}

void loadInitialState();

async function loadInitialState() {
  // Decode the requested URL path BEFORE fetching state so we can decide
  // whether to honor the server's defaultDocumentId or override with a
  // URL-derived doc selection (direct-link arrival, per design D3).
  let urlRelativePath = "";
  try {
    urlRelativePath = decodeURIComponent(window.location.pathname).replace(/^\/+/, "");
  } catch {
    urlRelativePath = "";
  }
  // Capture the hash before our own `replaceSelection` (below) overwrites
  // the URL with a hashless version — otherwise the post-load fragment
  // scroll has nothing to scroll to.
  const initialHash = window.location.hash;

  const response = await fetch("/api/state");
  const payload = (await response.json()) as StatePayload;

  appState.roots = payload.roots;
  appState.repositories = payload.repositories ?? [];
  appState.scope = payload.scope;
  syncStateGeneration(payload.generatedAt);
  renderBuildBadge(payload.build);
  setupTerminalPanel(payload.terminal === "enabled", payload.terminalConfig);

  // Mode precedence: CLI --mode override (`startupMode` in the payload) wins
  // at boot, then the persisted browser preference, then DEFAULT_MODE. Whatever
  // we resolve here gets persisted so subsequent reloads are stable even when
  // the CLI flag was the source.
  const resolvedMode = readModePreference(safeLocalStorage(), payload.startupMode);
  appState.mode = resolvedMode;
  writeModePreference(safeLocalStorage(), resolvedMode);
  // Pane state is per-mode; load the resolved mode's persisted layout (the
  // initial `appState.panes` was a placeholder for DEFAULT_MODE).
  appState.panes = readPaneState(resolvedMode);
  syncModeControl();

  let directLinkMessage: { title: string; body: string } | null = null;
  const initialReviewScoreRepositoryId = reviewScoreRepositoryIdFromUrl();
  const initialCommitPreview = commitPreviewParamsFromUrl();

  if (initialReviewScoreRepositoryId) {
    appState.followEnabled = false;
    appState.selectedId = null;
    appState.previewMode = { kind: "review-score", repositoryId: initialReviewScoreRepositoryId };
  } else if (initialCommitPreview) {
    appState.followEnabled = false;
    appState.selectedId = null;
    appState.previewMode = { kind: "commit", ...initialCommitPreview };
  } else if (!urlRelativePath) {
    // Default boot at `/` — today's behavior.
    appState.followEnabled = payload.initialFollow;
    appState.selectedId = payload.defaultDocumentId;
    appState.previewMode = { kind: "document" };
  } else {
    const requestedDoc = findDocumentByRelativePath(urlRelativePath);
    if (requestedDoc && requestedDoc.kind !== "binary") {
      // Direct link to a known non-binary doc — force follow off (D3) and
      // override the server-provided default selection.
      appState.followEnabled = false;
      appState.selectedId = requestedDoc.id;
      appState.previewMode = { kind: "document" };
    } else if (payload.scope.kind === "file") {
      // Direct link to a doc outside the pinned scope. Keep the pinned doc
      // as the selection so the sidebar reflects it, but render a "session
      // pinned" message in place of the preview (per design D4).
      appState.followEnabled = false;
      appState.selectedId = payload.defaultDocumentId;
      appState.previewMode = { kind: "empty" };
      const pinnedDoc = appState.selectedId
        ? findDocumentById(appState.selectedId)
        : null;
      directLinkMessage = {
        title: "Session pinned",
        body: pinnedDoc
          ? `Session pinned to ${pinnedDoc.relativePath}. Unpin to view other documents.`
          : "Session pinned to another file. Unpin to view other documents.",
      };
    } else {
      // Direct link that doesn't resolve to any known doc in the index.
      appState.followEnabled = false;
      appState.selectedId = null;
      appState.previewMode = { kind: "empty" };
      directLinkMessage = {
        title: "Document not found",
        body: `Document not found at ${urlRelativePath}.`,
      };
    }
  }

  syncFollowToggle();
  renderSidebar();

  // Populate history.state with the document id so subsequent popstate
  // events have an unambiguous target without re-resolving the path each
  // time. The initial entry has `state === null` until we set it.
  if (appState.previewMode.kind === "document" && appState.selectedId) {
    const selected = findDocumentById(appState.selectedId);
    if (selected) {
      replaceSelection(appState.selectedId, selected.relativePath);
    }
  }

  if (appState.previewMode.kind === "review-score") {
    const repository = appState.repositories.find(candidate => candidate.id === appState.previewMode.repositoryId);
    if (repository && repository.reviewLoad.status === "available") {
      renderReviewScoreDetails(repository);
    } else {
      renderEmptyPreview("Review score unavailable", "Repository data is not available for this score view.");
    }
  } else if (appState.previewMode.kind === "commit") {
    renderCommitPreview(appState.previewMode);
  } else if (directLinkMessage) {
    renderEmptyPreview(directLinkMessage.title, directLinkMessage.body);
  } else if (appState.selectedId) {
    await loadDocument(appState.selectedId);
    if (initialHash) {
      // The browser hasn't laid out the freshly-rendered preview yet — defer
      // the scroll to the next frame so `scrollIntoView` has positions to
      // work with. Mirrors the TOC click path's timing (which only fires
      // after the preview is fully painted).
      requestAnimationFrame(() => scrollToFragment(initialHash.slice(1)));
    }
  }

  connectEvents();
}

function connectEvents() {
  const events = new EventSource("/api/events");

  events.addEventListener("open", () => {
    setConnectionState("live", "Online");
  });

  events.addEventListener("error", () => {
    setConnectionState("reconnecting", "Reconnecting");
  });

  events.addEventListener("state", async event => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as StatePayload;
    const previousSelectedId = appState.selectedId;
    const shouldReload = shouldRefreshPreview(previousSelectedId, payload.changedId);

    appState.roots = payload.roots;
    appState.repositories = payload.repositories ?? [];
    appState.scope = payload.scope;
    syncStateGeneration(payload.generatedAt);

    if (appState.previewMode.kind === "review-score") {
      renderSidebar();
      const repository = appState.repositories.find(candidate => candidate.id === appState.previewMode.repositoryId);
      if (repository && repository.reviewLoad.status === "available") {
        renderReviewScoreDetails(repository);
      } else {
        renderEmptyPreview("Review score unavailable", "Repository data is not available for this score view.");
      }
      return;
    }

    if (appState.previewMode.kind === "commit") {
      renderSidebar();
      renderCommitPreview(appState.previewMode);
      return;
    }

    // Review mode contract: file-system events MUST NOT switch the active
    // preview, and the active file MUST NOT silently re-render in place when
    // it changes on disk. Sidebar / Change Overview / Git Log refresh
    // normally; only preview selection and reload are gated. The reducer
    // computes the stale-content hint state so the reviewer can refresh on
    // their own clock.
    if (appState.mode === "review") {
      const activeId = appState.selectedId;
      const activeStillExists = activeId
        ? hasDocument(payload.roots, activeId)
        : true;
      applyStaleHint(
        nextStaleHint(appState.staleHint, {
          kind: "file-event",
          mode: "review",
          activeId,
          changedId: payload.changedId,
          activeStillExists,
        }),
      );
      renderSidebar();
      return;
    }

    appState.selectedId = nextSelectedDocumentId(
      payload.roots,
      previousSelectedId,
      payload.changedId,
      appState.followEnabled,
    );

    // Reveal the newly-selected file only when selection actually changed —
    // so a user-closed ancestor isn't re-opened by unrelated state updates.
    if (appState.selectedId && appState.selectedId !== previousSelectedId) {
      // Server-driven selection change (follow auto-switch, or current doc
      // was deleted and we fell back to the default). The URL must follow
      // what's on screen, but we use replaceState — pushing here would
      // pollute the back stack with file-change-driven entries the user
      // never asked for.
      const switched = findDocumentById(appState.selectedId);
      if (switched) {
        replaceSelection(appState.selectedId, switched.relativePath);
      }
    }

    renderSidebar();

    if (appState.selectedId && (shouldReload || appState.selectedId !== previousSelectedId)) {
      if (shouldReload) {
        // The file changed on disk — any cached payload is now stale.
        forgetDocumentCache(appState.selectedId);
      }
      await loadDocument(appState.selectedId);
      return;
    }

    if (!hasDocument(payload.roots, appState.selectedId)) {
      renderEmptyPreview("No document selected", "Waiting for viewable files");
    }
  });
}

function currentMermaidThemeInputs(): MermaidThemeInputs {
  // The active UI theme is light today. When the theme system lands, this
  // returns the inputs that match the active theme so diagrams stay coherent.
  return { theme: "default" };
}

function handleMermaidTriggerClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const trigger = target.closest<HTMLButtonElement>("button.mermaid-trigger");
  if (!trigger || !previewElement.contains(trigger)) {
    return;
  }
  const svg = trigger.querySelector<SVGElement>("svg");
  if (!svg) {
    return;
  }
  event.preventDefault();
  ensureMermaidViewer().open({ svg, returnFocusTo: trigger });
}

previewElement.addEventListener("click", handleMermaidTriggerClick);

// Per-document, per-view cache so toggling Source ↔ Rendered for an
// already-loaded document is instantaneous. Dropped entries are recreated on
// the next fetch; we drop a document's entry when navigating away to bound
// memory across long sessions.
type DocumentViewCacheEntry = { source?: RenderedDocument; rendered?: RenderedDocument };
const documentViewCache = new Map<string, DocumentViewCacheEntry>();

function rememberDocumentPayload(payload: RenderedDocument): void {
  const entry = documentViewCache.get(payload.id) ?? {};
  entry[payload.view] = payload;
  documentViewCache.set(payload.id, entry);
}

function forgetDocumentCache(documentId: string): void {
  documentViewCache.delete(documentId);
}

// Mount a fetched document payload into the preview body. Centralizes the
// DOM mutations that follow either a cache hit (toggle path) or a fresh
// network fetch (loadDocument).
async function applyDocumentPayload(payload: RenderedDocument): Promise<void> {
  appState.previewMode = { kind: "document" };
  previewTitleElement.textContent = payload.title;
  previewPathElement.textContent = payload.path;
  setPreviewType(payload);
  previewElement.classList.remove("empty");
  setPreviewBase(payload.path);
  closeMermaidViewer();
  const cardHtml = renderMetadataCard(payload.metadata);
  previewElement.innerHTML = cardHtml + replaceMermaidCodeBlocks(payload.html);
  attachMetadataCardToggleListener(previewElement);
  await renderMermaidDiagrams(previewElement, currentMermaidThemeInputs());
  // Source rendering — for text/source files always, and for markdown /
  // asciidoc when the user is in Source view — needs the line-number gutter
  // so the inspector pane can produce accurate `@path#L<a>-<b>` references.
  if (payload.view === "source") {
    attachLineNumbers(previewElement);
  }
  attachCopyButtons(previewElement);
  syncViewToggle(payload);
  // The previous document's content (and any selection within it) was just
  // replaced. Re-evaluate so the pane reflects the new state instead of a
  // stale capture from the prior document.
  selectionInspector.recompute();
}

// File extensions that uatu can render directly in the preview pane as an
// inline image. Kept conservative — formats that browsers reliably display
// via `<img>` without polyfills. SVGs are included; they're served as
// `image/svg+xml` by the static-file fallback and the browser sandboxes any
// `<script>` inside an SVG loaded through `<img>`, so no XSS risk.
const VIEWABLE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".avif",
  ".bmp",
]);

function isViewableImageName(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of VIEWABLE_IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

async function loadDocument(documentId: string) {
  // `loadDocument` always fetches fresh — callers that want the cached
  // payload for the active document should look it up themselves
  // (currently only `applyViewMode`, for instantaneous Source ↔ Rendered
  // toggling). The cache is bounded to one doc × two views, so a full
  // clear has the same effect as targeted purge + invalidate, with less
  // ceremony.
  documentViewCache.clear();

  // Binary files have no rendered representation through the document API.
  // Route them straight to a binary-specific preview: an inline `<img>` for
  // viewable image extensions, a "preview unavailable" notice otherwise.
  // Skipping the /api/document fetch also avoids the misleading 4xx error
  // path that used to surface as "The selected file no longer exists."
  const doc = findDocumentById(documentId);
  if (doc?.kind === "binary") {
    if (isViewableImageName(doc.name)) {
      renderImagePreview(doc);
    } else {
      renderBinaryUnavailable(doc);
    }
    return;
  }

  const response = await fetch(
    `/api/document?id=${encodeURIComponent(documentId)}&view=${encodeURIComponent(appState.viewMode)}`,
  );

  if (!response.ok) {
    appState.previewMode = { kind: "empty" };
    renderEmptyPreview("Document unavailable", "The selected file no longer exists.");
    return;
  }

  const payload = (await response.json()) as RenderedDocument;
  rememberDocumentPayload(payload);
  await applyDocumentPayload(payload);
}

function renderImagePreview(doc: DocumentMeta): void {
  closeMermaidViewer();
  setPreviewBase(doc.relativePath);
  previewTitleElement.textContent = doc.name;
  previewPathElement.textContent = doc.relativePath;
  clearPreviewType();
  hideViewToggle();
  previewElement.classList.remove("empty");
  // The browser resolves `./<name>` via the per-document `<base href>` set by
  // setPreviewBase, which already points at the document's directory under
  // the watched root — the same path the static-file fallback knows how to
  // serve. Encoded for safety against names with spaces / special chars.
  previewElement.innerHTML = `<div class="image-preview"><img alt="${escapeHtmlAttribute(doc.name)}" src="./${encodeURI(doc.name)}"></div>`;
  selectionInspector.recompute();
}

function renderBinaryUnavailable(doc: DocumentMeta): void {
  closeMermaidViewer();
  previewTitleElement.textContent = doc.name;
  previewPathElement.textContent = doc.relativePath;
  clearPreviewType();
  hideViewToggle();
  previewElement.classList.add("empty");
  previewElement.innerHTML = `<p>This file type isn't viewable in uatu.</p>`;
  selectionInspector.recompute();
}

function attachMetadataCardToggleListener(container: HTMLElement): void {
  const card = container.querySelector<HTMLDetailsElement>(".metadata-card");
  if (!card) {
    return;
  }
  card.addEventListener("toggle", () => {
    writeMetadataCardOpenPreference(card.open);
  });
}

function renderMetadataCard(metadata: RenderedDocumentMetadata | undefined): string {
  if (!metadata) {
    return "";
  }
  // The server has already passed every reachable string through escapeHtml,
  // so values are safe to drop into innerHTML directly. The structural shell
  // here uses fixed tag names — no author-controlled HTML reaches the DOM.
  const rows: string[] = [];

  if (metadata.title) {
    rows.push(curatedRow("Title", metadata.title));
  }
  if (metadata.authors && metadata.authors.length > 0) {
    const formatted = metadata.authors
      .map(author =>
        author.email
          ? `${author.name} <span class="metadata-card-email">&lt;${author.email}&gt;</span>`
          : author.name,
      )
      .join(", ");
    rows.push(curatedRow(metadata.authors.length === 1 ? "Author" : "Authors", formatted));
  }
  if (metadata.date) {
    rows.push(curatedRow("Date", metadata.date));
  }
  if (metadata.revision) {
    rows.push(curatedRow("Revision", metadata.revision));
  }
  if (metadata.description) {
    rows.push(curatedRow("Description", metadata.description));
  }
  if (metadata.tags && metadata.tags.length > 0) {
    const chips = metadata.tags
      .map(tag => `<span class="metadata-card-tag">${tag}</span>`)
      .join("");
    rows.push(`<div class="metadata-card-row"><span class="metadata-card-label">Tags</span><span class="metadata-card-value metadata-card-tags">${chips}</span></div>`);
  }
  if (metadata.status) {
    rows.push(curatedRow("Status", metadata.status));
  }
  if (metadata.extras) {
    for (const [key, value] of Object.entries(metadata.extras)) {
      rows.push(`<div class="metadata-card-row metadata-card-row-extra"><span class="metadata-card-label">${key}</span><span class="metadata-card-value">${value}</span></div>`);
    }
  }

  if (rows.length === 0) {
    return "";
  }

  // Collapsed-by-default disclosure with a deliberately spare summary —
  // "METADATA · N fields". Earlier iterations also surfaced a teaser of
  // the most-distinguishing fields, but it duplicated the body's <h1> and
  // added visual noise without telling the reader much they couldn't get
  // by simply opening the disclosure. The body shows the rows in a tight
  // key/value layout. Using <details>/<summary> means no JS for toggle
  // behaviour and the disclosure remains keyboard-accessible by default.
  const fieldCount = rows.length;
  const countLabel = fieldCount === 1 ? "1 field" : `${fieldCount} fields`;
  const openAttr = readMetadataCardOpenPreference() ? " open" : "";
  return `<details class="metadata-card" aria-label="Document metadata"${openAttr}>` +
    `<summary class="metadata-card-summary">` +
    `<span class="metadata-card-summary-label">Metadata</span>` +
    `<span class="metadata-card-summary-count">${countLabel}</span>` +
    `</summary>` +
    `<div class="metadata-card-body">${rows.join("")}</div>` +
    `</details>`;
}

function curatedRow(label: string, value: string): string {
  return `<div class="metadata-card-row"><span class="metadata-card-label">${label}</span><span class="metadata-card-value">${value}</span></div>`;
}

function renderCommitMessage(
  repository: RepositoryReviewSnapshot,
  commit: RepositoryReviewSnapshot["commitLog"][number],
) {
  closeMermaidViewer();
  previewTitleElement.textContent = commit.subject;
  previewPathElement.textContent = `${repository.label} · ${commit.sha}`;
  clearPreviewType();
  hideViewToggle();
  previewBaseElement.href = new URL("/", window.location.origin).toString();
  previewElement.classList.remove("empty");
  previewElement.innerHTML = `
    <section class="commit-preview">
      <header>
        <p>${escapeHtml([commit.author, commit.relativeTime].filter(Boolean).join(" · "))}</p>
        <code>${escapeHtml(commit.sha)}</code>
      </header>
      <pre>${escapeHtml(commit.message)}</pre>
    </section>
  `;
  selectionInspector.recompute();
}

// The score-explanation preview is Mode-independent by construction: this
// function takes only the load result and produces HTML, so there is no path
// for `appState.mode` (or any Mode-aware label) to influence its output. The
// regression test in app-score-explanation.test.ts asserts that property.
export function buildScoreExplanationHTML(load: RepositoryReviewSnapshot["reviewLoad"]): string {
  if (load.status !== "available") {
    return "";
  }
  const mechanicalDrivers = load.drivers.filter(driver => driver.kind === "mechanical");
  const warningDrivers = load.drivers.filter(driver => driver.kind === "warning");
  const highDelta = load.score - load.thresholds.high;
  const mediumDelta = load.score - load.thresholds.medium;
  const comparison =
    load.score >= load.thresholds.high
      ? `${highDelta} point${Math.abs(highDelta) === 1 ? "" : "s"} above the high threshold`
      : load.score >= load.thresholds.medium
        ? `${mediumDelta} point${Math.abs(mediumDelta) === 1 ? "" : "s"} above the medium threshold`
        : `${load.thresholds.medium - load.score} point${Math.abs(load.thresholds.medium - load.score) === 1 ? "" : "s"} below the medium threshold`;
  return `
    <section class="score-preview is-${escapeHtmlAttribute(load.level)}">
      <header>
        <div class="score-preview-total">
          <p class="score-preview-kicker">${escapeHtml(capitalize(load.level))} review burden</p>
          <h1>${escapeHtml(String(load.score))}</h1>
        </div>
        <dl>
          <div class="is-low"><dt>Low</dt><dd>&lt; ${escapeHtml(String(load.thresholds.medium))}</dd></div>
          <div class="is-medium"><dt>Medium</dt><dd>${escapeHtml(String(load.thresholds.medium))}-${escapeHtml(String(load.thresholds.high - 1))}</dd></div>
          <div class="is-high"><dt>High</dt><dd>&ge; ${escapeHtml(String(load.thresholds.high))}</dd></div>
        </dl>
      </header>
      <p>
        This is an additive review-burden index, not a percentage and not a code-quality score.
        It compares the current change against this repository's thresholds; this score is
        ${escapeHtml(comparison)}.
      </p>
      <h2>Mechanical Statistics</h2>
      ${renderScoreDriverList(mechanicalDrivers, "No mechanical review cost was detected.")}
      <h2>Configuration and Warnings</h2>
      ${renderReviewConfigurationList(warningDrivers, load.configuredAreas)}
    </section>
  `;
}

function renderReviewScoreDetails(repository: RepositoryReviewSnapshot) {
  const load = repository.reviewLoad;
  if (load.status !== "available") {
    return;
  }
  closeMermaidViewer();
  previewTitleElement.textContent = "Review burden score";
  previewPathElement.textContent = repository.label;
  clearPreviewType();
  hideViewToggle();
  previewBaseElement.href = new URL("/", window.location.origin).toString();
  previewElement.classList.remove("empty");
  previewElement.innerHTML = buildScoreExplanationHTML(load);
  selectionInspector.recompute();
}

function renderReviewConfigurationList(
  drivers: RepositoryReviewSnapshot["reviewLoad"]["drivers"],
  areas: RepositoryReviewSnapshot["reviewLoad"]["configuredAreas"],
): string {
  const items = [
    ...drivers.map(renderScoreDriverItem),
    ...areas.map(renderConfiguredAreaItem),
  ];
  if (items.length === 0) {
    return `<p class="pane-empty">No project-specific review scoring configuration or warnings are active for this change.</p>`;
  }

  return `
    <ul class="score-preview-list">
      ${items.join("")}
    </ul>
  `;
}

function renderScoreDriverList(
  drivers: RepositoryReviewSnapshot["reviewLoad"]["drivers"],
  emptyMessage: string,
): string {
  if (drivers.length === 0) {
    return `<p class="pane-empty">${escapeHtml(emptyMessage)}</p>`;
  }
  return `
    <ul class="score-preview-list">
      ${drivers.map(renderScoreDriverItem).join("")}
    </ul>
  `;
}

function renderScoreDriverItem(driver: RepositoryReviewSnapshot["reviewLoad"]["drivers"][number]): string {
  const score = driver.score > 0 ? `+${driver.score}` : String(driver.score);
  const files = driver.files.length > 0
    ? `<small>${escapeHtml(driver.files.slice(0, 8).join(", "))}${driver.files.length > 8 ? "..." : ""}</small>`
    : "";
  const help = mechanicalDriverHelp(driver.label);
  const helpMarkup = help
    ? `
      <span class="score-term-help" tabindex="0" aria-label="${escapeHtmlAttribute(`${driver.label}: ${help}`)}">
        ?
        <span class="score-term-tooltip" role="tooltip">${escapeHtml(help)}</span>
      </span>
    `
    : "";
  return `
    <li class="is-${escapeHtmlAttribute(driver.kind)}">
      <span>
        <span class="score-driver-label"><strong>${escapeHtml(driver.label)}</strong>${helpMarkup}</span>
        ${escapeHtml(driver.detail)}
        ${files}
      </span>
      <code>${escapeHtml(score)}</code>
    </li>
  `;
}

function renderConfiguredAreaItem(area: RepositoryReviewSnapshot["reviewLoad"]["configuredAreas"][number]): string {
  const score = area.score > 0 ? `+${area.score}` : String(area.score);
  const matchedCount = area.matchedFiles.length;
  const detail = matchedCount > 0
    ? `${capitalize(area.kind)} area matched ${matchedCount} file${matchedCount === 1 ? "" : "s"}`
    : `${capitalize(area.kind)} area configured; no files matched this change`;
  const extra = matchedCount > 0
    ? area.matchedFiles.slice(0, 8).join(", ") + (area.matchedFiles.length > 8 ? "..." : "")
    : `Patterns: ${area.paths.join(", ")}`;

  return `
    <li class="is-${escapeHtmlAttribute(area.kind)}">
      <span>
        <span class="score-driver-label"><strong>${escapeHtml(area.label)}</strong></span>
        ${escapeHtml(detail)}
        <small>${escapeHtml(extra)}</small>
      </span>
      <code>${escapeHtml(score)}</code>
    </li>
  `;
}

function mechanicalDriverHelp(label: string): string | null {
  switch (label) {
    case "Changed files":
      return "How many files changed and may need review.";
    case "Touched lines":
      return "How many lines were added or removed across those files.";
    case "Diff hunks":
      return "How many separate changed spots there are. One file can have several spots if edits are spread out.";
    case "Directory spread":
      return "How many top-level parts of the project are touched, such as src, tests, or docs.";
    case "Renames":
      return "Files that moved or changed name, which can take extra attention to follow.";
    case "Dependency/config files":
      return "Changes to setup, build, dependency, or CI files that can affect the project broadly.";
    default:
      return null;
  }
}

function readGitLogLimitPreference(): number {
  try {
    const value = Number(window.localStorage.getItem(GIT_LOG_LIMIT_KEY));
    if (isGitLogLimit(value)) {
      return value;
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
  return 25;
}

function persistGitLogLimit() {
  try {
    window.localStorage.setItem(GIT_LOG_LIMIT_KEY, String(appState.gitLogLimit));
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

function isGitLogLimit(value: number): value is 10 | 25 | 50 | 100 {
  return value === 10 || value === 25 || value === 50 || value === 100;
}

// Attach a line-number gutter to each <pre><code> in the container. The gutter
// is a sibling <span> of <code>, NOT a child — copy-to-clipboard reads
// `code.textContent` so line numbers are excluded automatically. `user-select:
// none` on the gutter also keeps mouse-selection of the code clean.
function attachLineNumbers(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLPreElement>("pre");
  blocks.forEach(pre => {
    const code = pre.querySelector<HTMLElement>("code");
    if (!code) {
      return;
    }
    if (pre.querySelector(".line-numbers")) {
      return;
    }

    const text = code.textContent ?? "";
    const lineCount = Math.max(1, text.replace(/\n$/, "").split("\n").length);
    const numbers = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");

    const gutter = document.createElement("span");
    gutter.className = "line-numbers";
    gutter.setAttribute("aria-hidden", "true");
    gutter.textContent = numbers;

    pre.classList.add("has-line-numbers");
    pre.insertBefore(gutter, code);
  });
}

function attachCopyButtons(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLPreElement>("pre");
  blocks.forEach(pre => {
    const code = pre.querySelector<HTMLElement>("code");
    if (!code) {
      return;
    }
    if (pre.querySelector(".code-copy")) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.setAttribute("aria-label", "Copy code to clipboard");
    button.title = "Copy to clipboard";
    button.textContent = "Copy";

    button.addEventListener("click", async event => {
      event.preventDefault();
      const text = code.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        flashCopyButton(button, "Copied!", "is-copied");
      } catch {
        flashCopyButton(button, "Failed", "is-failed");
      }
    });

    pre.appendChild(button);
  });
}

function flashCopyButton(button: HTMLButtonElement, label: string, modifier: string) {
  button.textContent = label;
  button.classList.add(modifier);
  window.setTimeout(() => {
    button.textContent = "Copy";
    button.classList.remove(modifier);
  }, 1500);
}

function setPreviewType(payload: RenderedDocument) {
  const baseLabel =
    payload.kind === "markdown"
      ? "markdown"
      : payload.kind === "asciidoc"
        ? "asciidoc"
        : payload.language ?? "text";
  // When the user has flipped a markdown / asciidoc document into source
  // view, surface that in the type badge so it is obvious why the body looks
  // different. Text / source files are always source-rendered and do not get
  // the suffix.
  const label =
    payload.view === "source" && (payload.kind === "markdown" || payload.kind === "asciidoc")
      ? `${baseLabel} (source)`
      : baseLabel;
  previewTypeElement.textContent = label;
  previewTypeElement.hidden = false;
}

function clearPreviewType() {
  previewTypeElement.textContent = "";
  previewTypeElement.hidden = true;
}

function setPreviewBase(relativePath: string) {
  // The preview's base href points at the document's directory so relative
  // references inside the markdown (e.g. <img src="./hero.svg">) resolve to
  // URLs the server's static file fallback already knows how to serve.
  const lastSlash = relativePath.lastIndexOf("/");
  const directory = lastSlash === -1 ? "" : relativePath.slice(0, lastSlash + 1);
  previewBaseElement.href = new URL(`/${directory}`, window.location.origin).toString();
}

// The library-backed tree view. Created lazily on first non-empty render so
// teardowns when the watched roots become empty don't leak a hidden instance.
let treeView: TreeView | null = null;

function ensureTreeView(): TreeView {
  if (treeView === null) {
    treeView = new TreeView({
      container: treeElement,
      onSelectDocument: handleTreeSelectDocument,
    });
  }
  return treeView;
}

function handleTreeSelectDocument(documentId: string): void {
  appState.followEnabled = false;
  appState.selectedId = documentId;
  appState.previewMode = { kind: "document" };
  applyStaleHint(nextStaleHint(appState.staleHint, { kind: "manual-navigation" }));
  const doc = findDocumentById(documentId);
  if (doc) {
    pushSelection(documentId, doc.relativePath);
  }
  syncFollowToggle();
  renderSidebar();
  void loadDocument(documentId);
}

function collectGitStatusEntries(repos: readonly RepositoryReviewSnapshot[]): GitStatusForView[] {
  const out: GitStatusForView[] = [];
  for (const repo of repos) {
    if (repo.reviewLoad.status !== "available") {
      continue;
    }
    for (const change of repo.reviewLoad.changedFiles) {
      const status = mapChangedFileStatus(change.status);
      if (!status) {
        continue;
      }
      // A repository can span multiple watched roots; emit one entry per root
      // so the annotation lands wherever the file is visible in the tree.
      for (const rootId of repo.watchedRootIds) {
        out.push({ relativePath: change.path, rootId, status });
      }
    }
  }
  return out;
}

function mapChangedFileStatus(raw: string): GitStatusForView["status"] | null {
  const head = (raw[0] ?? "").toUpperCase();
  switch (head) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "U":
    case "?":
      return "untracked";
    default:
      return null;
  }
}

function renderSidebar() {
  syncPaneDom();
  renderPanelsMenu();
  renderChangeOverview();
  renderGitLog();
  schedulePaneHeightNormalization();

  const totalCount = appState.roots.reduce((sum, root) => sum + root.docs.length, 0);
  const binaryCount = appState.roots.reduce(
    (sum, root) => sum + root.docs.filter(doc => doc.kind === "binary").length,
    0,
  );

  const segments = [`${totalCount} file${totalCount === 1 ? "" : "s"}`];
  if (binaryCount > 0) {
    segments.push(`${binaryCount} binary`);
  }
  documentCountElement.textContent = segments.join(" · ");

  if (totalCount === 0) {
    if (treeView !== null) {
      treeView.dispose();
      treeView = null;
    }
    // The library attaches a shadow root to #tree once mounted, and that
    // shadow root persists across innerHTML writes — so we keep the empty
    // message as a sibling element instead of overwriting #tree's children.
    treeElement.hidden = true;
    treeEmptyMessageElement.hidden = false;
    return;
  }

  treeElement.hidden = false;
  treeEmptyMessageElement.hidden = true;
  const view = ensureTreeView();
  view.update(appState.roots, appState.selectedId);
  view.setGitStatus(collectGitStatusEntries(appState.repositories));
}

function initSidebarPanes() {
  panelsToggleElement.addEventListener("click", () => {
    const expanded = panelsToggleElement.getAttribute("aria-expanded") === "true";
    panelsToggleElement.setAttribute("aria-expanded", String(!expanded));
    panelsMenuElement.hidden = expanded;
  });

  panelsMenuElement.addEventListener("change", event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const paneId = target.value as PaneId;
    if (!isPaneId(paneId)) {
      return;
    }
    appState.panes[paneId].visible = target.checked;
    if (target.checked) {
      appState.panes[paneId].collapsed = false;
    }
    persistPaneState(appState.mode);
    renderSidebar();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-pane-hide]").forEach(button => {
    button.addEventListener("click", () => {
      const paneId = button.dataset.paneHide as PaneId | undefined;
      if (!paneId || !isPaneId(paneId)) {
        return;
      }
      appState.panes[paneId].visible = false;
      persistPaneState(appState.mode);
      renderSidebar();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-pane-collapse]").forEach(button => {
    button.addEventListener("click", () => {
      const paneId = button.dataset.paneCollapse as PaneId | undefined;
      if (!paneId || !isPaneId(paneId)) {
        return;
      }
      appState.panes[paneId].collapsed = !appState.panes[paneId].collapsed;
      persistPaneState(appState.mode);
      renderSidebar();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-pane-resizer]").forEach(resizer => {
    resizer.addEventListener("pointerdown", event => {
      const paneId = resizer.dataset.paneResizer as PaneId | undefined;
      const pane = paneId ? document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`) : null;
      if (!paneId || !isPaneId(paneId) || !pane) {
        return;
      }
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      normalizePaneHeightsToStack();
      const startY = event.clientY;
      const startHeight = pane.getBoundingClientRect().height;
      const nextPane = nextVisiblePane(paneId);
      const nextStartHeight = nextPane?.getBoundingClientRect().height ?? 0;
      const totalHeight = startHeight + nextStartHeight;
      const minHeight = 72;

      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY;
        const maxHeight = nextPane ? totalHeight - minHeight : 520;
        const nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + delta));
        appState.panes[paneId].height = Math.round(nextHeight);
        if (nextPane) {
          const nextPaneId = nextPane.dataset.paneId as PaneId | undefined;
          if (nextPaneId && isPaneId(nextPaneId)) {
            appState.panes[nextPaneId].height = Math.round(totalHeight - nextHeight);
          }
        }
        syncPaneDom();
      };
      const onUp = () => {
        persistPaneState(appState.mode);
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
        resizer.removeEventListener("pointercancel", onUp);
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
      resizer.addEventListener("pointercancel", onUp);
    });
  });

  syncPaneDom();
  renderPanelsMenu();
}

function nextVisiblePane(paneId: PaneId): HTMLElement | null {
  const defs = paneDefsForMode(appState.mode);
  const index = defs.findIndex(pane => pane.id === paneId);
  for (const candidate of defs.slice(index + 1)) {
    const state = appState.panes[candidate.id];
    if (!state.visible || state.collapsed) {
      continue;
    }
    return document.querySelector<HTMLElement>(`[data-pane-id="${candidate.id}"]`);
  }
  return null;
}

function readPaneState(mode: Mode): PaneState {
  const fallback = defaultPaneState();
  try {
    const raw = window.localStorage.getItem(paneStorageKeyForMode(mode));
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<PaneState>;
    for (const pane of ALL_PANE_DEFS) {
      const value = parsed[pane.id];
      if (!value || typeof value !== "object") {
        continue;
      }
      fallback[pane.id] = {
        visible: typeof value.visible === "boolean" ? value.visible : fallback[pane.id].visible,
        collapsed: typeof value.collapsed === "boolean" ? value.collapsed : fallback[pane.id].collapsed,
        height: typeof value.height === "number" && Number.isFinite(value.height) ? value.height : null,
      };
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function defaultPaneState(): PaneState {
  return {
    "change-overview": { visible: true, collapsed: false, height: 210 },
    files: { visible: true, collapsed: false, height: null },
    "git-log": { visible: true, collapsed: false, height: 120 },
    "selection-inspector": { visible: true, collapsed: false, height: 160 },
  };
}

function persistPaneState(mode: Mode) {
  try {
    window.localStorage.setItem(paneStorageKeyForMode(mode), JSON.stringify(appState.panes));
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

function syncPaneDom() {
  const growPaneId = paneIdToGrow();
  const currentDefs = paneDefsForMode(appState.mode);
  const currentIds = new Set<PaneId>(currentDefs.map(pane => pane.id));
  for (const pane of ALL_PANE_DEFS) {
    const element = document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
    if (!element) {
      continue;
    }
    if (!currentIds.has(pane.id)) {
      // Pane is not in the active Mode's catalog — force-hide regardless of
      // its persisted visibility flag for this mode.
      element.hidden = true;
      element.style.removeProperty("flex");
      continue;
    }
    const state = appState.panes[pane.id];
    element.hidden = !state.visible;
    element.classList.toggle("is-collapsed", state.collapsed);
    if (state.height && !state.collapsed) {
      element.style.flex = `${pane.id === growPaneId ? 1 : 0} 1 ${state.height}px`;
    } else {
      element.style.removeProperty("flex");
    }
    const button = element.querySelector<HTMLButtonElement>("[data-pane-collapse]");
    if (button) {
      button.textContent = state.collapsed ? "+" : "−";
      button.setAttribute("aria-label", `${state.collapsed ? "Expand" : "Collapse"} ${pane.label}`);
    }
  }
}

function paneIdToGrow(): PaneId | null {
  const filesState = appState.panes.files;
  if (filesState.visible && !filesState.collapsed) {
    return "files";
  }
  const visible = paneDefsForMode(appState.mode).filter(pane => {
    const state = appState.panes[pane.id];
    return state.visible && !state.collapsed;
  });
  return visible.at(-1)?.id ?? null;
}

let paneNormalizationFrame = 0;

function schedulePaneHeightNormalization() {
  if (paneNormalizationFrame !== 0) {
    window.cancelAnimationFrame(paneNormalizationFrame);
  }
  paneNormalizationFrame = window.requestAnimationFrame(() => {
    paneNormalizationFrame = 0;
    normalizePaneHeightsToStack();
  });
}

function normalizePaneHeightsToStack() {
  const stack = document.querySelector<HTMLElement>(".pane-stack");
  if (!stack) {
    return;
  }

  const visibleExpanded = paneDefsForMode(appState.mode)
    .map(pane => ({
      id: pane.id,
      element: document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`),
      state: appState.panes[pane.id],
    }))
    .filter((pane): pane is { id: PaneId; element: HTMLElement; state: PaneState[PaneId] } =>
      Boolean(pane.element && pane.state.visible && !pane.state.collapsed),
    );

  if (visibleExpanded.length === 0) {
    return;
  }

  const collapsedHeight = paneDefsForMode(appState.mode).reduce((sum, pane) => {
    const state = appState.panes[pane.id];
    if (!state.visible || !state.collapsed) {
      return sum;
    }
    const element = document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
    return sum + (element?.getBoundingClientRect().height ?? 0);
  }, 0);
  const availableHeight = Math.max(0, stack.clientHeight - collapsedHeight);
  if (availableHeight <= 0) {
    return;
  }

  const minHeight = Math.min(72, Math.floor(availableHeight / visibleExpanded.length));
  const heights = new Map<PaneId, number>();
  for (const pane of visibleExpanded) {
    heights.set(pane.id, Math.max(minHeight, pane.state.height ?? pane.element.getBoundingClientRect().height));
  }

  const total = Array.from(heights.values()).reduce((sum, height) => sum + height, 0);
  if (total > availableHeight) {
    const scale = availableHeight / total;
    for (const [paneId, height] of heights) {
      heights.set(paneId, Math.max(minHeight, Math.floor(height * scale)));
    }
  }

  let normalizedTotal = Array.from(heights.values()).reduce((sum, height) => sum + height, 0);
  const growPaneId = paneIdToGrow() ?? visibleExpanded.at(-1)?.id;
  if (growPaneId && normalizedTotal < availableHeight) {
    heights.set(growPaneId, (heights.get(growPaneId) ?? minHeight) + (availableHeight - normalizedTotal));
    normalizedTotal = availableHeight;
  }

  for (const pane of visibleExpanded) {
    const height = heights.get(pane.id) ?? minHeight;
    pane.state.height = Math.round(height);
    pane.element.style.flex = `0 0 ${Math.round(height)}px`;
  }
}

function renderPanelsMenu() {
  panelsMenuElement.innerHTML = paneDefsForMode(appState.mode).map(pane => {
    const checked = appState.panes[pane.id].visible ? " checked" : "";
    return `
      <label class="panel-option">
        <input type="checkbox" value="${escapeHtmlAttribute(pane.id)}"${checked} />
        <span>${escapeHtml(pane.label)}</span>
      </label>
    `;
  }).join("");
}

function isPaneId(value: string): value is PaneId {
  return ALL_PANE_DEFS.some(pane => pane.id === value);
}

function renderChangeOverview() {
  if (appState.repositories.length === 0) {
    changeOverviewElement.innerHTML = `<div class="pane-empty">Repository data is unavailable.</div>`;
    return;
  }

  changeOverviewElement.innerHTML = appState.repositories
    .map(repository => {
      const meta = repository.metadata;
      if (meta.status !== "git" || repository.reviewLoad.status !== "available") {
        return `
          <section class="review-repo">
            <h3>${escapeHtml(repository.label)}</h3>
            <p class="pane-empty">${escapeHtml(meta.message ?? repository.reviewLoad.message ?? "No git repository is available.")}</p>
          </section>
        `;
      }

      const load = repository.reviewLoad;
      const baseLabel =
        load.base.ref && load.base.mode !== "dirty-worktree-only"
          ? `${load.base.ref} (${baseModeLabel(load.base.mode)})`
          : baseModeLabel(load.base.mode);
      const drivers = load.drivers.length > 0
        ? load.drivers.filter(driver => driver.kind !== "mechanical")
        : [];
      const visibleDrivers = drivers.length > 0
        ? `<ul class="score-drivers">${drivers.map(renderDriver).join("")}</ul>`
        : "";
      const warnings = load.settingsWarnings.map(warning => `<div class="config-warning">${escapeHtml(warning)}</div>`).join("");
      const ignored = load.ignoredFiles.length > 0
        ? `<div class="ignored-summary">${load.ignoredFiles.length} ignored file${load.ignoredFiles.length === 1 ? "" : "s"} excluded</div>`
        : "";

      return `
        <section class="review-repo">
          <h3>${escapeHtml(repository.label)}</h3>
          <dl class="repo-facts">
            <div><dt>Branch</dt><dd>${escapeHtml(meta.branch ?? `detached ${meta.commitShort ?? ""}`.trim())}</dd></div>
            <div><dt>Commit</dt><dd>${escapeHtml(meta.commitShort ?? "unknown")}</dd></div>
            <div><dt>Status</dt><dd>${meta.dirty ? "dirty" : "clean"}</dd></div>
            <div><dt>Base</dt><dd>${escapeHtml(baseLabel)}</dd></div>
          </dl>
          <button
            type="button"
            class="burden-meter is-${escapeHtmlAttribute(load.level)}"
            data-review-score-repository-id="${escapeHtmlAttribute(repository.id)}"
            aria-label="Show review burden score explanation for ${escapeHtmlAttribute(repository.label)}"
            title="Show score explanation"
          >
            <span class="burden-summary">
              <span class="burden-headline">${escapeHtml(reviewBurdenHeadlineLabel(appState.mode))}</span>
              <span class="burden-level">${escapeHtml(capitalize(load.level))}</span>
            </span>
            <strong>${load.score}</strong>
          </button>
          ${warnings}
          ${ignored}
          ${visibleDrivers}
        </section>
      `;
    })
    .join("");
}

function renderDriver(driver: RepositoryReviewSnapshot["reviewLoad"]["drivers"][number]): string {
  const score = driver.score > 0 ? `+${driver.score}` : String(driver.score);
  const files = driver.files.length > 0
    ? `<span class="driver-files">${escapeHtml(driver.files.slice(0, 3).join(", "))}${driver.files.length > 3 ? "…" : ""}</span>`
    : "";
  return `
    <li class="score-driver is-${escapeHtmlAttribute(driver.kind)}">
      <span class="driver-main"><strong>${escapeHtml(driver.label)}</strong><span>${escapeHtml(driver.detail)}</span>${files}</span>
      <code>${escapeHtml(score)}</code>
    </li>
  `;
}

function renderGitLog() {
  gitLogLimitElement.value = String(appState.gitLogLimit);

  if (appState.repositories.length === 0) {
    gitLogElement.innerHTML = `<div class="pane-empty">No commit log available.</div>`;
    return;
  }

  gitLogElement.innerHTML = appState.repositories.map(repository => {
    if (repository.metadata.status !== "git") {
      return `
        <section class="git-log-group">
          <h3>${escapeHtml(repository.label)}</h3>
          <p class="pane-empty">No git log for this watched root.</p>
        </section>
      `;
    }
    const commits = repository.commitLog.slice(0, appState.gitLogLimit);
    if (commits.length === 0) {
      return `
        <section class="git-log-group">
          <h3>${escapeHtml(repository.label)}</h3>
          <p class="pane-empty">No commits found.</p>
        </section>
      `;
    }
    return `
      <section class="git-log-group">
        <h3>${escapeHtml(repository.label)}</h3>
        <p class="git-log-count">${commits.length} of ${repository.commitLog.length} commits</p>
        <ol class="commit-log">
          ${commits.map(commit => `
            <li>
              <a
                href="${escapeHtmlAttribute(buildCommitPreviewPath(repository.id, commit.sha))}"
                data-repository-id="${escapeHtmlAttribute(repository.id)}"
                data-commit-sha="${escapeHtmlAttribute(commit.sha)}"
                title="Show full commit message"
              >
                <code>${escapeHtml(commit.sha)}</code>
                <span>${escapeHtml(commit.subject)}</span>
                <small>${escapeHtml([commit.author, commit.relativeTime].filter(Boolean).join(" · "))}</small>
              </a>
            </li>
          `).join("")}
        </ol>
      </section>
    `;
  }).join("");
}

function baseModeLabel(mode: RepositoryReviewSnapshot["reviewLoad"]["base"]["mode"]): string {
  switch (mode) {
    case "configured":
      return "configured base";
    case "remote-default":
      return "remote default";
    case "fallback":
      return "fallback base";
    case "dirty-worktree-only":
      return "dirty worktree only";
    case "unavailable":
      return "base unavailable";
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderEmptyPreview(title: string, body: string) {
  closeMermaidViewer();
  previewTitleElement.textContent = title;
  previewPathElement.textContent = body;
  clearPreviewType();
  hideViewToggle();
  previewElement.classList.add("empty");
  previewElement.innerHTML = `<p>${escapeHtml(body)}</p>`;
  // Any prior selection rooted in document content is now invalid and the
  // preview is no longer in document mode — clear the inspector pane.
  selectionInspector.recompute();
}

function syncFollowToggle() {
  const label = followToggleElement.querySelector<HTMLElement>(".chip-label");
  if (label) {
    label.textContent = "Follow";
  }

  const pinned = appState.scope.kind === "file";
  const reviewMode = appState.mode === "review";
  // Review mode does not auto-follow by contract — there is no scenario in
  // which the chip is interactive in Review, so hide it entirely rather than
  // showing a disabled control. Pinned still renders the chip (greyed) since
  // the user can resolve that state from elsewhere.
  followToggleElement.hidden = reviewMode;
  const pressed = appState.followEnabled && !pinned && !reviewMode;
  followToggleElement.setAttribute("aria-pressed", String(pressed));
  followToggleElement.classList.toggle("is-active", pressed);
  followToggleElement.classList.toggle("is-mode-disabled", reviewMode);
  followToggleElement.disabled = pinned || reviewMode;
  followToggleElement.title = reviewMode
    ? "Follow is unavailable in Review mode"
    : pinned
      ? "Unpin to re-enable follow mode"
      : pressed
        ? "Follow the latest changed document"
        : "Click to follow the latest changed document";
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function syncModeControl() {
  const isAuthor = appState.mode === "author";
  modeAuthorButton.setAttribute("aria-checked", String(isAuthor));
  modeAuthorButton.classList.toggle("is-active", isAuthor);
  modeReviewButton.setAttribute("aria-checked", String(!isAuthor));
  modeReviewButton.classList.toggle("is-active", !isAuthor);

  // Body / preview-shell classes drive the Mode-aware preview chrome.
  document.body.classList.toggle("is-mode-author", isAuthor);
  document.body.classList.toggle("is-mode-review", !isAuthor);
  previewShellElement.classList.toggle("is-mode-review", !isAuthor);
}

// Reflect the current view-mode preference and the active document's actual
// rendering on the Source / Rendered toggle. The toggle is hidden whenever
// the active document does not have a separate rendered representation
// (text / source / code files) and whenever the preview is not in document
// mode. The toggle is otherwise always present so the user can flip views.
function syncViewToggle(payload: RenderedDocument | null): void {
  const showToggle =
    payload !== null && (payload.kind === "markdown" || payload.kind === "asciidoc");
  viewControlElement.hidden = !showToggle;
  if (!showToggle) {
    return;
  }
  const isSource = appState.viewMode === "source";
  viewSourceButton.setAttribute("aria-checked", String(isSource));
  viewSourceButton.classList.toggle("is-active", isSource);
  viewRenderedButton.setAttribute("aria-checked", String(!isSource));
  viewRenderedButton.classList.toggle("is-active", !isSource);
}

// Hide the toggle for non-document previews (commit, review-score, empty).
function hideViewToggle(): void {
  viewControlElement.hidden = true;
}

function applyViewMode(next: ViewMode): void {
  if (appState.viewMode === next) {
    return;
  }
  appState.viewMode = next;
  writeViewModePreference(safeLocalStorage(), next);
  // Re-render the active document in the new view. Prefer the cached
  // payload when both representations are already in memory — this is what
  // makes Source ↔ Rendered toggling feel instantaneous and avoids a flash
  // of empty preview during the round-trip. Fall back to a network fetch
  // when the new view hasn't been loaded yet.
  if (appState.previewMode.kind !== "document" || !appState.selectedId) {
    return;
  }
  const cached = documentViewCache.get(appState.selectedId)?.[next];
  if (cached) {
    void applyDocumentPayload(cached);
    return;
  }
  void loadDocument(appState.selectedId);
}

viewRenderedButton.addEventListener("click", () => applyViewMode("rendered"));
viewSourceButton.addEventListener("click", () => applyViewMode("source"));

function applyStaleHint(next: StaleHint | null) {
  appState.staleHint = next;
  syncStaleHint();
}

function syncStaleHint() {
  const hint = appState.staleHint;
  if (!hint) {
    staleHintElement.hidden = true;
    staleHintElement.classList.remove("is-changed", "is-deleted");
    return;
  }
  staleHintElement.hidden = false;
  staleHintElement.classList.toggle("is-changed", hint.kind === "changed");
  staleHintElement.classList.toggle("is-deleted", hint.kind === "deleted");
  if (hint.kind === "deleted") {
    staleHintMessageElement.textContent = "This file no longer exists on disk.";
    staleHintActionElement.textContent = "Close";
    staleHintActionElement.setAttribute("aria-label", "Close stale preview and return to default");
    staleHintActionElement.title = "Close this preview";
  } else {
    staleHintMessageElement.textContent = "This file has changed on disk.";
    staleHintActionElement.textContent = "Refresh";
    staleHintActionElement.setAttribute("aria-label", "Refresh the active preview to current on-disk content");
    staleHintActionElement.title = "Refresh to load current on-disk content";
  }
}

function applyMode(next: Mode) {
  if (appState.mode === next) {
    return;
  }
  const previous = appState.mode;
  // Persist the OUTGOING mode's pane state before swapping, so user-driven
  // pane changes that haven't been written yet aren't lost on mode switch.
  persistPaneState(previous);
  appState.mode = next;
  writeModePreference(safeLocalStorage(), next);
  // Each mode keeps its own pane state — visibility, collapse, height — so
  // flipping the toggle restores the layout the user left in that mode.
  appState.panes = readPaneState(next);

  // Author <-> Review round-trip: snapshot Author's Follow choice on the way
  // out, restore it on the way back. Review must force Follow off (the
  // "no auto-switching" contract); without the snapshot, the user would
  // have to re-enable Follow every time they peek into Review and back.
  if (previous === "author" && next === "review") {
    appState.authorFollowPreference = appState.followEnabled;
    appState.followEnabled = false;
  } else if (previous === "review" && next === "author") {
    appState.followEnabled = appState.authorFollowPreference;
  }

  // Mode change clears any visible hint. When switching from Review (with a
  // hint pointed at the active doc) to Author, resolve the staleness eagerly
  // so the user doesn't briefly see dead content waiting for the next SSE.
  const activeHint =
    previous === "review" && appState.staleHint?.documentId === appState.selectedId
      ? appState.staleHint
      : null;

  applyStaleHint(nextStaleHint(appState.staleHint, { kind: "mode-changed", nextMode: next }));

  syncModeControl();
  syncFollowToggle();
  renderSidebar();
  schedulePaneHeightNormalization();

  if (next === "author" && activeHint && appState.selectedId) {
    if (activeHint.kind === "changed") {
      // The on-disk content changed while the user was in Review and a
      // stale hint was active. Drop the cached payload before reloading so
      // we don't serve the stale rendering.
      forgetDocumentCache(appState.selectedId);
      void loadDocument(appState.selectedId);
    } else {
      appState.selectedId = null;
      renderEmptyPreview("File no longer on disk", "The file you were viewing has been deleted.");
      renderSidebar();
    }
  }
}

modeAuthorButton.addEventListener("click", () => applyMode("author"));
modeReviewButton.addEventListener("click", () => applyMode("review"));

staleHintActionElement.addEventListener("click", () => {
  const hint = appState.staleHint;
  if (!hint) {
    return;
  }
  if (hint.kind === "deleted") {
    // Close: clear the preview and the hint. Switch to the empty state since
    // there's no on-disk content to render.
    applyStaleHint(nextStaleHint(hint, { kind: "refresh-action" }));
    appState.selectedId = null;
    appState.previewMode = { kind: "empty" };
    renderSidebar();
    renderEmptyPreview("File no longer on disk", "The file you were viewing has been deleted.");
    return;
  }
  // Changed: re-render the active preview to the latest content for the same file.
  applyStaleHint(nextStaleHint(hint, { kind: "refresh-action" }));
  if (appState.selectedId) {
    // The on-disk content is what triggered this hint — any cached payload
    // for the active doc is stale. Drop it so loadDocument refetches.
    forgetDocumentCache(appState.selectedId);
    void loadDocument(appState.selectedId);
  }
});

type ConnectionRawState = "live" | "reconnecting" | "connecting";

let connectionRawState: ConnectionRawState = "connecting";

function setConnectionState(state: ConnectionRawState, _label: string) {
  // The label argument is preserved for source-call clarity but the actual
  // display text is derived in syncConnectionDisplay.
  connectionRawState = state;
  syncConnectionDisplay();
}

function syncConnectionDisplay() {
  connectionStateElement.classList.remove("is-live", "is-reconnecting", "is-connecting");
  connectionStateElement.classList.add(`is-${connectionRawState}`);
  let label: string;
  let title: string;
  if (connectionRawState === "reconnecting") {
    label = "Reconnecting";
    title = "Reconnecting to the uatu backend";
  } else if (connectionRawState === "connecting") {
    label = "Connecting";
    title = "Connecting to the uatu backend";
  } else {
    label = "Connected";
    title = "Connected to the uatu backend";
  }
  connectionLabelElement.textContent = label;
  connectionStateElement.title = title;
}

function renderBuildBadge(build: BuildSummary) {
  buildBadgeElement.textContent = build.identifier;
  buildBadgeElement.title = build.release
    ? `Release build · ${build.commitSha}`
    : `Dev build on ${build.branch} · ${build.commitSha}`;
}

function initSidebarCollapse() {
  const stored = readCollapsedPreference();
  setSidebarCollapsed(stored, { persist: false });
}

function initSidebarWidth() {
  setSidebarWidth(readSidebarWidthPreference(), { persist: false });

  sidebarResizerElement.addEventListener("pointerdown", event => {
    if (appShellElement.classList.contains("is-sidebar-collapsed")) {
      return;
    }

    event.preventDefault();
    sidebarResizerElement.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-sidebar");

    const onMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(moveEvent.clientX);
    };
    const onUp = () => {
      document.body.classList.remove("is-resizing-sidebar");
      sidebarResizerElement.removeEventListener("pointermove", onMove);
      sidebarResizerElement.removeEventListener("pointerup", onUp);
      sidebarResizerElement.removeEventListener("pointercancel", onUp);
    };

    sidebarResizerElement.addEventListener("pointermove", onMove);
    sidebarResizerElement.addEventListener("pointerup", onUp);
    sidebarResizerElement.addEventListener("pointercancel", onUp);
  });
}

function readSidebarWidthPreference(): number {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(value)) {
      return clampSidebarWidth(value);
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
  return 300;
}

function setSidebarWidth(width: number, options: { persist?: boolean } = {}) {
  const nextWidth = clampSidebarWidth(width);
  document.documentElement.style.setProperty("--sidebar-width", `${nextWidth}px`);

  if (options.persist === false) {
    return;
  }

  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)));
}

function readCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setSidebarCollapsed(collapsed: boolean, options: { persist?: boolean } = {}) {
  appShellElement.classList.toggle("is-sidebar-collapsed", collapsed);
  sidebarCollapseElement.setAttribute("aria-expanded", String(!collapsed));
  sidebarExpandElement.setAttribute("aria-expanded", String(!collapsed));

  if (options.persist === false) {
    return;
  }

  try {
    if (collapsed) {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    } else {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

function syncStateGeneration(generatedAt: number) {
  document.body.dataset.stateGeneratedAt = String(generatedAt);
}

const TERMINAL_TOKEN_KEY_LOCAL = "uatu:terminal-token";

let terminalSetupRan = false;

const sessionStorageRef: StorageLike = window.sessionStorage;
const localStorageRef: StorageLike = window.localStorage;

function readTerminalVisiblePreference(): boolean {
  return readTerminalVisiblePreferenceShared(sessionStorageRef);
}

function writeTerminalVisiblePreference(visible: boolean): void {
  writeTerminalVisiblePreferenceShared(sessionStorageRef, visible);
}

function clampTerminalHeight(value: number): number {
  return clampTerminalHeightShared(value, window.innerHeight);
}

function clampTerminalWidth(value: number): number {
  return clampTerminalWidthShared(value, window.innerWidth);
}

type TerminalPaneEntry = {
  record: TerminalPaneRecord;
  handle: TerminalPanelHandle;
  element: HTMLElement;
  hostElement: HTMLElement;
  closeButton: HTMLButtonElement;
};

// `setupTerminalPanel` runs once at boot when the backend is enabled. It
// builds the controller closure and wires every header button + the sidebar
// toggle + keyboard shortcuts + the close-confirmation modal. The controller
// is the only thing that mutates panel state; UI handlers all funnel through
// its named methods so persistence and refit happen consistently.
function setupTerminalPanel(enabled: boolean, config?: { fontFamily?: string; fontSize?: number }) {
  if (terminalSetupRan) return;
  terminalSetupRan = true;

  if (!enabled) return;

  const panel = document.getElementById("terminal-panel");
  const panesContainer = document.getElementById("terminal-panes");
  const resizer = document.getElementById("terminal-resizer");
  const toggle = document.getElementById("terminal-toggle");
  const sidebarRow = document.querySelector<HTMLElement>(".sidebar-terminal-row");
  const splitButton = document.getElementById("terminal-split");
  const dockButton = document.getElementById("terminal-dock-toggle");
  const minimizeButton = document.getElementById("terminal-minimize");
  const fullscreenButton = document.getElementById("terminal-fullscreen");
  const closeButton = document.getElementById("terminal-close");
  const modal = document.getElementById("terminal-confirm");
  const modalCancel = document.getElementById("terminal-confirm-cancel");
  const modalAccept = document.getElementById("terminal-confirm-accept");
  if (
    !panel ||
    !panesContainer ||
    !resizer ||
    !toggle ||
    !sidebarRow ||
    !splitButton ||
    !dockButton ||
    !minimizeButton ||
    !fullscreenButton ||
    !closeButton ||
    !modal ||
    !modalCancel ||
    !modalAccept
  ) {
    return;
  }

  // Sidebar control becomes visible once we know the backend is on.
  sidebarRow.removeAttribute("hidden");

  const panes = new Map<string, TerminalPaneEntry>();
  let activePaneId: string | null = null;
  let state: TerminalPanelState = readTerminalPanelState(localStorageRef);

  // Height/width restore: write the persisted value to the CSS var so the
  // first paint matches the user's last layout.
  document.documentElement.style.setProperty(
    "--terminal-panel-height",
    `${clampTerminalHeight(state.bottomHeight)}px`,
  );
  document.documentElement.style.setProperty(
    "--terminal-panel-width",
    `${clampTerminalWidth(state.rightWidth)}px`,
  );

  function persistState() {
    state = {
      ...state,
      panes: Array.from(panes.values()).map(entry => entry.record),
    };
    writeTerminalPanelState(localStorageRef, state);
  }

  function getToken(): string | null {
    try {
      return window.sessionStorage.getItem(TERMINAL_TOKEN_KEY_LOCAL);
    } catch {
      return null;
    }
  }

  // Right-dock auto-fallback: at narrow viewports we force bottom-dock, but
  // keep the user's stored preference so widening the viewport snaps it back.
  function effectiveDock(): TerminalDock {
    if (state.dock === "right" && window.innerWidth < TERMINAL_RIGHT_DOCK_VIEWPORT_MIN) {
      return "bottom";
    }
    return state.dock;
  }

  function applyDockToDom() {
    const dock = effectiveDock();
    panel!.setAttribute("data-dock", dock);
    // Split orientation flips with the dock axis: bottom-dock splits side-by-
    // side (panes share full height); right-dock stacks panes (share full
    // width). Driven via a data attribute so CSS handles the flexbox swap.
    panesContainer!.setAttribute("data-orientation", dock === "bottom" ? "horizontal" : "vertical");
    resizer!.setAttribute("data-orientation", dock === "bottom" ? "horizontal" : "vertical");
    // Update dock toggle's affordance to indicate the OPPOSITE dock (where
    // clicking will move the panel to). The icon itself swaps via CSS keyed
    // off [data-dock]; we sync the accessible label here.
    const target = dock === "bottom" ? "right" : "bottom";
    dockButton!.setAttribute("aria-label", `Dock to ${target}`);
    dockButton!.setAttribute("title", `Dock to ${target}`);
  }

  function applyDisplayModeToDom() {
    panel!.setAttribute("data-display", state.displayMode);
    minimizeButton!.setAttribute(
      "aria-pressed",
      state.displayMode === "minimized" ? "true" : "false",
    );
    fullscreenButton!.setAttribute(
      "aria-pressed",
      state.displayMode === "fullscreen" ? "true" : "false",
    );
    // Sync the accessible labels with the action the button now performs;
    // the visible icon swaps via CSS keyed off [data-display].
    if (state.displayMode === "minimized") {
      minimizeButton!.setAttribute("aria-label", "Restore terminal");
      minimizeButton!.setAttribute("title", "Restore terminal");
    } else {
      minimizeButton!.setAttribute("aria-label", "Minimize terminal");
      minimizeButton!.setAttribute("title", "Minimize terminal");
    }
    if (state.displayMode === "fullscreen") {
      fullscreenButton!.setAttribute("aria-label", "Exit fullscreen");
      fullscreenButton!.setAttribute("title", "Exit fullscreen");
    } else {
      fullscreenButton!.setAttribute("aria-label", "Enter fullscreen");
      fullscreenButton!.setAttribute("title", "Enter fullscreen");
    }
  }

  function fitAll() {
    for (const entry of panes.values()) {
      try {
        entry.handle.fit();
      } catch {
        // Ignored: hidden / zero-rect panes throw from FitAddon.
      }
    }
  }

  function paneCount(): number {
    return panes.size;
  }

  function refreshSplitControl() {
    if (paneCount() >= TERMINAL_MAX_PANES) {
      splitButton!.setAttribute("disabled", "");
    } else {
      splitButton!.removeAttribute("disabled");
    }
  }

  function setActivePane(id: string | null) {
    activePaneId = id;
    let activeEntry: TerminalPaneEntry | null = null;
    for (const entry of panes.values()) {
      if (entry.record.id === id) {
        entry.element.setAttribute("data-active", "true");
        activeEntry = entry;
      } else {
        entry.element.removeAttribute("data-active");
      }
    }
    // Move keyboard focus into the active pane's xterm so the user can
    // type immediately after a split, restore, or close. requestAnimationFrame
    // gives xterm.js a tick to finish opening when this runs in the same
    // frame as `addPane()`.
    if (activeEntry) {
      const entry = activeEntry;
      requestAnimationFrame(() => {
        try {
          entry.handle.focus();
        } catch {
          // Pane was torn down between the frame schedule and now.
        }
      });
    }
  }

  function buildPaneElement(record: TerminalPaneRecord): TerminalPaneEntry {
    const element = document.createElement("div");
    element.className = "terminal-pane";
    element.dataset.sessionId = record.id;

    const host = document.createElement("div");
    host.className = "terminal-pane-host";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-pane-close";
    close.setAttribute("aria-label", "Close pane");
    close.setAttribute("title", "Close pane");
    close.textContent = "×";

    element.append(host, close);

    // Click anywhere in the pane (other than the close button) makes it
    // active so a subsequent split / keyboard input goes to the right place.
    element.addEventListener("pointerdown", event => {
      if (event.target === close) return;
      setActivePane(record.id);
    });

    const handle = mountTerminalPanel({
      container: host,
      getToken,
      sessionId: record.id,
      fontFamily: config?.fontFamily,
      fontSize: config?.fontSize,
      // Server-initiated disconnect (shell exited via `exit`, server
      // gone, network drop) → tear the dead pane down automatically.
      // No confirmation modal — there's nothing left to confirm losing.
      onClose: () => {
        if (panes.has(record.id)) removePane(record.id);
      },
    });

    const entry: TerminalPaneEntry = { record, handle, element, hostElement: host, closeButton: close };

    close.addEventListener("click", () => {
      requestClosePane(record.id);
    });

    return entry;
  }

  function rebuildPanesContainer() {
    // Render order: by record.createdAt ascending. Inserts the inter-pane
    // resizer between siblings so the user can adjust the split ratio.
    const ordered = Array.from(panes.values()).sort(
      (a, b) => a.record.createdAt - b.record.createdAt,
    );
    panesContainer!.replaceChildren();
    ordered.forEach((entry, index) => {
      panesContainer!.appendChild(entry.element);
      if (index < ordered.length - 1) {
        const innerResizer = document.createElement("div");
        innerResizer.className = "terminal-pane-resizer";
        innerResizer.setAttribute("role", "separator");
        innerResizer.setAttribute("aria-label", "Resize split");
        wireSplitResizer(innerResizer, ordered[index]!.element, ordered[index + 1]!.element);
        panesContainer!.appendChild(innerResizer);
      }
    });
    // The last pane is the absorber: it always carries `flex: 1 1 0` so
    // any space freed by closing a sibling (or container growth) gets
    // filled instead of leaving a gap. Without this, after a resize the
    // surviving panes still hold their `flex: 0 1 <px>` from drag and the
    // panel under-fills its container — which is the symptom of the
    // close-after-resize bug.
    if (ordered.length > 0) {
      ordered[ordered.length - 1]!.element.style.flex = "1 1 0";
    }
    refreshSplitControl();
  }

  // Drag handler for the resizer between two split panes. Locks both
  // adjacent panes with `flex: 0 1 <px>` so flexbox stops redistributing
  // free space across them — without this, every other pane's flex-grow:1
  // pulls width away from the dragged pair and the resizer drifts away
  // from the pointer. The last pane in the container always stays
  // growable so the panel never shows a gap.
  function wireSplitResizer(
    handle: HTMLElement,
    first: HTMLElement,
    second: HTMLElement,
  ) {
    handle.addEventListener("pointerdown", event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const horizontal = panesContainer!.getAttribute("data-orientation") !== "vertical";
      const start = horizontal ? event.clientX : event.clientY;
      // Snapshot every pane's current size and freeze the ones NOT being
      // dragged. Without this freeze, panes that still have the default
      // `flex: 1 1 0` participate in flexbox redistribution and shrink/grow
      // alongside the dragged pair — visible as: dragging the last
      // resizer (e.g. B-C in 3-pane A B C) also resizes A, because A and
      // the absorber share the leftover space proportionally to their
      // grow factors.
      const allPanes = Array.from(
        panesContainer!.querySelectorAll(".terminal-pane"),
      ) as HTMLElement[];
      const absorber = allPanes[allPanes.length - 1] ?? null;
      for (const pane of allPanes) {
        if (pane === first || pane === second || pane === absorber) continue;
        const rect = pane.getBoundingClientRect();
        const size = horizontal ? rect.width : rect.height;
        pane.style.flex = `0 1 ${size}px`;
      }
      // Re-measure on pointerdown so we always work from current sizes,
      // even if a sibling resizer already locked some panes.
      const firstRect = first.getBoundingClientRect();
      const secondRect = second.getBoundingClientRect();
      const startFirst = horizontal ? firstRect.width : firstRect.height;
      const startSecond = horizontal ? secondRect.width : secondRect.height;
      const total = startFirst + startSecond;
      const minPx = 80;
      document.body.classList.add("is-resizing-terminal");

      function applySizes(nextFirst: number, nextSecond: number) {
        first.style.flex = `0 1 ${nextFirst}px`;
        // Keep the absorber (last pane) growable so the panel never shows a
        // gap when sibling panes' locked bases sum to less than the
        // container. When the absorber itself IS the second pane, the math
        // still works because every other pane is now locked, so the
        // absorber's actual size lands at exactly the expected nextSecond.
        if (second === absorber) {
          second.style.flex = "1 1 0";
        } else {
          second.style.flex = `0 1 ${nextSecond}px`;
        }
      }

      function onMove(ev: PointerEvent) {
        const now = horizontal ? ev.clientX : ev.clientY;
        const delta = now - start;
        const nextFirst = Math.max(minPx, Math.min(total - minPx, startFirst + delta));
        const nextSecond = total - nextFirst;
        applySizes(nextFirst, nextSecond);
        fitAll();
      }
      function onUp(ev: PointerEvent) {
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch {
          // Pointer already released.
        }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.classList.remove("is-resizing-terminal");
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  function addPane(record?: Partial<TerminalPaneRecord>): TerminalPaneEntry | null {
    if (panes.size >= TERMINAL_MAX_PANES) return null;
    const id = record?.id ?? crypto.randomUUID();
    const createdAt = record?.createdAt ?? Date.now();
    const fullRecord: TerminalPaneRecord = { id, createdAt };
    const entry = buildPaneElement(fullRecord);
    panes.set(id, entry);
    rebuildPanesContainer();
    entry.handle.attach();
    setActivePane(id);
    persistState();
    requestAnimationFrame(() => fitAll());
    return entry;
  }

  function removePane(id: string) {
    const entry = panes.get(id);
    if (!entry) return;

    // Pick the successor BEFORE removing so we know the visual neighbor.
    // Prefer the next pane (right of bottom-dock, below in right-dock); if
    // closing the last pane, fall back to its predecessor.
    let successorId: string | null = null;
    if (activePaneId === id) {
      const ordered = Array.from(panes.values()).sort(
        (a, b) => a.record.createdAt - b.record.createdAt,
      );
      const closedIndex = ordered.findIndex(e => e.record.id === id);
      const successor = ordered[closedIndex + 1] ?? ordered[closedIndex - 1] ?? null;
      successorId = successor ? successor.record.id : null;
    }

    try {
      entry.handle.detach();
    } catch {
      // Already detached.
    }
    panes.delete(id);
    rebuildPanesContainer();
    if (activePaneId === id) {
      setActivePane(successorId);
    }
    persistState();
    if (panes.size === 0) {
      setVisible(false);
    } else {
      requestAnimationFrame(() => fitAll());
    }
  }

  let modalAcceptHandler: (() => void) | null = null;
  let modalPreviousFocus: HTMLElement | null = null;
  const modalTitleEl = document.getElementById("terminal-confirm-title");
  const modalBodyEl = document.getElementById("terminal-confirm-body");

  // Modal copy varies with how many sessions the user is about to lose:
  // closing one of several panes is a smaller action than closing the
  // whole panel.
  const MODAL_COPY = {
    pane: {
      title: "Close pane?",
      body: "You'll lose this terminal session and any running processes.",
    },
    panel: {
      title: "Close terminal?",
      body: "You'll lose every shell session in this panel and any running processes.",
    },
  } as const;

  function openConfirmModal(scope: "pane" | "panel", onAccept: () => void) {
    const copy = MODAL_COPY[scope];
    if (modalTitleEl) modalTitleEl.textContent = copy.title;
    if (modalBodyEl) modalBodyEl.textContent = copy.body;
    modalPreviousFocus = (document.activeElement as HTMLElement) ?? null;
    modalAcceptHandler = onAccept;
    modal!.removeAttribute("hidden");
    requestAnimationFrame(() => (modalCancel as HTMLButtonElement).focus());
  }

  function closeConfirmModal(accepted: boolean) {
    modal!.setAttribute("hidden", "");
    const handler = modalAcceptHandler;
    modalAcceptHandler = null;
    if (modalPreviousFocus && document.contains(modalPreviousFocus)) {
      modalPreviousFocus.focus();
    }
    modalPreviousFocus = null;
    if (accepted && handler) handler();
  }

  function requestClosePane(id: string) {
    const entry = panes.get(id);
    if (!entry) return;
    if (!entry.handle.isAttached()) {
      // PTY has already been reaped (e.g. shell exited / disconnected). No
      // session to lose, so close silently.
      removePane(id);
      return;
    }
    openConfirmModal("pane", () => removePane(id));
  }

  // Header × — destructive close: tears down every pane AND clears the
  // persisted pane list so the next visibility toggle starts fresh. The
  // keyboard toggle path (setVisible(false) without persist mutation) is
  // intentionally non-destructive: it's symmetric with hide, and the user
  // can re-toggle within the reaper grace to reattach.
  function closeAllPanes() {
    for (const id of Array.from(panes.keys())) {
      const entry = panes.get(id);
      if (entry) {
        try {
          entry.handle.detach();
        } catch {
          // Already detached.
        }
      }
      panes.delete(id);
    }
    panesContainer!.replaceChildren();
    activePaneId = null;
    // persistState() reads from the panes Map (now empty) so state.panes
    // becomes [], wiping the reattach hints.
    persistState();
    setVisible(false);
  }

  function setVisible(visible: boolean, persist = true) {
    if (visible) {
      panel!.removeAttribute("hidden");
      resizer!.removeAttribute("hidden");
      toggle!.setAttribute("aria-pressed", "true");
      // Restore display mode and dock from persisted state on each show.
      applyDockToDom();
      applyDisplayModeToDom();
      // First show with no panes: spawn one. If the persisted pane list has
      // entries (reload-restore path), reuse those sessionIds so the server
      // can hand back live PTYs within the reconnect grace.
      if (panes.size === 0) {
        if (state.panes.length > 0) {
          for (const record of state.panes.slice(0, TERMINAL_MAX_PANES)) {
            addPane(record);
          }
        } else {
          addPane();
        }
      }
      requestAnimationFrame(() => fitAll());
    } else {
      panel!.setAttribute("hidden", "");
      resizer!.setAttribute("hidden", "");
      toggle!.setAttribute("aria-pressed", "false");
      // Detach every pane on hide. The server's 5s grace window covers a
      // re-show so this isn't destructive within the same tab.
      for (const entry of panes.values()) {
        try {
          entry.handle.detach();
        } catch {
          // Already detached.
        }
      }
      panes.clear();
      panesContainer!.replaceChildren();
      activePaneId = null;
    }
    if (persist) writeTerminalVisiblePreference(visible);
  }

  function toggleVisible() {
    const visible = !panel!.hasAttribute("hidden");
    setVisible(!visible);
  }

  function setDock(next: TerminalDock) {
    state = { ...state, dock: next };
    persistState();
    applyDockToDom();
    // Reset any per-pane flex inline style from a previous split so panes
    // share equally after re-orientation — pixel widths set against the
    // horizontal axis don't translate to the vertical axis (and vice
    // versa). The user can re-resize after.
    for (const entry of panes.values()) {
      entry.element.style.flex = "";
      entry.element.style.flexBasis = "";
    }
    requestAnimationFrame(() => fitAll());
  }

  function setDisplayMode(next: TerminalDisplayMode) {
    state = { ...state, displayMode: next };
    persistState();
    applyDisplayModeToDom();
    if (next === "minimized") {
      // Don't dispose xterm — the PTY stays attached so output that arrives
      // while minimized renders into scrollback as soon as we restore.
      return;
    }
    // Restoring (normal | fullscreen) needs xterm to re-fit because the
    // body's rect just changed.
    requestAnimationFrame(() => fitAll());
  }

  function splitActive() {
    if (panes.size >= TERMINAL_MAX_PANES) return;
    addPane();
  }

  // ------------- Wiring -------------

  toggle.addEventListener("click", toggleVisible);
  closeButton.addEventListener("click", () => {
    if (panes.size === 0) {
      setVisible(false);
      return;
    }
    // Closing the panel via the panel-level × is treated as closing every
    // pane; if any are attached, confirm once.
    const anyAttached = Array.from(panes.values()).some(p => p.handle.isAttached());
    if (!anyAttached) {
      closeAllPanes();
      return;
    }
    openConfirmModal("panel", () => closeAllPanes());
  });

  splitButton.addEventListener("click", () => splitActive());
  dockButton.addEventListener("click", () => {
    setDock(state.dock === "bottom" ? "right" : "bottom");
  });
  minimizeButton.addEventListener("click", () => {
    setDisplayMode(state.displayMode === "minimized" ? "normal" : "minimized");
  });
  fullscreenButton.addEventListener("click", () => {
    setDisplayMode(state.displayMode === "fullscreen" ? "normal" : "fullscreen");
  });
  modalCancel.addEventListener("click", () => closeConfirmModal(false));
  modalAccept.addEventListener("click", () => closeConfirmModal(true));
  modal.addEventListener("click", event => {
    // Backdrop click cancels (treated as "no").
    if (event.target === modal) closeConfirmModal(false);
  });

  // Keyboard shortcuts. Capture phase so xterm.js — which attaches its own
  // keydown listener on the helper-textarea inside each pane and may
  // stopPropagation on certain keys — can't shadow our panel-level
  // shortcuts. Don't shadow normal backtick typing inside the terminal —
  // only intercept when a modifier is held; for non-shortcut keys we
  // simply return without preventDefault so xterm still receives them.
  document.addEventListener(
    "keydown",
    event => {
      if (event.altKey) return;
      if (event.key === "`" || event.key === "´") {
        if (!event.ctrlKey && !event.metaKey) return;
        if (event.shiftKey) {
          // Cmd/Ctrl+Shift+` → split.
          if (panel!.hasAttribute("hidden")) return;
          event.preventDefault();
          event.stopPropagation();
          splitActive();
          return;
        }
        // Cmd/Ctrl+` → toggle.
        event.preventDefault();
        event.stopPropagation();
        toggleVisible();
        return;
      }
      // Esc cancels the confirm modal if open; otherwise exits fullscreen.
      // No panel-focus check — when the panel is in fullscreen it's filling
      // the main area and the user expects Esc to escape it regardless of
      // exact focus.
      if (event.key === "Escape") {
        if (!modal!.hasAttribute("hidden")) {
          event.preventDefault();
          event.stopPropagation();
          closeConfirmModal(false);
          return;
        }
        if (state.displayMode === "fullscreen") {
          event.preventDefault();
          event.stopPropagation();
          setDisplayMode("normal");
        }
      }
    },
    true,
  );

  // Drag-to-resize for the panel itself. Orientation depends on the dock:
  // bottom = vertical drag (height), right = horizontal drag (width).
  resizer.addEventListener("pointerdown", event => {
    event.preventDefault();
    // setPointerCapture so a drag that escapes the 4px resizer (or leaves
    // the browser window momentarily) keeps receiving move/up events on
    // this element. Without it, an interrupted drag could leave
    // `is-resizing-terminal` stuck on <body> with the cursor and event
    // routing in a "still resizing" state.
    resizer.setPointerCapture(event.pointerId);
    const dock = effectiveDock();
    document.body.classList.add("is-resizing-terminal");
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = panel!.getBoundingClientRect();
    const startHeight = rect.height;
    const startWidth = rect.width;

    function onMove(ev: PointerEvent) {
      if (dock === "bottom") {
        const delta = startY - ev.clientY;
        const next = clampTerminalHeight(startHeight + delta);
        document.documentElement.style.setProperty("--terminal-panel-height", `${next}px`);
      } else {
        const delta = startX - ev.clientX;
        const next = clampTerminalWidth(startWidth + delta);
        document.documentElement.style.setProperty("--terminal-panel-width", `${next}px`);
      }
      fitAll();
    }

    function onUp(ev: PointerEvent) {
      try {
        resizer.releasePointerCapture(ev.pointerId);
      } catch {
        // Pointer already released.
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-terminal");
      const finalRect = panel!.getBoundingClientRect();
      if (dock === "bottom") {
        state = { ...state, bottomHeight: Math.round(finalRect.height) };
      } else {
        state = { ...state, rightWidth: Math.round(finalRect.width) };
      }
      persistState();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });

  // Re-evaluate the right-dock fallback on viewport changes so users who
  // narrow the window mid-session don't get stuck with an unusable layout.
  window.addEventListener("resize", () => {
    applyDockToDom();
    fitAll();
  });

  // First paint: apply persisted dock + display mode even before any panes
  // exist so the panel chrome is correctly oriented when shown.
  applyDockToDom();
  applyDisplayModeToDom();

  // Restore visibility from the previous session in this tab.
  if (readTerminalVisiblePreference()) {
    setVisible(true, false);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}
