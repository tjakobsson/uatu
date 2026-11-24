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
// summary on every store change, for the branch's pull request and a picked
// one alike: stale data shows under a banner and sending waits (Retry says
// what it is doing, then the new answer); without a credential the view gives
// way to the "connect GitHub" card on both tabs. Conversation opens with the
// pending-review bar while a review is pending (Discard, Finish review (n);
// the same bar as Files changed) and ends with the read-only merge readiness
// and "Merge on GitHub ↗": uatu never merges. "Start review" from the Pull
// request pane opens Files changed with focus on the first file's line
// numbers. In a short touch viewport the preview header scrolls away and the
// review bars pin at the top (--pr-sticky-top follows the header).
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
  externalLink,
  mockNotice,
  reviewDecisionBadge,
  stateBadge,
} from "../github/present";
import { mergeReadinessView } from "../github/readiness";
import type { PullRequestDetail, ReviewThread, TimelineItem } from "../shared/github-contract";
import { appUrl, hubUrl, isHubPage } from "../shared/app-url";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { appState } from "../shell/state";
import { pushPullRequestPreview } from "../shell/history";
import { activatePullRequestPreview, registerPullRequestPreviewRenderer } from "../shell/url";
import { previewScrollRoot } from "../shell/preview-scroll-root";
import { releaseMediaPreview } from "../media/preview";
import { clearPreviewType } from "./header";
import { closeMermaidViewer } from "./mermaid-viewer";
import { hideViewToggle } from "./view-mode";
import { deferHiddenPreview } from "./deferred";
import { createComposer, tabKeyIndex, type Composer } from "./pr-composer";
import { draftAlreadySent } from "./pr-drafts";
import { mountFilesChanged, renderReviewBar, type FilesChangedView } from "./diff-review";
import { closePullRequestDialogsOutside, showToast } from "./review-dialogs";

export type PullRequestTab = "conversation" | "files";
type Mode = { kind: "pull-request"; repositoryId: string; number: number };

const previewElement = document.querySelector<HTMLElement>("#preview")!;
const previewTitleElement = document.querySelector<HTMLElement>("#preview-title")!;
const previewPathElement = document.querySelector<HTMLElement>("#preview-path")!;
const previewBaseElement = document.querySelector<HTMLBaseElement>("#preview-base")!;
const tabControl = document.querySelector<HTMLElement>("#pr-view-control");
const githubLink = document.querySelector<HTMLAnchorElement>("#pr-view-github");

type Mounted = {
  repositoryId: string;
  number: number;
  tab: PullRequestTab;
  root: HTMLElement;
  detail: PullRequestDetail | null;
  files: FilesChangedView | null;
  composer: Composer | null;
  loading: boolean;
  // The URL's `file=`: waiting to be scrolled to, and last scrolled to (a
  // re-render with the same one leaves the scroll position alone).
  pendingFile: string | null;
  revealedFile: string | null;
};

let mounted: Mounted | null = null;
// Start review asked for this pull request: Files changed focuses its first
// line once mounted.
let startReviewFor: number | null = null;

// The review bars pin under the preview's sticky header; in a short touch
// viewport the header scrolls away (styles.css), so they pin at the top.
const previewHeader = document.querySelector<HTMLElement>(".preview-header");
function syncStickyTop(): void {
  if (!mounted || !previewHeader) return;
  const style = getComputedStyle(previewHeader);
  const pinned = style.position === "sticky" || style.position === "fixed";
  mounted.root.style.setProperty("--pr-sticky-top", `${pinned ? Math.round(previewHeader.offsetHeight + (parseFloat(style.top) || 0)) : 0}px`);
}
if (previewHeader && typeof ResizeObserver === "function") new ResizeObserver(syncStickyTop).observe(previewHeader);
window.addEventListener("resize", syncStickyTop);

// "Start review" (no pending comments, from the Pull request pane): open the
// pull request's Files changed with focus on the first file's line numbers,
// where a review comment starts. Nothing is written.
export function startPullRequestReview(target: { repositoryId: string; number: number }): void {
  startReviewFor = target.number;
  activatePullRequestPreview({ repositoryId: target.repositoryId, number: target.number, tab: "files" }, { pushHistory: true });
  if (mounted?.number === target.number) startPendingReview(mounted);
}

function startPendingReview(view: Mounted): void {
  if (startReviewFor !== view.number || view.tab !== "files" || !view.files) return;
  startReviewFor = null;
  view.files.focusFirstLine();
}

tabControl?.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-pr-tab]");
  if (!button || !mounted) return;
  showTab(button.dataset.prTab as PullRequestTab);
});

// Tabs pattern: Left / Right (wrapping), Home and End move to a tab and
// show it.
tabControl?.addEventListener("keydown", event => {
  const tabs = [...(tabControl.querySelectorAll<HTMLButtonElement>("[data-pr-tab]"))];
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
  showTab("files");
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
    showToast(`Your review of #${number} is still pending: ${count} ${count === 1 ? "comment" : "comments"}, visible only to you until you finish it. The Pull request pane and Browse pull requests mark it.`);
  }
}

pullRequestStore.subscribe(() => {
  syncShown();
  if (!mounted) return;
  if (!mounted.root.isConnected || appState.previewMode.kind !== "pull-request") {
    pullRequestStore.watch("view", null);
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

export function renderPullRequestPreview(mode: Mode, options: { tab?: PullRequestTab; file?: string } = {}): void {
  if (deferHiddenPreview(() => {
    if (appState.previewMode.kind === "pull-request") renderPullRequestPreview(appState.previewMode, options);
  })) return;
  if (mounted && mounted.root.isConnected && mounted.repositoryId === mode.repositoryId && mounted.number === mode.number) {
    if (options.tab && options.tab !== mounted.tab) showTab(options.tab, { fromUrl: true });
    revealFile(mounted, options.file);
    return;
  }
  releaseMediaPreview();
  closeMermaidViewer();
  clearPreviewType();
  hideViewToggle();
  previewBaseElement.href = new URL(appUrl("/"), window.location.origin).toString();
  previewElement.classList.remove("empty");
  previewTitleElement.textContent = `Pull request #${mode.number}`;
  previewPathElement.textContent = "Reading GitHub…";
  previewElement.innerHTML = `<section class="pr-view">
      <div class="pr-view-banner" data-pr-banner hidden></div>
      <div class="pr-view-meta" data-pr-meta></div>
      <div id="pr-panel-conversation" role="tabpanel" aria-labelledby="pr-tab-conversation" data-pr-panel="conversation"><p class="pr-muted">Reading the pull request…</p></div>
      <div id="pr-panel-files" role="tabpanel" aria-labelledby="pr-tab-files" data-pr-panel="files" hidden></div>
    </section>`;
  const root = previewElement.querySelector<HTMLElement>(".pr-view")!;
  // Another pull request starts at its top, not at the last one's offset.
  previewScrollRoot().scrollTop = 0;
  mounted = { repositoryId: mode.repositoryId, number: mode.number, tab: options.tab ?? "conversation", root, detail: null, files: null, composer: null, loading: false, pendingFile: null, revealedFile: null };
  syncStickyTop();
  // On screen now: focus and Retry re-read it, and dialogs for another
  // pull request close.
  pullRequestStore.watch("view", mode.number);
  syncShown();
  // Nothing about this pull request is known yet: no counts from the last
  // one, and no GitHub link until its URL is.
  setHeaderDetail(null);
  syncTabs(mounted);
  const cached = pullRequestStore.detail(mode.number);
  if (cached) present(mounted, cached);
  revealFile(mounted, options.file);
  void load(mounted);
  // Opening a pull request view is a refresh trigger (design D6).
  if (pullRequestStore.state.enabled !== false) void pullRequestStore.refresh(false);
}

// Scrolls Files changed to `file` once it is mounted (present() retries
// after the detail arrives).
function revealFile(view: Mounted, file: string | undefined): void {
  if (file && file !== view.revealedFile) view.pendingFile = file;
  if (!view.pendingFile || !view.files || view.tab !== "files") return;
  view.files.reveal({ path: view.pendingFile });
  view.revealedFile = view.pendingFile;
  view.pendingFile = null;
}

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

// A tab switch is a history entry; a navigation (`fromUrl`) already wrote
// it, including any `file=`.
function showTab(tab: PullRequestTab, options: { fromUrl?: boolean } = {}): void {
  if (!mounted) return;
  if (mounted.tab !== tab && !options.fromUrl) pushPullRequestPreview(mounted.repositoryId, mounted.number, tab);
  mounted.tab = tab;
  syncTabs(mounted);
  if (tab === "files" && mounted.detail && !mounted.files) mountFiles(mounted, mounted.detail);
  startPendingReview(mounted);
}

function syncTabs(view: Mounted): void {
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

function mountFiles(view: Mounted, detail: PullRequestDetail): void {
  const panel = view.root.querySelector<HTMLElement>('[data-pr-panel="files"]')!;
  view.files = mountFilesChanged(panel, detail, view.repositoryId);
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
  previewTitleElement.textContent = pr.title;
  previewPathElement.textContent = `#${pr.number} · ${detail.repository.owner}/${detail.repository.name}`;
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
  syncAvailability(view);
  revealFile(view, undefined);
  startPendingReview(view);
}

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
  renderConversationBar(view);
  view.files?.syncAvailability();
}

// Conversation shows the pending review too (count, Discard, Finish), so
// finishing it never needs a detour through Files changed.
function renderConversationBar(view: Mounted): void {
  const bar = view.root.querySelector<HTMLElement>("[data-pr-conversation-bar]");
  if (bar && view.detail) renderReviewBar(bar, view.detail, view.repositoryId, { surface: "conversation" });
}

// Stale data (rate-limited or unreachable) stays visible under a banner that
// says how old it is, with Retry (mockup 6): for the branch's pull request
// and a picked one alike.
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
      <div class="pr-event pr-merge-box" data-pr-merge-box></div>
      <div class="pr-event pr-event-composer">
        ${avatar(detail.viewer)}
        <div class="pr-event-main" data-pr-composer></div>
      </div>
    </div>`;
  const composer = createComposer({
    tabs: true,
    rows: 4,
    placeholder: `Leave a comment on #${detail.summary.number} as ${detail.viewer}…`,
    submitLabel: "Comment",
    draftName: `your comment on #${detail.summary.number}`,
    note: "Comments post immediately; line comments go into your pending review.",
    draft: { target: { repositoryId: view.repositoryId, number: view.number }, location: { kind: "conversation" } },
    alreadySent: text => draftAlreadySent({ kind: "conversation" }, text, detail),
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
  renderMergeBox(view, detail);
  for (const button of timeline.querySelectorAll<HTMLButtonElement>("[data-view-in-diff]")) {
    button.addEventListener("click", () => {
      showTab("files");
      view.files?.reveal({ threadId: button.dataset.viewInDiff });
    });
  }
}

// Read-only merge readiness, where GitHub has its merge box; merging itself
// is a link to GitHub (design D11).
function renderMergeBox(view: Mounted, detail: PullRequestDetail): void {
  const box = view.root.querySelector<HTMLElement>("[data-pr-merge-box]");
  if (!box) return;
  const pr = detail.summary;
  const readiness = mergeReadinessView(pr, detail.mergeReadiness);
  box.className = `pr-event pr-merge-box is-${readiness.tone}`;
  box.innerHTML = `<span class="pr-merge-box-icon" aria-hidden="true">${readiness.tone === "ready" ? "✓" : readiness.tone === "blocked" ? "!" : "●"}</span>
    <div class="pr-event-main pr-card">
      <div class="pr-card-body">
        <h3 class="pr-merge-box-title">${escapeHtml(readiness.tone === "blocked" ? "Merging is blocked" : readiness.headline)}</h3>
        ${pr.state === "OPEN" ? `<p class="pr-merge-box-facts">${reviewDecisionBadge(pr.reviewDecision)} <span>${checksSummaryHtml(pr.checks)}</span></p>` : ""}
        ${readiness.reasons.length ? `<ul class="pr-merge-box-reasons">${readiness.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}
        ${readiness.pendingNote && pr.state === "OPEN" ? `<p class="pr-merge-box-pending">${escapeHtml(readiness.pendingNote)}</p>` : ""}
        ${readiness.notes.length ? `<p class="pr-muted">${readiness.notes.map(escapeHtml).join(" ")}</p>` : ""}
        ${pr.state === "OPEN" ? `<p>${externalLink(pr.url, "Merge on GitHub", `gh-button${readiness.tone === "ready" ? " gh-button-merge" : ""}`)}</p><p class="pr-muted pr-merge-box-note">uatu doesn't merge: GitHub handles merge queues, rulesets and stacked pull requests.</p>` : ""}
      </div>
    </div>`;
}

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
      <span><strong>${escapeHtml(item.actor)}</strong> merged this pull request (${escapeHtml(item.method.toLowerCase())}) · ${escapeHtml(age(item.at))}${item.deletedBranch ? ` · <code>${escapeHtml(detail.summary.headRefName)}</code> deleted on GitHub` : ""}</span></div>`;
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
        <span class="pr-muted">${placed ? `line ${thread.line}` : "outdated"}</span>
        <span class="pr-thread-summary-aside">
          ${thread.isResolved ? `<span class="gh-pill">Resolved</span>` : `<span class="gh-pill gh-pill-attention">Unresolved</span>`}
          <span class="pr-muted">${replies} ${replies === 1 ? "reply" : "replies"}</span>
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
  previewTitleElement.textContent = "Pull request unavailable";
  const summary = pullRequestStore.state.summary;
  const repository = summary?.repository ? `${summary.repository.owner}/${summary.repository.name}` : "";
  const branch = pullRequestStore.state.branch;
  const noCredential = error instanceof GithubRequestError && error.status === 401;
  previewPathElement.textContent = [branch, repository].filter(Boolean).join(" · ") || `#${view.number}`;
  view.root.querySelector<HTMLElement>("[data-pr-meta]")!.innerHTML = noCredential ? `<span>GitHub not connected</span>${mockNotice(Boolean(summary?.mock))}` : "";
  // What was shown (and its composers) goes: it can't be refreshed or sent.
  view.detail = null;
  view.files = null;
  view.composer = null;
  setHeaderDetail(null, { tabs: false });
  renderBanner(view);
  for (const tab of ["conversation", "files"] as const) {
    const panel = view.root.querySelector<HTMLElement>(`[data-pr-panel="${tab}"]`)!;
    panel.innerHTML = noCredential ? connectGithubHtml("card") : `<div class="gh-state-card gh-state-card-danger">
      <p class="gh-state-card-eyebrow">Pull request #${view.number}</p>
      <h3>Couldn't load this pull request</h3>
      <p>${escapeHtml(errorMessage(error))}</p>
      <p><button type="button" class="gh-button" data-pr-retry>Retry</button></p>
    </div>`;
    panel.querySelector("[data-pr-retry]")?.addEventListener("click", () => void load(view));
  }
  syncTabs(view);
}

// The "connect GitHub" guidance, shared with the Pull request pane.
export function connectGithubHtml(variant: "card" | "compact"): string {
  const workspace = appState.repositories.find(repository => repository.metadata.status === "git")?.label ?? "this workspace";
  const settings = isHubPage()
    ? externalLink(hubUrl("/settings#credentials-pane"), "Open Hub Settings → Credentials", "gh-button gh-button-primary")
    : `<p class="pr-muted">Outside a Hub, sign in with <code>gh auth login</code> and restart this session.</p>`;
  if (variant === "compact") {
    return `<div class="gh-connect gh-connect-compact">
        <h3>GitHub isn't connected for this workspace</h3>
        <p>uatu reads and reviews pull requests through the GitHub CLI credential assigned to <strong>${escapeHtml(workspace)}</strong>. None is assigned yet.</p>
        ${settings}
      </div>`;
  }
  return `<div class="gh-connect">
      <h3>Connect GitHub to review pull requests here</h3>
      <p>Assign a credential with GitHub CLI access to this workspace. uatu runs <code>gh</code> with it to read the pull request and post comments and reviews. Nothing is stored in the worktree.</p>
      <div class="gh-breadcrumb" aria-label="Where to assign it">${["Hub", "Settings", "Credentials", "Add HTTPS or provider token", `Workspace assignments: ${workspace}`]
        .map(step => `<span class="gh-breadcrumb-step">${escapeHtml(step)}</span>`).join(`<span class="gh-breadcrumb-separator" aria-hidden="true">›</span>`)}</div>
      <div class="gh-connect-actions">${settings}<span class="pr-muted">Child worktrees inherit the assignment from <strong>${escapeHtml(workspace)}</strong>.</span></div>
    </div>`;
}
