// The pull request preview target (`?repository=<id>&pr=<n>`), opened from the
// Pull request pane like a Git Log commit opens its commit preview. Two tabs
// replace Rendered / Source / Diff: Conversation (description, reviews with
// their thread summaries, comments, and a top-level comment composer) and
// Files changed (src/preview/diff-review.ts).
//
// The view mounts once per pull request and then follows the shared store
// (src/github/pull-request-store.ts): document events re-enter
// `renderPullRequestPreview`, which leaves a mounted view alone, so drafts in
// its composers survive file edits elsewhere in the workspace (and reloads:
// src/preview/pr-drafts.ts).
//
// The tabs follow the ARIA tabs pattern (arrow keys, Home / End) and each
// switch is a history entry. Whether GitHub takes writes is read from the
// summary on every store change, for the branch's pull request and a viewed
// one alike: stale data shows under a banner and sending waits (Retry says
// what it is doing, then the new answer); without a credential the view gives
// way to the "connect GitHub" card on both tabs. Conversation opens with the
// pending-review bar while a review is pending (Discard, Finish review (n);
// the same bar as Files changed) and ends with the read-only merge readiness
// and "Merge on GitHub ↗" (or "View on GitHub ↗" while merging is blocked):
// uatu never merges. The review dialog's "Add line comments" (from any
// review button) opens Files changed with a composer on the first file's
// first non-blank changed line. The tabs row holds the one review button
// (diff-review.ts; Review, or Finish (n)) on touch and desktop alike and, on
// Files changed, Jump to file. On a phone the preview header is a title row
// (#n, the title in up to two lines, Open on GitHub and text size; a viewed
// PR has the switcher's Viewing strip above it instead) over the tabs row;
// in portrait the title row scrolls away and the tabs row stays pinned, in a
// short touch viewport the whole header is one pinned row (--pr-sticky-top
// follows the header). Files changed leaves out the state, author and branch facts
// above it: the header names the PR, and its own summary line has the counts
// and refs. The URL keeps the tab, and on Files changed the file or review
// thread last jumped to (`file=`, `thread=`), so a reload or Back / Forward
// lands there again.
//
// A third state shows one file of the pull request (`path=`, the file view in
// src/preview/pull-request-file.ts): the tabs row adds the file as a crumb
// tab, and ‹ n of m › steps through the changed files in tree order, keeping
// the view mode. Meanwhile the Conversation / Files changed panels are set
// aside (kept, drafts and all) and the file's content is the preview.
//
// The module also follows which pull requests are on screen (this view's and
// the workspace's current one): write dialogs for any other one close, and
// leaving a pull request with a pending review says the review is still
// pending and where to find it.

import { retryNoticeText, sendBlockedReason, staleNotice } from "../github/availability";
import { githubApi, GithubRequestError } from "../github/client";
import { errorMessage, pullRequestStore } from "../github/pull-request-store";
import {
  age,
  avatar,
  branchesHtml,
  checksSummaryHtml,
  clockTime,
  clockTimeWithSeconds,
  mergeLinkHtml,
  mockNotice,
  omittedNoteHtml,
  omittedNotes,
  reviewDecisionBadge,
  stateBadge,
} from "../github/present";
import { mergeReadinessView } from "../github/readiness";
import type { PullRequestDetail, ReviewThread, TimelineItem } from "../shared/github-contract";
import { appUrl } from "../shared/app-url";
import { connectGithubHtml } from "../github/connect";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { appState } from "../shell/state";
import { pushPullRequestPreview, replacePullRequestPreview } from "../shell/history";
import { activatePullRequestPreview, registerPullRequestPreviewRenderer } from "../shell/url";
import { previewScrollRoot } from "../shell/preview-scroll-root";
import { releaseMediaPreview } from "../media/preview";
import { clearPreviewType } from "./header";
import { closeMermaidViewer } from "./mermaid-viewer";
import { hideViewToggle } from "./view-mode";
import { deferHiddenPreview } from "./deferred";
import { createComposer, tabKeyIndex, type Composer } from "./pr-composer";
import { mountFilesChanged, renderReviewBar, type FilesChangedView } from "./diff-review";
import { onUiModeChange } from "../shell/ui-mode";
import { revealPreviewSurface } from "../shell/tab-bar";
import { ADD_LINE_COMMENTS_EVENT, closePullRequestDialogsOutside, showToast } from "./review-dialogs";
import { openFileJumpDialog } from "./diff-review";
import { inTreeOrder } from "../shared/tree-order";
import { applyViewMode } from "./view-mode";
import type { PullRequestRenderOptions } from "../shell/url";
import {
  closePullRequestFile,
  kindOfPath,
  pullRequestFileShowing,
  showPullRequestFile,
  updatePullRequestFile,
  type FileTarget,
} from "./pull-request-file";

export type PullRequestTab = "conversation" | "files" | "file";
type Mode = { kind: "pull-request"; repositoryId: string; number: number };

const previewElement = document.querySelector<HTMLElement>("#preview")!;
const previewTitleElement = document.querySelector<HTMLElement>("#preview-title")!;
const previewPathElement = document.querySelector<HTMLElement>("#preview-path")!;
const previewBaseElement = document.querySelector<HTMLBaseElement>("#preview-base")!;
const tabControl = document.querySelector<HTMLElement>("#pr-view-control");
const githubLink = document.querySelector<HTMLAnchorElement>("#pr-view-github");
const headerReview = document.querySelector<HTMLElement>("#pr-view-review");
const jumpButton = document.querySelector<HTMLButtonElement>("#pr-view-jump");
const fileTab = document.querySelector<HTMLButtonElement>("#pr-tab-file");
const fileNav = document.querySelector<HTMLElement>("#pr-file-nav");

type Mounted = {
  repositoryId: string;
  number: number;
  tab: PullRequestTab;
  root: HTMLElement;
  detail: PullRequestDetail | null;
  files: FilesChangedView | null;
  composer: Composer | null;
  loading: boolean;
  // The URL's `file=` or `thread=`: waiting to be scrolled to, and last
  // scrolled to (a re-render with the same one leaves the scroll position
  // alone; a tab switch forgets it, so Forward lands there again).
  pendingAnchor: Anchor | null;
  revealedAnchor: string | null;
  // The file the file view shows (or last showed: its crumb tab returns
  // there).
  fileTarget: FileTarget | null;
};
type Anchor = { file?: string; thread?: string };
const anchorKey = (anchor: Anchor) => `${anchor.file ?? ""}\n${anchor.thread ?? ""}`;

let mounted: Mounted | null = null;

// The view is still the preview: its panels are mounted, or (file view) its
// file is.
const isLive = (view: Mounted) => view.tab === "file" ? pullRequestFileShowing() : view.root.isConnected;
// Add line comments asked for this pull request: Files changed opens its
// first composer once mounted.
let addLinesFor: number | null = null;

// The review bars and file headers pin under the preview's sticky header
// (--pr-sticky-top). On a phone in portrait only the header's tabs row stays
// pinned: the number and title rows above it scroll away, their height
// the header's negative top (--pr-header-hide). Everything pinned over the
// content (the header, an active review bar, a file's header on Files
// changed) is the page's scroll inset (--pr-pinned, styles.css), so focus
// and jumps land below it.
const previewHeader = document.querySelector<HTMLElement>(".preview-header");
function syncStickyTop(): void {
  if (!mounted || !previewHeader || appState.previewMode.kind !== "pull-request") return;
  const heading = previewHeader.querySelector<HTMLElement>(".preview-heading");
  const toolbar = previewHeader.querySelector<HTMLElement>(".preview-toolbar");
  const stacked = heading && toolbar && toolbar.offsetTop >= heading.offsetTop + heading.offsetHeight - 1;
  // What stays above the tabs row once the rows over it scroll away: the
  // gap between them, never a sliver of those rows' controls.
  const headerStyle = getComputedStyle(previewHeader);
  const keep = Math.min(parseFloat(headerStyle.paddingTop) || 0, parseFloat(headerStyle.rowGap) || 0);
  const hide = stacked ? Math.max(0, toolbar.offsetTop - keep) : 0;
  previewHeader.style.setProperty("--pr-header-hide", `${hide}px`);
  // The title row's end holds Open on GitHub and the document actions (text
  // size; in the file view also copy and the outline): their measured width,
  // so the title and ↗ clear them.
  const actions = previewHeader.querySelector<HTMLElement>("#preview-action-bar");
  if (actions) {
    const width = actions.getBoundingClientRect().width;
    previewHeader.style.setProperty("--pr-text-size-width", `${Math.ceil(width) + 4}px`);
    const github = previewHeader.querySelector<HTMLElement>("#pr-view-github");
    const githubWidth = github && !github.hidden ? github.getBoundingClientRect().width + 8 : 0;
    previewHeader.style.setProperty("--pr-heading-actions", `${Math.ceil(width + githubWidth) + 12}px`);
  }
  const style = getComputedStyle(previewHeader);
  const pinned = style.position === "sticky" || style.position === "fixed";
  // Whole pixels, tucked 1px under the header's bottom edge (which paints
  // over what pins below it): no gap, however the header's height rounds.
  const top = pinned ? Math.max(0, Math.floor(previewHeader.getBoundingClientRect().height + (parseFloat(style.top) || 0)) - 1) : 0;
  mounted.root.style.setProperty("--pr-sticky-top", `${top}px`);
  // The file view's Diff is mounted in #preview itself.
  previewElement.style.setProperty("--pr-sticky-top", `${top}px`);
  const panel = mounted.tab === "file" ? previewElement : mounted.root.querySelector<HTMLElement>(`[data-pr-panel="${mounted.tab}"]`);
  const bar = panel?.querySelector<HTMLElement>(".pr-review-bar.is-active")?.offsetHeight ?? 0;
  const fileHeader = mounted.tab !== "conversation" ? panel?.querySelector<HTMLElement>(".pr-file-header")?.offsetHeight ?? 0 : 0;
  document.documentElement.style.setProperty("--pr-pinned", `${top + bar + fileHeader}px`);
}
const stickyObserver = typeof ResizeObserver === "function" ? new ResizeObserver(syncStickyTop) : null;
if (previewHeader) stickyObserver?.observe(previewHeader);
stickyObserver?.observe(previewElement);
window.addEventListener("resize", syncStickyTop);

// "Add line comments" (the review dialog, from any review button): open the
// pull request's Files changed (the Preview tab on touch) and a composer on
// its first file's first non-blank changed line, with focus in its text.
// Nothing is written until a comment is added.
document.addEventListener(ADD_LINE_COMMENTS_EVENT, event => {
  const target = (event as CustomEvent<{ repositoryId: string; number: number }>).detail;
  addLinesFor = target.number;
  revealPreviewSurface();
  if (mounted?.number === target.number && isLive(mounted) && appState.previewMode.kind === "pull-request") showTab("files");
  else activatePullRequestPreview({ repositoryId: target.repositoryId, number: target.number, tab: "files" }, { pushHistory: true });
  if (mounted?.number === target.number) addPendingLines(mounted);
});

function addPendingLines(view: Mounted): void {
  if (addLinesFor !== view.number || view.tab !== "files" || !view.files) return;
  addLinesFor = null;
  view.files.addLineComments();
}

// Jump to file, in the pinned tabs row on Files changed: named with the
// file count.
jumpButton?.addEventListener("click", () => {
  if (mounted?.tab === "files") mounted.files?.openJump(jumpButton);
  else if (mounted?.tab === "file") openFileJump(mounted, jumpButton);
});
function openFileJump(view: Mounted, opener: HTMLElement): void {
  if (!view.detail) return;
  openFileJumpDialog(view.detail, opener, { current: view.fileTarget?.path ?? null, onPick: path => openFile({ path, rev: "head" }) });
}
function syncJumpButton(view: Mounted): void {
  if (!jumpButton || mounted !== view) return;
  const count = view.detail?.files.length ?? 0;
  jumpButton.hidden = !((view.tab === "files" || view.tab === "file") && view.detail && count > 0);
  const name = `Jump to file (${count} ${count === 1 ? "file" : "files"})`;
  jumpButton.setAttribute("aria-label", name);
  jumpButton.title = name;
}

// On touch the title shows two lines; a tap on it shows the rest (and a
// second tap folds it again).
previewTitleElement.addEventListener("click", () => {
  if (appState.previewMode.kind !== "pull-request" || document.documentElement.dataset.uiMode !== "touch") return;
  previewTitleElement.toggleAttribute("data-expanded");
});

tabControl?.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-pr-tab]");
  if (!button || !mounted) return;
  showTab(button.dataset.prTab as PullRequestTab);
});

// ‹ n of m ›: the previous or next changed file, in tree order; the counter
// opens Jump to file.
fileNav?.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-pr-file-step], [data-pr-file-count]");
  if (!button || !mounted || button.disabled) return;
  if (button.dataset.prFileCount !== undefined) { openFileJump(mounted, button); return; }
  const path = button.dataset.prFileStep;
  if (path) openFile({ path, rev: "head" }, { keepFocus: button.dataset.prFileDirection });
});

// Tabs pattern: Left / Right (wrapping), Home and End move to a tab and
// show it.
tabControl?.addEventListener("keydown", event => {
  const tabs = [...(tabControl.querySelectorAll<HTMLButtonElement>("[data-pr-tab]:not([hidden])"))];
  const next = tabKeyIndex(tabs.indexOf(event.target as HTMLButtonElement), event.key, tabs.length);
  if (next === null || !mounted) return;
  event.preventDefault();
  tabs[next]!.focus();
  showTab(tabs[next]!.dataset.prTab as PullRequestTab);
});

// The submit dialog's pending-comment links ask the view to show a line.
document.addEventListener("uatu:pull-request-reveal", event => {
  const detail = (event as CustomEvent<{ number: number; path?: string; threadId?: string; pendingId?: string }>).detail;
  if (!mounted || mounted.number !== detail.number) return;
  showTab("files", { anchor: detail.threadId ? { thread: detail.threadId } : detail.path ? { file: detail.path } : undefined });
  mounted.files?.reveal({ path: detail.path, threadId: detail.threadId, pendingId: detail.pendingId });
});

// The pull requests on screen: this view's, and the workspace's current one
// (the Pull request pane's).
function shownNumbers(): number[] {
  const shown: number[] = [];
  if (appState.previewMode.kind === "pull-request") shown.push(appState.previewMode.number);
  const current = pullRequestStore.currentNumber();
  if (current !== null && !shown.includes(current)) shown.push(current);
  return shown;
}

let lastShown: number[] = [];

// Runs on every store change and view mount: what is on screen changed?
function syncShown(): void {
  const shown = shownNumbers();
  if (shown.length === 0) return;
  closePullRequestDialogsOutside(shown);
  const left = lastShown.filter(number => !shown.includes(number));
  lastShown = shown;
  for (const number of left) {
    const count = pullRequestStore.pendingCount(number);
    if (count === 0) continue;
    showToast(`Your review of #${number} is still pending: ${count} ${count === 1 ? "comment" : "comments"}, visible only to you until you finish it. The Pull request pane and the switcher mark it.`);
  }
}

pullRequestStore.subscribe(() => {
  syncShown();
  if (!mounted) return;
  if (!isLive(mounted) || appState.previewMode.kind !== "pull-request") {
    pullRequestStore.watch("view", null);
    if (mounted.tab === "file") closePullRequestFile();
    mounted = null;
    return;
  }
  // GitHub disconnected under an open view: nothing shown can be trusted or
  // sent any more, so the view gives way to the connect card.
  if (pullRequestStore.state.summary?.status === "no-credential") {
    if (mounted.detail || !mounted.root.querySelector(".gh-connect")) {
      renderUnavailable(mounted, new GithubRequestError(401, "GitHub isn't connected for this workspace."));
    }
    return;
  }
  const detail = pullRequestStore.detail(mounted.number);
  const summary = pullRequestStore.state.summary?.pullRequest;
  // The summary moved past the detail we show: re-read it (design D5).
  if (detail && summary && summary.number === mounted.number && !mounted.loading
    && (summary.updatedAt !== detail.summary.updatedAt || summary.headRefOid !== detail.summary.headRefOid
      || summary.reviewDecision !== detail.summary.reviewDecision || summary.checks.pending !== detail.summary.checks.pending)) {
    void load(mounted);
    return;
  }
  if (detail && detail !== mounted.detail) present(mounted, detail);
  else if (!detail && !mounted.detail && !mounted.loading && mounted.root.querySelector(".gh-connect")) void load(mounted);
  else syncAvailability(mounted);
});

registerPullRequestPreviewRenderer((mode, options) => renderPullRequestPreview(mode, options));

// After the user opens a pull request (the Pull request pane, Browse pull
// requests): its heading takes focus, so the next Tab reaches its tabs, and
// a stacked layout (a narrow window: the sidebar above the preview) scrolls
// the preview into view first. From the pane, focus moves only when the
// preview had to come into view or the pane went out of sight (touch mode's
// Files tab); `always` is for an opener that is gone (a closed dialog).
let keepPreviewAtTop = false;

// The page scrolls in the stacked layout; the preview's top goes to the
// viewport's top (not scrollIntoView: the page's scroll-padding for the
// sticky preview header would stop it short).
function scrollShellToTop(shell: HTMLElement): void {
  const root = document.scrollingElement ?? document.documentElement;
  root.scrollTop += shell.getBoundingClientRect().top;
}

export function revealPullRequestHeading(options: { always?: boolean } = {}): void {
  requestAnimationFrame(() => {
    const shell = document.querySelector<HTMLElement>(".preview-shell");
    const top = shell?.getBoundingClientRect().top ?? 0;
    const offScreen = shell !== null && (top > window.innerHeight / 2 || shell.getBoundingClientRect().bottom < 0);
    if (offScreen) {
      scrollShellToTop(shell);
      // Still loading, the page may be too short to bring the preview to
      // the top: present() finishes the scroll once the detail is in.
      keepPreviewAtTop = shell.getBoundingClientRect().top > 1;
    }
    const active = document.activeElement as HTMLElement | null;
    const focusLost = !active || active === document.body || !active.checkVisibility();
    if (!options.always && !offScreen && !focusLost) return;
    previewTitleElement.tabIndex = -1;
    previewTitleElement.focus({ preventScroll: true });
  });
}

export function renderPullRequestPreview(mode: Mode, options: PullRequestRenderOptions = {}): void {
  if (deferHiddenPreview(() => {
    if (appState.previewMode.kind === "pull-request") renderPullRequestPreview(appState.previewMode, options);
  })) return;
  const fileTarget: FileTarget | null = options.tab === "file" && options.path ? { path: options.path, rev: options.rev ?? "head" } : null;
  if (mounted && isLive(mounted) && mounted.repositoryId === mode.repositoryId && mounted.number === mode.number) {
    if (fileTarget) {
      openFile(fileTarget, { fromUrl: true });
      return;
    }
    if (options.tab && options.tab !== mounted.tab) {
      showTab(options.tab, { fromUrl: true });
      mounted.revealedAnchor = null;
    }
    revealAnchor(mounted, anchorOf(options));
    return;
  }
  releaseMediaPreview();
  closeMermaidViewer();
  closePullRequestFile();
  clearPreviewType();
  hideViewToggle();
  previewBaseElement.href = new URL(appUrl("/"), window.location.origin).toString();
  previewElement.classList.remove("empty");
  previewTitleElement.textContent = `Pull request #${mode.number}`;
  previewTitleElement.removeAttribute("data-expanded");
  previewPathElement.textContent = "Reading GitHub…";
  const root = document.createElement("section");
  root.className = "pr-view";
  root.innerHTML = `<div class="pr-view-banner" data-pr-banner hidden></div>
      <div class="pr-view-meta" data-pr-meta></div>
      <div id="pr-panel-conversation" role="tabpanel" aria-labelledby="pr-tab-conversation" data-pr-panel="conversation"><p class="pr-muted">Reading the pull request…</p></div>
      <div id="pr-panel-files" role="tabpanel" aria-labelledby="pr-tab-files" data-pr-panel="files" hidden></div>`;
  // The file view's content takes the preview; the panels wait aside.
  if (!fileTarget) previewElement.replaceChildren(root);
  // Another pull request starts at its top, not at the last one's offset.
  previewScrollRoot().scrollTop = 0;
  if (mounted) stickyObserver?.unobserve(mounted.root);
  mounted = { repositoryId: mode.repositoryId, number: mode.number, tab: options.tab === "files" ? "files" : "conversation", root, detail: null, files: null, composer: null, loading: false, pendingAnchor: null, revealedAnchor: null, fileTarget: null };
  // A review bar or file header appearing (or changing height) changes
  // what is pinned.
  stickyObserver?.observe(root);
  syncStickyTop();
  // On screen now: focus and Retry re-read it, and dialogs for another
  // pull request close.
  pullRequestStore.watch("view", mode.number);
  syncShown();
  // Nothing about this pull request is known yet: no counts from the last
  // one, no review state, and no GitHub link until its URL is.
  setHeaderDetail(null);
  renderHeaderReview(mounted);
  syncTabs(mounted);
  const cached = pullRequestStore.detail(mode.number);
  if (cached) present(mounted, cached);
  if (fileTarget) openFile(fileTarget, { fromUrl: true });
  revealAnchor(mounted, anchorOf(options));
  void load(mounted);
  // Opening a pull request view is a refresh trigger (design D6).
  if (pullRequestStore.state.enabled !== false) void pullRequestStore.refresh(false);
}

const anchorOf = (options: { file?: string; thread?: string }): Anchor | null =>
  options.thread ? { thread: options.thread } : options.file ? { file: options.file } : null;

// Scrolls Files changed to the URL's file or thread (focusing the thread)
// once it is mounted (present() retries after the detail arrives).
function revealAnchor(view: Mounted, anchor: Anchor | null): void {
  if (anchor && anchorKey(anchor) !== view.revealedAnchor) view.pendingAnchor = anchor;
  const pending = view.pendingAnchor;
  if (!pending || !view.files || view.tab !== "files") return;
  view.files.reveal({ path: pending.file, threadId: pending.thread });
  view.revealedAnchor = anchorKey(pending);
  view.pendingAnchor = null;
}

// Files changed reports where a jump landed (Jump to file, a pending
// comment's link): the URL keeps it in place, so a reload lands there too.
document.addEventListener("uatu:pull-request-anchor", event => {
  const anchor = (event as CustomEvent<Anchor & { number: number }>).detail;
  if (!mounted || mounted.number !== anchor.number || mounted.tab !== "files") return;
  replacePullRequestPreview(mounted.repositoryId, mounted.number, "files", { file: anchor.file, thread: anchor.thread });
  mounted.revealedAnchor = anchorKey(anchor);
});

async function load(view: Mounted): Promise<void> {
  view.loading = true;
  try {
    const detail = await pullRequestStore.loadDetail(view.number, view.repositoryId);
    view.loading = false;
    if (mounted === view) present(view, detail);
  } catch (error) {
    view.loading = false;
    if (mounted === view && !view.detail) renderUnavailable(view, error);
  }
}

// A tab switch is a history entry, and so is a jump from Conversation to a
// thread in Files changed (`anchor`: View in diff); a navigation (`fromUrl`)
// already wrote it, including any `file=` or `thread=`.
function showTab(tab: PullRequestTab, options: { fromUrl?: boolean; anchor?: Anchor } = {}): void {
  if (!mounted) return;
  if (tab === "file") {
    if (mounted.fileTarget) openFile(mounted.fileTarget, { fromUrl: options.fromUrl });
    return;
  }
  if ((mounted.tab !== tab || options.anchor) && !options.fromUrl) {
    pushPullRequestPreview(mounted.repositoryId, mounted.number, tab, tab === "files" ? options.anchor : undefined);
  }
  if (options.anchor) mounted.revealedAnchor = anchorKey(options.anchor);
  if (mounted.tab === "file") leaveFile(mounted);
  mounted.tab = tab;
  syncTabs(mounted);
  if (tab === "files" && mounted.detail && !mounted.files) mountFiles(mounted, mounted.detail);
  renderHeaderReview(mounted);
  syncJumpButton(mounted);
  syncFileNav(mounted);
  syncTitle(mounted);
  addPendingLines(mounted);
}

// Opens a file of this pull request in the file view: from the Files pane's
// PR scope, View file, ‹ ›, Jump to file, a relative link, or the URL.
function openFile(target: FileTarget, options: { fromUrl?: boolean; keepFocus?: string } = {}): void {
  const view = mounted;
  if (!view) return;
  if (!options.fromUrl) pushPullRequestPreview(view.repositoryId, view.number, "file", { path: target.path, rev: target.rev });
  if (view.tab !== "file") {
    // Set aside, not destroyed: drafts and the diff wait for the way back.
    view.root.remove();
    view.tab = "file";
  }
  view.fileTarget = target;
  syncTabs(view);
  renderHeaderReview(view);
  syncJumpButton(view);
  syncFileNav(view);
  syncTitle(view);
  showPullRequestFile({ repositoryId: view.repositoryId, number: view.number, open: next => openFile(next) }, target, view.detail);
  syncStickyTop();
  // The Files pane's PR scope selects its row.
  document.dispatchEvent(new CustomEvent("uatu:pull-request-file-open", { detail: { path: target.path } }));
  // ‹ and › keep focus on themselves while stepping (or on the other one at
  // either end).
  if (options.keepFocus) {
    const step = fileNav?.querySelector<HTMLButtonElement>(`[data-pr-file-direction="${options.keepFocus}"]`);
    const other = fileNav?.querySelector<HTMLButtonElement>(`[data-pr-file-direction="${options.keepFocus === "next" ? "previous" : "next"}"]`);
    (step && !step.disabled ? step : other)?.focus({ preventScroll: true });
  }
}

// View file (a Files changed header): the file itself, Rendered for
// documents and Source otherwise; a reviewer reading in Diff leaves it.
function viewFile(path: string): void {
  if (appState.viewMode === "diff") {
    const kind = kindOfPath(path);
    // Before the file view is up, so the switch reloads nothing.
    applyViewMode(kind === "markdown" || kind === "asciidoc" ? "rendered" : "source");
  }
  revealPreviewSurface();
  openFile({ path, rev: "head" });
}

// Back to Conversation or Files changed: the file view's chrome goes and the
// panels return.
function leaveFile(view: Mounted): void {
  closePullRequestFile();
  previewElement.replaceChildren(view.root);
  document.dispatchEvent(new CustomEvent("uatu:pull-request-file-open", { detail: { path: null } }));
}

function syncTabs(view: Mounted): void {
  // Files changed leaves out the facts band (styles.css).
  view.root.dataset.prTab = view.tab;
  if (fileTab) {
    fileTab.hidden = view.fileTarget === null;
    const label = fileTab.querySelector<HTMLElement>("[data-pr-tab-file-name]");
    const path = view.fileTarget?.path ?? "";
    if (label) label.textContent = path.split("/").at(-1) ?? path;
    fileTab.title = path;
    fileTab.setAttribute("aria-label", path ? `File ${path}${view.fileTarget?.rev === "base" ? " at the base" : ""}` : "File");
  }
  tabControl?.toggleAttribute("data-file-open", view.tab === "file");
  for (const button of tabControl?.querySelectorAll<HTMLButtonElement>("[data-pr-tab]") ?? []) {
    const active = button.dataset.prTab === view.tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of view.root.querySelectorAll<HTMLElement>("[data-pr-panel]")) {
    panel.hidden = panel.dataset.prPanel !== view.tab;
  }
}

// ‹ n of m › in the tabs row while a file is open.
function syncFileNav(view: Mounted): void {
  if (!fileNav || mounted !== view) return;
  const target = view.fileTarget;
  if (view.tab !== "file" || !target || !view.detail) {
    fileNav.hidden = true;
    return;
  }
  const files = inTreeOrder(view.detail.files);
  const index = files.findIndex(file => file.path === target.path);
  const previous = index > 0 ? files[index - 1]! : null;
  const next = index >= 0 && index < files.length - 1 ? files[index + 1]! : null;
  const count = index >= 0 ? `${index + 1} of ${files.length}` : `${files.length} changed`;
  const focused = fileNav.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.prFileDirection ?? "count" : null;
  fileNav.hidden = false;
  fileNav.innerHTML = `<button type="button" class="pr-file-step" data-pr-file-direction="previous"${previous ? ` data-pr-file-step="${escapeHtmlAttribute(previous.path)}" aria-label="Previous file: ${escapeHtmlAttribute(previous.path)}" title="Previous file: ${escapeHtmlAttribute(previous.path)}"` : ` disabled aria-label="Previous file (this is the first)"`}>‹</button>
    <button type="button" class="pr-file-count" data-pr-file-count aria-label="${index >= 0 ? `File ${index + 1} of ${files.length} changed files` : `Not a changed file; ${files.length} files changed`}: jump to file" title="Jump to file"><span class="pr-file-count-long">${count}</span><span class="pr-file-count-short" aria-hidden="true">${index >= 0 ? `${index + 1}/${files.length}` : `–/${files.length}`}</span></button>
    <button type="button" class="pr-file-step" data-pr-file-direction="next"${next ? ` data-pr-file-step="${escapeHtmlAttribute(next.path)}" aria-label="Next file: ${escapeHtmlAttribute(next.path)}" title="Next file: ${escapeHtmlAttribute(next.path)}"` : ` disabled aria-label="Next file (this is the last)"`}>›</button>`;
  if (focused) {
    const again = focused === "count" ? fileNav.querySelector<HTMLButtonElement>("[data-pr-file-count]") : fileNav.querySelector<HTMLButtonElement>(`[data-pr-file-direction="${focused}"]`);
    (again && !again.disabled ? again : fileNav.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
  }
}

// The title: the pull request's, or on touch while a file is open, the file
// (the number stays beside it).
function syncTitle(view: Mounted): void {
  if (mounted !== view) return;
  const touch = document.documentElement.dataset.uiMode === "touch";
  if (view.tab === "file" && view.fileTarget && touch) {
    previewTitleElement.textContent = view.fileTarget.path;
    previewTitleElement.title = view.detail ? view.detail.summary.title : "";
  } else {
    previewTitleElement.textContent = view.detail ? view.detail.summary.title : `Pull request #${view.number}`;
    previewTitleElement.removeAttribute("title");
  }
}

function mountFiles(view: Mounted, detail: PullRequestDetail): void {
  const panel = view.root.querySelector<HTMLElement>('[data-pr-panel="files"]')!;
  view.files = mountFilesChanged(panel, detail, view.repositoryId, { onViewFile: viewFile });
}

function present(view: Mounted, detail: PullRequestDetail): void {
  const first = view.detail === null;
  view.detail = detail;
  const pr = detail.summary;
  if (first) {
    // A connect card or failure from an earlier state gives way.
    for (const panel of view.root.querySelectorAll<HTMLElement>("[data-pr-panel]")) panel.innerHTML = "";
    view.files = null;
  }
  syncTitle(view);
  renderPathLine(detail);
  setHeaderDetail(detail);
  view.root.querySelector<HTMLElement>("[data-pr-meta]")!.innerHTML = `${stateBadge(pr)}
    <span><strong>${escapeHtml(pr.author)}</strong> opened ${escapeHtml(age(pr.createdAt))}</span>
    <span>${branchesHtml(pr)}</span>
    <span>${pr.commits} ${pr.commits === 1 ? "commit" : "commits"} · ${pr.changedFiles} ${pr.changedFiles === 1 ? "file" : "files"} · <span class="gh-add">+${pr.additions}</span> <span class="gh-del">−${pr.deletions}</span></span>
    ${mockNotice(detail.mock)}`;
  if (first) mountConversation(view, detail);
  else renderTimeline(view, detail);
  if (first && keepPreviewAtTop) {
    keepPreviewAtTop = false;
    requestAnimationFrame(() => {
      const shell = document.querySelector<HTMLElement>(".preview-shell");
      if (shell) scrollShellToTop(shell);
    });
  }
  if (view.files) view.files.update(detail);
  else if (view.tab === "files") mountFiles(view, detail);
  if (view.tab === "file") updatePullRequestFile(detail);
  syncAvailability(view);
  syncJumpButton(view);
  syncFileNav(view);
  revealAnchor(view, null);
  addPendingLines(view);
}

// "#642 · owner/repo". A viewed pull request (not the checked-out branch's)
// says so in the switcher's Viewing strip above the header, not here.
function renderPathLine(detail: PullRequestDetail): void {
  const pr = detail.summary;
  const html = `#${pr.number}<span class="pr-path-repo"> · ${escapeHtml(detail.repository.owner)}/${escapeHtml(detail.repository.name)}</span>`;
  // Unchanged and still there (another preview rewrites the line): kept.
  if (pathLineHtml === html && previewPathElement.querySelector(".pr-path-repo")) return;
  pathLineHtml = html;
  previewPathElement.innerHTML = html;
}
let pathLineHtml = "";

// The header's tab counts and GitHub link follow the detail shown. Without
// one (loading, no credential, an error) the link goes, and in the no-detail
// views (`tabs: false`) the tabs go too: both panels show the same card.
function setHeaderDetail(detail: PullRequestDetail | null, options: { tabs?: boolean } = {}): void {
  const conversationCount = tabControl?.querySelector<HTMLElement>('[data-pr-tab-count="conversation"]');
  const filesCount = tabControl?.querySelector<HTMLElement>('[data-pr-tab-count="files"]');
  if (conversationCount) conversationCount.textContent = detail ? String(detail.timeline.filter(item => item.kind !== "merged").length + 1) : "";
  if (filesCount) filesCount.textContent = detail ? String(detail.files.length) : "";
  if (githubLink) {
    githubLink.hidden = !detail;
    if (detail) githubLink.href = detail.summary.url;
    else githubLink.removeAttribute("href");
  }
  if (tabControl) tabControl.hidden = options.tabs === false;
}

// Whether GitHub takes writes now, applied to the banner and every sending
// control; runs on every store change.
function syncAvailability(view: Mounted): void {
  renderBanner(view);
  if (!view.detail) return;
  view.composer?.setBlocked(sendBlockedReason(pullRequestStore.state.summary, view.detail.summary));
  // Readiness turns "last known" while GitHub can't be asked, and back.
  renderMergeBox(view, view.detail);
  // Picking this pull request (or going back) changes the header's cue.
  if (mounted === view) renderPathLine(view.detail);
  renderConversationBar(view);
  view.files?.syncAvailability();
}

// Conversation shows the pending review too (count, Discard, Finish), so
// finishing it never needs a detour through Files changed.
function renderConversationBar(view: Mounted): void {
  const bar = view.root.querySelector<HTMLElement>("[data-pr-conversation-bar]");
  if (bar && view.detail) renderReviewBar(bar, view.detail, view.repositoryId, {
    surface: "conversation",
    // Finished from here, the bar goes: focus moves to the Conversation tab.
    fallbackFocus: activeTabButton,
  });
  renderHeaderReview(view);
}

// The tab shown: where focus goes when the review controls it was on are
// gone (a review published or discarded, the bar moved).
const activeTabButton = () => tabControl?.querySelector<HTMLElement>('[data-pr-tab][aria-selected="true"]') ?? null;

// The review button in the tabs row, touch and desktop (diff-review.ts
// reviewBarShownOn), pinned with it while the diff scrolls.
function renderHeaderReview(view: Mounted): void {
  if (!headerReview) return;
  if (!view.detail || mounted !== view) {
    headerReview.hidden = true;
    headerReview.innerHTML = "";
    return;
  }
  renderReviewBar(headerReview, view.detail, view.repositoryId, {
    surface: "header",
    tab: view.tab,
    fallbackFocus: activeTabButton,
  });
  syncStickyTop();
}

// The review button's place follows the mode, and so does the title.
const relayout = () => {
  if (mounted?.detail) syncAvailability(mounted);
  if (mounted) syncTitle(mounted);
};
onUiModeChange(relayout);

// Stale data (rate-limited or unreachable) stays visible under a banner that
// says how old it is, with Retry (mockup 6): for the branch's pull request
// and a viewed one alike.
function renderBanner(view: Mounted): void {
  const banner = view.root.querySelector<HTMLElement>("[data-pr-banner]")!;
  const summary = pullRequestStore.state.summary;
  const notice = staleNotice(summary);
  const notLinked = notLinkedNotice(view);
  if (!summary || !view.detail || (!notice && !notLinked)) {
    banner.hidden = true;
    banner.innerHTML = "";
    banner.className = "pr-view-banner";
    return;
  }
  const retry = pullRequestStore.state.retry;
  const retryText = notice ? retryNoticeText(retry, summary.status, clockTimeWithSeconds) : null;
  const key = `${summary.status}\n${summary.checkedAt}\n${notice?.why ?? notLinked}\n${retryText ?? ""}`;
  if (!banner.hidden && banner.dataset.key === key) return;
  banner.dataset.key = key;
  banner.hidden = false;
  banner.setAttribute("role", "status");
  if (!notice) {
    banner.className = "pr-view-banner is-neutral";
    banner.textContent = notLinked;
    return;
  }
  banner.className = "pr-view-banner";
  const running = retry?.status === "running";
  const hadFocus = banner.contains(document.activeElement);
  banner.innerHTML = `<strong>${escapeHtml(notice.title)}.</strong> ${escapeHtml(notice.why)} Showing #${view.number} as of ${escapeHtml(clockTime(summary.checkedAt))}.
    <button type="button" class="gh-button" data-pr-retry${running ? " disabled" : ""}>${running ? "Retrying…" : "Retry"}</button>${retryText && !running ? `<span class="pr-retry-note">${escapeHtml(retryText)}</span>` : ""}<span class="pr-muted">Comments and reviews are paused; drafts are kept.</span>`;
  banner.querySelector("[data-pr-retry]")!.addEventListener("click", () => void pullRequestStore.retry());
  // Focus on Retry stays on it across the retry's re-renders (a disabled
  // button can't hold it: the banner does meanwhile).
  if (hadFocus) {
    const button = banner.querySelector<HTMLButtonElement>("[data-pr-retry]")!;
    if (button.disabled) {
      banner.tabIndex = -1;
      banner.focus({ preventScroll: true });
    } else button.focus({ preventScroll: true });
  }
}

// GitHub says the checked-out branch has no pull request, but this view (not
// a pick) shows one whose head is that branch, by its URL: say so, so it
// never reads as the branch's pull request.
function notLinkedNotice(view: Mounted): string | null {
  const summary = pullRequestStore.state.summary;
  const pr = view.detail?.summary;
  const branch = pullRequestStore.state.branch;
  if (summary?.status !== "no-pull-request" || !pr || !branch || pullRequestStore.scopedNumber() === view.number) return null;
  return `GitHub reports no pull request for ${branch}. #${pr.number} is shown because the address names it; it isn't linked to the checked-out branch.`;
}

function mountConversation(view: Mounted, detail: PullRequestDetail): void {
  const panel = view.root.querySelector<HTMLElement>('[data-pr-panel="conversation"]')!;
  panel.innerHTML = `<div class="pr-conversation">
      <div class="pr-review-bar" data-pr-conversation-bar role="region" aria-label="Your review" hidden></div>
      <div class="pr-timeline" data-pr-timeline></div>
      <div class="pr-omitted-slot" data-pr-conversation-omitted></div>
      <div class="pr-event pr-merge-box" data-pr-merge-box></div>
      <div class="pr-event pr-event-composer">
        ${avatar(detail.viewer)}
        <div class="pr-event-main" data-pr-composer></div>
      </div>
    </div>`;
  const composer = createComposer({
    tabs: true,
    rows: 4,
    // Said before typing: unlike line comments, this one isn't held for a
    // review.
    placeholder: `Comment on #${detail.summary.number} — posts immediately`,
    label: `Comment on #${detail.summary.number} as ${detail.viewer} (posts immediately)`,
    submitLabel: "Comment",
    draftName: `your comment on #${detail.summary.number}`,
    note: "Comments post immediately; line comments go into your pending review.",
    draft: { target: { repositoryId: view.repositoryId, number: view.number }, location: { kind: "conversation" } },
    sentAgainst: () => view.detail ?? detail,
    blockedReason: sendBlockedReason(pullRequestStore.state.summary, detail.summary),
    send: async body => {
      const next = await githubApi.comment({ repository: view.repositoryId, number: view.number }, body);
      return () => pullRequestStore.applyDetail(next);
    },
  });
  panel.querySelector<HTMLElement>("[data-pr-composer]")!.append(composer.element);
  view.composer = composer;
  renderTimeline(view, detail);
}

function renderTimeline(view: Mounted, detail: PullRequestDetail): void {
  const timeline = view.root.querySelector<HTMLElement>("[data-pr-timeline]");
  if (!timeline) return;
  const pr = detail.summary;
  timeline.innerHTML = [
    eventHtml(pr.author, `<strong>${escapeHtml(pr.author)}</strong> opened this pull request · ${escapeHtml(age(pr.createdAt))}`,
      detail.bodyHtml || `<p class="pr-muted">No description provided.</p>`, "", "pr-description"),
    ...detail.timeline.map(item => timelineItemHtml(item, detail)),
  ].join("");
  // GitHub's task lists render as bare checkboxes: name each by its item.
  for (const checkbox of timeline.querySelectorAll<HTMLInputElement>(".markdown-body input[type=checkbox]")) {
    const item = checkbox.closest("li");
    const text = item?.textContent?.trim().replace(/\s+/g, " ") ?? "";
    if (text && !checkbox.hasAttribute("aria-label")) checkbox.setAttribute("aria-label", text);
  }
  const omitted = view.root.querySelector<HTMLElement>("[data-pr-conversation-omitted]");
  if (omitted) omitted.innerHTML = omittedNoteHtml(omittedNotes(detail, "conversation"), pr.url);
  renderMergeBox(view, detail);
  for (const button of timeline.querySelectorAll<HTMLButtonElement>("[data-view-in-diff]")) {
    button.addEventListener("click", () => {
      const threadId = button.dataset.viewInDiff!;
      showTab("files", { anchor: { thread: threadId } });
      view.files?.reveal({ threadId });
    });
  }
}

// Read-only merge readiness, where GitHub has its merge box; merging itself
// is a link to GitHub (design D11).
function renderMergeBox(view: Mounted, detail: PullRequestDetail): void {
  const box = view.root.querySelector<HTMLElement>("[data-pr-merge-box]");
  if (!box) return;
  const pr = detail.summary;
  const summary = pullRequestStore.state.summary;
  const readiness = mergeReadinessView(pr, detail.mergeReadiness, summary && staleNotice(summary) ? clockTime(summary.checkedAt) : null);
  // Stale: dimmed, and no merge-green, as the pane shows it.
  box.className = `pr-event pr-merge-box is-${readiness.tone}${readiness.stale ? " is-stale" : ""}`;
  // Rewritten only when it says something new: a focused link stays.
  const html = `<span class="pr-merge-box-icon" aria-hidden="true">${readiness.tone === "ready" ? "✓" : readiness.tone === "blocked" ? "!" : "●"}</span>
    <div class="pr-event-main pr-card">
      <div class="pr-card-body">
        <h3 class="pr-merge-box-title">${escapeHtml(readiness.tone === "blocked" && !readiness.stale ? "Merging is blocked" : readiness.headline)}</h3>
        ${pr.state === "OPEN" ? `<p class="pr-merge-box-facts">${reviewDecisionBadge(pr.reviewDecision)} <span>${checksSummaryHtml(pr.checks)}</span></p>` : ""}
        ${readiness.reasons.length ? `<ul class="pr-merge-box-reasons">${readiness.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}
        ${readiness.pendingNote && pr.state === "OPEN" ? `<p class="pr-merge-box-pending">${escapeHtml(readiness.pendingNote)}</p>` : ""}
        ${readiness.notes.length ? `<p class="pr-muted">${readiness.notes.map(escapeHtml).join(" ")}</p>` : ""}
        ${pr.state === "OPEN" ? `<p>${mergeLinkHtml(pr.url, readiness.tone === "ready" && !readiness.stale)}</p><p class="pr-muted pr-merge-box-note">uatu doesn't merge: GitHub handles merge queues, rulesets and stacked pull requests.</p>` : ""}
      </div>
    </div>`;
  if (mergeBoxHtml.get(box) !== html) {
    mergeBoxHtml.set(box, html);
    box.innerHTML = html;
  }
}
const mergeBoxHtml = new WeakMap<HTMLElement, string>();

function eventHtml(author: string, header: string, bodyHtml: string, aside: string, extraClass = ""): string {
  return `<article class="pr-event ${extraClass}">
      ${avatar(author)}
      <div class="pr-event-main pr-card">
        <header class="pr-card-header"><span>${header}</span>${aside}</header>
        <div class="pr-card-body markdown-body">${bodyHtml}</div>
      </div>
    </article>`;
}

function timelineItemHtml(item: TimelineItem, detail: PullRequestDetail): string {
  if (item.kind === "comment") {
    const comment = item.comment;
    return eventHtml(comment.author, `<strong>${escapeHtml(comment.author)}</strong> commented · ${escapeHtml(age(comment.createdAt))}`, comment.bodyHtml, "");
  }
  if (item.kind === "merged") {
    return `<div class="pr-event pr-event-line"><span class="gh-state gh-state-merged">Merged</span>
      <span><strong>${escapeHtml(item.actor)}</strong> merged this pull request${item.method ? ` (${escapeHtml(item.method.toLowerCase())})` : ""} · ${escapeHtml(age(item.at))}${item.deletedBranch ? ` · <code>${escapeHtml(detail.summary.headRefName)}</code> deleted on GitHub` : ""}</span></div>`;
  }
  const badge = item.state === "APPROVED" ? `<span class="gh-pill gh-pill-success">✓ Approved</span>`
    : item.state === "CHANGES_REQUESTED" ? `<span class="gh-pill gh-pill-danger">Changes requested</span>`
    : `<span class="gh-pill">Commented</span>`;
  const threads = item.threadIds.map(id => detail.threads.find(thread => thread.id === id)).filter((thread): thread is ReviewThread => Boolean(thread));
  const body = `${item.bodyHtml}${threads.map(thread => threadSummaryHtml(thread)).join("")}`;
  return eventHtml(item.author, `<strong>${escapeHtml(item.author)}</strong> reviewed · ${escapeHtml(age(item.submittedAt))}`,
    body || `<p class="pr-muted">No summary.</p>`, badge, "pr-review");
}

function threadSummaryHtml(thread: ReviewThread): string {
  const first = thread.comments[0];
  const replies = thread.comments.length - 1;
  const placed = thread.line !== null && !thread.isOutdated;
  return `<div class="pr-thread-summary">
      <div class="pr-thread-summary-head">
        <code class="gh-ref">${escapeHtml(thread.path)}</code>
        <span class="pr-muted">${placed ? `line ${thread.line}` : thread.subjectType === "FILE" ? "file" : "outdated"}</span>
        <span class="pr-thread-summary-aside">
          ${thread.isResolved ? `<span class="gh-pill">Resolved</span>` : `<span class="gh-pill gh-pill-attention">Unresolved</span>`}
          ${replies > 0 ? `<span class="pr-muted">${replies} ${replies === 1 ? "reply" : "replies"}</span>` : ""}
          ${placed ? `· <button type="button" class="gh-link-button" data-view-in-diff="${escapeHtmlAttribute(thread.id)}">View in diff →</button>` : ""}
        </span>
      </div>
      ${thread.lineText ? `<pre class="pr-thread-summary-line"><code>${thread.side === "RIGHT" ? "+" : "−"} ${escapeHtml(thread.lineText)}</code></pre>` : ""}
      ${first ? `<div class="pr-thread-summary-comment">${avatar(first.author, "sm")}<div class="markdown-body">${first.bodyHtml}</div></div>` : ""}
    </div>`;
}

// No detail could be read (no credential, unknown PR, GitHub down with no
// last result). The title says so, and the body gives the next step.
function renderUnavailable(view: Mounted, error: unknown): void {
  // The header keeps naming the pull request; the card below says why it
  // can't be shown (said once: the Pull request pane keeps to one line).
  previewTitleElement.textContent = `Pull request #${view.number}`;
  const summary = pullRequestStore.state.summary;
  const repository = summary?.repository ? `${summary.repository.owner}/${summary.repository.name}` : "";
  const noCredential = error instanceof GithubRequestError && error.status === 401;
  previewPathElement.textContent = [`#${view.number}`, repository, noCredential ? "GitHub not connected" : "unavailable"].filter(Boolean).join(" · ");
  pathLineHtml = "";
  view.root.querySelector<HTMLElement>("[data-pr-meta]")!.innerHTML = noCredential ? mockNotice(Boolean(summary?.mock)) : "";
  // The file view gives way too: the card shows on the panels.
  if (view.tab === "file") {
    leaveFile(view);
    view.tab = "conversation";
    if (fileNav) fileNav.hidden = true;
  }
  // What was shown (and its composers) goes: it can't be refreshed or sent.
  view.detail = null;
  view.files = null;
  view.composer = null;
  setHeaderDetail(null, { tabs: false });
  renderHeaderReview(view);
  renderBanner(view);
  syncJumpButton(view);
  for (const tab of ["conversation", "files"] as const) {
    const panel = view.root.querySelector<HTMLElement>(`[data-pr-panel="${tab}"]`)!;
    panel.innerHTML = noCredential ? connectGithubHtml("card", githubWorkspaceName()) : `<div class="gh-state-card gh-state-card-danger">
      <p class="gh-state-card-eyebrow">Pull request #${view.number}</p>
      <h3>Couldn't load this pull request</h3>
      <p>${escapeHtml(errorMessage(error))}</p>
      <p><button type="button" class="gh-button" data-pr-retry>Retry</button></p>
    </div>`;
    panel.querySelector("[data-pr-retry]")?.addEventListener("click", () => void load(view));
  }
  syncTabs(view);
}

// The workspace a GitHub credential is assigned to, for the connect guidance.
export function githubWorkspaceName(): string {
  return appState.repositories.find(repository => repository.metadata.status === "git")?.label ?? "this workspace";
}
