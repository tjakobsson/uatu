import { fileIconForName } from "./file-icons";
import { closeMermaidViewer, ensureMermaidViewer } from "./mermaid-viewer";
import { renderMermaidDiagrams, replaceMermaidCodeBlocks, type MermaidThemeInputs } from "./preview";
import {
  DEFAULT_MODE,
  buildTreeNodes,
  defaultDocumentId,
  formatRelativeTime,
  hasDocument,
  nextSelectedDocumentId,
  readModePreference,
  reviewBurdenHeadlineLabel,
  shouldRefreshPreview,
  writeModePreference,
  type BuildSummary,
  type ChangedFileSummary,
  type DocumentMeta,
  type Mode,
  type RepositoryReviewSnapshot,
  type RootGroup,
  type Scope,
  type StatePayload,
  type TreeNode,
} from "./shared";
import { nextStaleHint, type StaleHint } from "./stale-hint";

type RenderedDocument = {
  id: string;
  title: string;
  path: string;
  html: string;
  kind: "markdown" | "asciidoc" | "text";
  language: string | null;
};

const SIDEBAR_COLLAPSED_KEY = "uatu:sidebar-collapsed";
const SIDEBAR_PANES_KEY_PREFIX = "uatu:sidebar-panes:";
const SIDEBAR_WIDTH_KEY = "uatu:sidebar-width";
const GIT_LOG_LIMIT_KEY = "uatu:git-log-limit";
const FILES_VIEW_KEY_PREFIX = "uatu:files-view:";

type FilesView = "all" | "changed";

function isFilesView(value: unknown): value is FilesView {
  return value === "all" || value === "changed";
}

function filesViewStorageKeyForMode(mode: Mode): string {
  return `${FILES_VIEW_KEY_PREFIX}${mode}`;
}

function readFilesView(mode: Mode): FilesView {
  try {
    const raw = window.localStorage.getItem(filesViewStorageKeyForMode(mode));
    return isFilesView(raw) ? raw : "all";
  } catch {
    return "all";
  }
}

function writeFilesView(mode: Mode, view: FilesView): void {
  try {
    window.localStorage.setItem(filesViewStorageKeyForMode(mode), view);
  } catch {
    // best-effort persistence
  }
}
const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 620;
const ALL_PANE_DEFS = [
  { id: "change-overview", label: "Change Overview" },
  { id: "files", label: "Files" },
  { id: "git-log", label: "Git Log" },
] as const;
type PaneId = (typeof ALL_PANE_DEFS)[number]["id"];
type PaneDef = (typeof ALL_PANE_DEFS)[number];
type PaneState = Record<PaneId, { visible: boolean; collapsed: boolean; height: number | null }>;

const PANE_DEFS_BY_MODE: Record<Mode, readonly PaneDef[]> = {
  // Author hides Git Log entirely — past commits are a Review concern.
  author: ALL_PANE_DEFS.filter(pane => pane.id !== "git-log"),
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
const modeSubtitleElement = document.querySelector<HTMLElement>("#mode-subtitle");
const modePillElement = document.querySelector<HTMLElement>("#mode-pill");
const previewShellElement = document.querySelector<HTMLElement>(".preview-shell");
const filesViewToggleElement = document.querySelector<HTMLDivElement>("#files-view-toggle");
const filesViewAllButton = document.querySelector<HTMLButtonElement>("#files-view-all");
const filesViewChangedButton = document.querySelector<HTMLButtonElement>("#files-view-changed");
const staleHintElement = document.querySelector<HTMLDivElement>("#stale-hint");
const staleHintMessageElement = document.querySelector<HTMLElement>("#stale-hint-message");
const staleHintActionElement = document.querySelector<HTMLButtonElement>("#stale-hint-action");
const documentCountElement = document.querySelector<HTMLElement>("#document-count");
const connectionStateElement = document.querySelector<HTMLElement>("#connection-state");
const connectionLabelElement = connectionStateElement?.querySelector<HTMLElement>(".connection-label") ?? null;
const buildBadgeElement = document.querySelector<HTMLElement>("#build-badge");
const sidebarCollapseElement = document.querySelector<HTMLButtonElement>("#sidebar-collapse");
const sidebarExpandElement = document.querySelector<HTMLButtonElement>("#sidebar-expand");

if (
  !appShellElement ||
  !previewBaseElement ||
  !treeElement ||
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
  !modeSubtitleElement ||
  !modePillElement ||
  !previewShellElement ||
  !filesViewToggleElement ||
  !filesViewAllButton ||
  !filesViewChangedButton ||
  !staleHintElement ||
  !staleHintMessageElement ||
  !staleHintActionElement ||
  !documentCountElement ||
  !connectionStateElement ||
  !connectionLabelElement ||
  !buildBadgeElement ||
  !sidebarCollapseElement ||
  !sidebarExpandElement
) {
  throw new Error("uatu UI failed to initialize");
}

const appState = {
  roots: [] as RootGroup[],
  repositories: [] as RepositoryReviewSnapshot[],
  selectedId: null as string | null,
  previewMode: { kind: "document" } as PreviewMode,
  followEnabled: true,
  // Author / Review posture. Resolved on boot from the CLI startupMode override
  // (when present) or persisted localStorage; falls back to DEFAULT_MODE.
  mode: DEFAULT_MODE as Mode,
  // Per-active-file stale-content hint state. Only set in Review mode; cleared
  // by manual navigation, mode switch back to Author, or refresh action.
  staleHint: null as StaleHint | null,
  // Per-mode Files-pane view: "all" (full tree, default) or "changed"
  // (changed-vs-base list, opt-in when git is available).
  filesView: "all" as FilesView,
  scope: { kind: "folder" } as Scope,
  panes: readPaneState(DEFAULT_MODE),
  gitLogLimit: readGitLogLimitPreference(),
  // Per-directory open/closed state the user explicitly set by clicking a
  // directory's <summary>. Session-only; wins over the default-open rule.
  dirOverrides: new Map<string, "open" | "closed">(),
};

initSidebarCollapse();
initSidebarPanes();
initSidebarWidth();
initGitLogControls();
initBrandLogo();
initInPageAnchorHandler();
initCrossDocAnchorHandler();

function initBrandLogo() {
  const logo = document.querySelector<HTMLImageElement>(".brand-logo");
  const src = logo?.dataset.src;
  if (logo && src) {
    logo.src = src;
  }
}

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
    revealSelectedFile();
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
      revealSelectedFile();
      renderSidebar();
      void loadDocument(latestId);
    }
  }
});

sidebarCollapseElement.addEventListener("click", () => setSidebarCollapsed(true));
sidebarExpandElement.addEventListener("click", () => setSidebarCollapsed(false));

// Capture real user clicks on a directory's <summary> and record the resulting
// open/closed state as an override. We don't use the <details> `toggle` event
// because the browser fires a synthetic toggle for every element parsed with
// `open=""` — which would cause every re-render to "auto-user-open" all open
// directories, defeating the override system entirely.
treeElement.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const summary = target.closest("summary");
  if (!summary) {
    return;
  }
  const details = summary.parentElement;
  if (!(details instanceof HTMLDetailsElement)) {
    return;
  }
  const dirPath = details.dataset.dirPath;
  if (!dirPath) {
    return;
  }
  // The click fires before the browser toggles the element, so `details.open`
  // here reflects the PRE-toggle state. The next state is the inverse.
  const nextOpen = !details.open;
  appState.dirOverrides.set(dirPath, nextOpen ? "open" : "closed");
});

treeElement.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest<HTMLButtonElement>("button[data-document-id]");
  if (!button) {
    return;
  }

  const documentId = button.dataset.documentId;
  if (!documentId) {
    return;
  }

  appState.followEnabled = false;
  appState.selectedId = documentId;
  appState.previewMode = { kind: "document" };
  applyStaleHint(nextStaleHint(appState.staleHint, { kind: "manual-navigation" }));
  const doc = findDocumentById(documentId);
  if (doc) {
    pushSelection(documentId, doc.relativePath);
  }
  revealSelectedFile();
  syncFollowToggle();
  renderSidebar();
  void loadDocument(documentId);
});

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
      revealSelectedFile();
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
    revealSelectedFile();
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
  appState.filesView = readFilesView(resolvedMode);
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

  revealSelectedFile();
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
      revealSelectedFile();
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

async function loadDocument(documentId: string) {
  const response = await fetch(`/api/document?id=${encodeURIComponent(documentId)}`);

  if (!response.ok) {
    appState.previewMode = { kind: "empty" };
    renderEmptyPreview("Document unavailable", "The selected file no longer exists.");
    return;
  }

  const payload = (await response.json()) as RenderedDocument;
  appState.previewMode = { kind: "document" };
  previewTitleElement.textContent = payload.title;
  previewPathElement.textContent = payload.path;
  setPreviewType(payload);
  previewElement.classList.remove("empty");
  setPreviewBase(payload.path);
  closeMermaidViewer();
  previewElement.innerHTML = replaceMermaidCodeBlocks(payload.html);
  await renderMermaidDiagrams(previewElement, currentMermaidThemeInputs());
  if (payload.kind === "text") {
    attachLineNumbers(previewElement);
  }
  attachCopyButtons(previewElement);
}

function renderCommitMessage(
  repository: RepositoryReviewSnapshot,
  commit: RepositoryReviewSnapshot["commitLog"][number],
) {
  closeMermaidViewer();
  previewTitleElement.textContent = commit.subject;
  previewPathElement.textContent = `${repository.label} · ${commit.sha}`;
  clearPreviewType();
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
  previewBaseElement.href = new URL("/", window.location.origin).toString();
  previewElement.classList.remove("empty");
  previewElement.innerHTML = buildScoreExplanationHTML(load);
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
  const label =
    payload.kind === "markdown"
      ? "markdown"
      : payload.kind === "asciidoc"
        ? "asciidoc"
        : payload.language ?? "text";
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
  const hiddenCount = appState.roots.reduce((sum, root) => sum + root.hiddenCount, 0);

  const segments = [`${totalCount} file${totalCount === 1 ? "" : "s"}`];
  if (binaryCount > 0) {
    segments.push(`${binaryCount} binary`);
  }
  if (hiddenCount > 0) {
    segments.push(`${hiddenCount} hidden`);
  }
  documentCountElement.textContent = segments.join(" · ");

  // Files-view toggle is only meaningful when there's a git base to diff
  // against. Show it then; hide otherwise (the absence is the signal).
  const reposWithChanges = appState.repositories.filter(
    repo => repo.reviewLoad.status === "available",
  );
  syncFilesViewToggle(reposWithChanges.length > 0);

  if (totalCount === 0) {
    treeElement.innerHTML = `<div class="tree-empty">No files found in the watched roots.</div>`;
    return;
  }

  // Changed view (opt-in) lists changed-vs-base files when git is available.
  // Otherwise (default, or git unavailable) render the full tree.
  if (reposWithChanges.length > 0 && appState.filesView === "changed") {
    treeElement.innerHTML = reposWithChanges
      .map(repo => renderChangedFilesSection(repo))
      .join("");
    return;
  }

  treeElement.innerHTML = appState.roots
    .map(root => {
      const nodes = buildTreeNodes(root);
      return `
        <section class="root-group">
          <header class="root-title">
            <strong>${escapeHtml(root.label)}</strong>
            <span>${escapeHtml(root.path)}</span>
          </header>
          ${renderNodes(nodes)}
        </section>
      `;
    })
    .join("");
}

function renderChangedFilesSection(repo: RepositoryReviewSnapshot): string {
  const changes = repo.reviewLoad.changedFiles;
  if (changes.length === 0) {
    return `
      <section class="root-group">
        <header class="root-title">
          <strong>${escapeHtml(repo.label)}</strong>
          <span>${escapeHtml(repo.rootPath)}</span>
        </header>
        <div class="tree-empty">No changes against the base.</div>
      </section>
    `;
  }
  return `
    <section class="root-group">
      <header class="root-title">
        <strong>${escapeHtml(repo.label)}</strong>
        <span>${escapeHtml(repo.rootPath)} · ${changes.length} changed</span>
      </header>
      <ul class="changed-file-list">
        ${changes.map(change => renderChangedFileRow(repo, change)).join("")}
      </ul>
    </section>
  `;
}

function changedFileStatusInfo(status: string): { glyph: string; label: string; cls: string } {
  const head = (status[0] ?? "").toUpperCase();
  switch (head) {
    case "A":
      return { glyph: "+", label: "Added", cls: "is-added" };
    case "D":
      return { glyph: "−", label: "Deleted", cls: "is-deleted" };
    case "R":
      return { glyph: "→", label: "Renamed", cls: "is-renamed" };
    case "C":
      return { glyph: "⎘", label: "Copied", cls: "is-copied" };
    case "M":
    default:
      return { glyph: "M", label: "Modified", cls: "is-modified" };
  }
}

function findDocumentForChangedFile(
  repo: RepositoryReviewSnapshot,
  changePath: string,
): DocumentMeta | null {
  // ChangedFileSummary.path is relative to the repository root; doc.id is the
  // absolute path. Compose and look up.
  const absolutePath = `${repo.rootPath.replace(/\/$/, "")}/${changePath}`;
  for (const root of appState.roots) {
    for (const doc of root.docs) {
      if (doc.id === absolutePath) {
        return doc;
      }
    }
  }
  return null;
}

function renderChangedFileRow(
  repo: RepositoryReviewSnapshot,
  change: ChangedFileSummary,
): string {
  const status = changedFileStatusInfo(change.status);
  const isDeleted = status.label === "Deleted";
  const target = isDeleted ? null : findDocumentForChangedFile(repo, change.path);
  const pathLabel = change.oldPath
    ? `${escapeHtml(change.oldPath)} → ${escapeHtml(change.path)}`
    : escapeHtml(change.path);
  const counts = change.additions === 0 && change.deletions === 0
    ? ""
    : `<span class="changed-file-counts"><span class="adds">+${change.additions}</span><span class="dels">-${change.deletions}</span></span>`;
  const statusBadge = `<span class="changed-file-status ${status.cls}" title="${escapeHtmlAttribute(status.label)}">${escapeHtml(status.glyph)}</span>`;

  if (!target) {
    return `
      <li class="changed-file changed-file-disabled" title="${escapeHtmlAttribute(`${status.label}: ${change.path}`)}">
        <span class="changed-file-main">
          ${statusBadge}
          <span class="changed-file-path">${pathLabel}</span>
        </span>
        ${counts}
      </li>
    `;
  }
  const isSelected = target.id === appState.selectedId;
  return `
    <li class="changed-file">
      <button type="button" class="changed-file-button${isSelected ? " is-selected" : ""}" data-document-id="${escapeHtmlAttribute(target.id)}" title="${escapeHtmlAttribute(`${status.label}: ${change.path}`)}">
        <span class="changed-file-main">
          ${statusBadge}
          <span class="changed-file-path">${pathLabel}</span>
        </span>
        ${counts}
      </button>
    </li>
  `;
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

// Directories default to closed (matching VS Code / Finder / GitHub conventions).
// A user's explicit click on <summary> stores an override that wins for the
// rest of the session.
function shouldDirRenderOpen(dirPath: string): boolean {
  return appState.dirOverrides.get(dirPath) === "open";
}

// When selection changes (initial load, follow-mode auto-switch, user click),
// reveal the path to the selected file by marking its ancestor directories as
// "open" in the same override map a manual click populates. Purely additive:
// we never mark anything closed — if the user later collapses a revealed
// ancestor, that stays collapsed (their next click stores "closed").
function revealSelectedFile() {
  if (!appState.selectedId) {
    return;
  }
  for (const root of appState.roots) {
    const doc = root.docs.find(candidate => candidate.id === appState.selectedId);
    if (!doc) {
      continue;
    }
    const parts = doc.relativePath.split("/").filter(Boolean);
    let current = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = current ? `${current}/${parts[index]}` : parts[index]!;
      appState.dirOverrides.set(current, "open");
    }
    return;
  }
}

const FOLDER_ICON_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5z"/></svg>';

function renderNodes(nodes: TreeNode[]): string {
  if (nodes.length === 0) {
    return `<div class="tree-empty">No files in this root.</div>`;
  }

  return `<ul>${nodes
    .map(node => {
      if (node.kind === "dir") {
        const openAttribute = shouldDirRenderOpen(node.path) ? " open" : "";
        const dirMtime = renderTreeMtime(node.mtimeMs);
        return `
          <li class="tree-node tree-dir">
            <details data-dir-path="${escapeHtmlAttribute(node.path)}"${openAttribute}>
              <summary><span class="tree-icon tree-folder-icon" aria-hidden="true">${FOLDER_ICON_SVG}</span><span class="tree-dir-name">${escapeHtml(node.name)}</span>${dirMtime}</summary>
              ${renderNodes(node.children ?? [])}
            </details>
          </li>
        `;
      }

      const mtimeMarkup = renderTreeMtime(node.mtimeMs);

      if (node.documentKind === "binary") {
        return `
          <li class="tree-node tree-doc">
            <span class="tree-doc-disabled" title="Binary file — not viewable">
              <span class="tree-icon">${fileIconForName(node.name)}</span>
              <span class="tree-label">${escapeHtml(node.name)}</span>
              ${mtimeMarkup}
            </span>
          </li>
        `;
      }

      const isSelected = node.id === appState.selectedId;
      return `
        <li class="tree-node tree-doc">
          <button type="button" class="tree-doc-button${isSelected ? " is-selected" : ""}" data-document-id="${escapeHtmlAttribute(node.id ?? "")}">
            <span class="tree-icon">${fileIconForName(node.name)}</span>
            <span class="tree-label">${escapeHtml(node.name)}</span>
            ${mtimeMarkup}
          </button>
        </li>
      `;
    })
    .join("")}</ul>`;
}

function renderTreeMtime(mtimeMs: number | undefined): string {
  if (mtimeMs === undefined) {
    return "";
  }
  const label = formatRelativeTime(mtimeMs, Date.now());
  return `<span class="tree-mtime" data-mtime="${mtimeMs}">${escapeHtml(label)}</span>`;
}

// Refresh tree-mtime labels every second so they tick visibly. Each pass is a
// DOM walk over ~one span per leaf + per directory; we skip the textContent
// write when the formatted label hasn't changed (most ticks past the first
// minute) so this stays cheap regardless of repo size. The server only
// broadcasts state when fingerprints change, so we can't rely on SSE alone
// to keep these labels fresh.
window.setInterval(() => {
  const now = Date.now();
  document
    .querySelectorAll<HTMLElement>(".tree-mtime[data-mtime]")
    .forEach(element => {
      const mtime = Number(element.dataset.mtime);
      if (!Number.isFinite(mtime)) {
        return;
      }
      const next = formatRelativeTime(mtime, now);
      if (element.textContent !== next) {
        element.textContent = next;
      }
    });
}, 1000);

function renderEmptyPreview(title: string, body: string) {
  closeMermaidViewer();
  previewTitleElement.textContent = title;
  previewPathElement.textContent = body;
  clearPreviewType();
  previewElement.classList.add("empty");
  previewElement.innerHTML = `<p>${escapeHtml(body)}</p>`;
}

function syncFollowToggle() {
  const label = followToggleElement.querySelector<HTMLElement>(".chip-label");
  if (label) {
    label.textContent = "Follow";
  }

  const pinned = appState.scope.kind === "file";
  const reviewMode = appState.mode === "review";
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

  // Brand subtitle and persistent pill — strongest at-a-glance cues for "which
  // mode am I in" since they sit in the always-visible sidebar header.
  modeSubtitleElement.textContent = isAuthor ? "Authoring session" : "Review session";
  modePillElement.textContent = isAuthor ? "Authoring" : "Reviewing";
  modePillElement.dataset.modePill = appState.mode;

  // Body / preview-shell classes drive the Mode-aware preview chrome.
  document.body.classList.toggle("is-mode-author", isAuthor);
  document.body.classList.toggle("is-mode-review", !isAuthor);
  previewShellElement.classList.toggle("is-mode-review", !isAuthor);

  // Re-derive the connection indicator since its wording and dot animation
  // depend on Mode when the channel is live.
  syncConnectionDisplay();
}

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
  // Files-view choice is also per-mode.
  appState.filesView = readFilesView(next);

  // Switching to Review forces follow off so the Review-mode contract holds
  // (no auto-switching). Switching to Author leaves follow as it was — we
  // never auto-enable, the user opts back in.
  if (next === "review" && appState.followEnabled) {
    appState.followEnabled = false;
  }

  // Mode change clears any visible hint. When switching from Review (with a
  // changed-on-disk hint) to Author, also re-render the active preview so the
  // user lands on the current on-disk content rather than the stale render.
  const hadChangedHint =
    previous === "review" &&
    appState.staleHint?.kind === "changed" &&
    appState.staleHint.documentId === appState.selectedId;

  applyStaleHint(nextStaleHint(appState.staleHint, { kind: "mode-changed", nextMode: next }));

  syncModeControl();
  syncFollowToggle();
  renderSidebar();
  schedulePaneHeightNormalization();

  if (next === "author" && hadChangedHint && appState.selectedId) {
    void loadDocument(appState.selectedId);
  }
}

modeAuthorButton.addEventListener("click", () => applyMode("author"));
modeReviewButton.addEventListener("click", () => applyMode("review"));

function syncFilesViewToggle(available: boolean) {
  filesViewToggleElement.hidden = !available;
  if (!available) {
    return;
  }
  const isAll = appState.filesView === "all";
  filesViewAllButton.setAttribute("aria-checked", String(isAll));
  filesViewAllButton.classList.toggle("is-active", isAll);
  filesViewChangedButton.setAttribute("aria-checked", String(!isAll));
  filesViewChangedButton.classList.toggle("is-active", !isAll);
}

function applyFilesView(next: FilesView) {
  if (appState.filesView === next) {
    return;
  }
  appState.filesView = next;
  writeFilesView(appState.mode, next);
  renderSidebar();
}

filesViewAllButton.addEventListener("click", () => applyFilesView("all"));
filesViewChangedButton.addEventListener("click", () => applyFilesView("changed"));

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
    void loadDocument(appState.selectedId);
  }
});

type ConnectionRawState = "live" | "reconnecting" | "connecting";

let connectionRawState: ConnectionRawState = "connecting";

function setConnectionState(state: ConnectionRawState, _label: string) {
  // The label argument is preserved for source-call clarity but the actual
  // display text is derived in syncConnectionDisplay so it can take Mode
  // into account (live + Review reads as "Reading — auto-refresh paused"
  // with a steady dot).
  connectionRawState = state;
  syncConnectionDisplay();
}

function syncConnectionDisplay() {
  connectionStateElement.classList.remove(
    "is-live",
    "is-reconnecting",
    "is-connecting",
    "is-mode-review",
  );
  connectionStateElement.classList.add(`is-${connectionRawState}`);
  let label: string;
  if (connectionRawState === "reconnecting") {
    label = "Reconnecting";
  } else if (connectionRawState === "connecting") {
    label = "Connecting";
  } else if (appState.mode === "review") {
    label = "Reading — auto-refresh paused";
    connectionStateElement.classList.add("is-mode-review");
  } else {
    label = "Online";
  }
  connectionLabelElement.textContent = label;
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
