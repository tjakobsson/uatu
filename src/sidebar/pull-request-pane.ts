// The Pull request pane: the workspace's current pull request at a glance.
// A pinned top row (state, review decision, and the Details toggle; the
// number is in the pane header), then a compact summary a short pane always
// shows (title, checks count and the first merge blocker, any pending
// comments), then the actions (the one review button, Review or Finish
// review (n), which opens the review dialog; Merge on GitHub ↗ while the PR
// is ready, else View on GitHub ↗), then the details behind the toggle (head
// → base, stats, author, merge readiness with every reason, the per-check
// list, reviewers; open by default on touch, where the expanded pane takes
// the Files tab, up to its content's height). On desktop, where the pane
// shares the sidebar with others and can't always grow enough, the open
// details float beside the toggle as one panel (Escape or a click outside
// closes it) instead of opening into a short scroll region. The title's
// clamp is on its text. The pane is sized
// to whole rows, so no row is cut at its bottom. A manual ↻ says "Updated
// just now" in the header once GitHub has answered. uatu never merges: readiness is read-only and merging links to
// GitHub (design D11). The title and number open the PR preview. Each GitHub
// status has its own empty or error state (mockup 6), and stale data stays
// visible with its age and a Retry that says what it is doing; while
// GitHub can't take writes, Finish review waits with the reason. The pane
// scrolls back to its top whenever what it shows changes (another PR,
// another status), never mid-way into old content.
//
// The current pull request is the checked-out branch's own, unless another
// is viewed (View here, in the workspace switcher): then the pane shows the
// viewed one, and the Files pane lists its files
// (sidebar/pull-request-scope.ts). The pane carries no note about it: the
// switcher's chip, button and Viewing strip say it, with the way back.
//
// When the session does not serve GitHub data (/api/github/* answers 404)
// the pane marks itself unavailable and leaves the pane stack and the panels
// menu, so a production session without the integration shows nothing.

import { githubWritesPausedReason, retryNoticeText, staleNotice } from "../github/availability";
import { githubApi } from "../github/client";
import { errorMessage, pullRequestStore } from "../github/pull-request-store";
import {
  avatar,
  branchesHtml,
  checkGlyph,
  checksSummaryHtml,
  clockTime,
  clockTimeWithSeconds,
  externalLink,
  mergeLinkHtml,
  mockNotice,
  repositoryName,
  reviewDecisionBadge,
  reviewerBadge,
  stateBadge,
} from "../github/present";
import { mergeReadinessView } from "../github/readiness";
import { GITHUB_FAKE_SCENARIOS, type GithubStatus, type PullRequestSummary } from "../shared/github-contract";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { appState } from "../shell/state";
import { buildPullRequestPreviewPath } from "../shell/history";
import { revealPreviewSurface } from "../shell/tab-bar";
import { activatePullRequestPreview } from "../shell/url";
import { connectGithubHtml } from "../github/connect";
import { githubWorkspaceName, revealPullRequestHeading } from "../preview/pull-request-view";
import { confirmResetMockData, openSubmitReviewDialog, reviewActionLabel } from "../preview/review-dialogs";
import { reviewMarksByPath } from "../preview/diff-review";
import { OPEN_PULL_REQUEST_EVENT, openSwitcher, SHOW_BRANCH_EVENT, type OpenPullRequestDetail, type ShowBranchDetail } from "../shell/switcher";
import { paneRows, schedulePaneHeightNormalization, setPaneAvailable } from "./panes";
import { wholeRowTrim } from "./pane-stack";
import { ensureTreeView } from "./tree-mount";
import { onSidebarRepositories } from "./shell";
import { focusWorkspaceTree, initPullRequestScope, showBranchPullRequest } from "./pull-request-scope";

const paneBody = document.querySelector<HTMLElement>("#pull-request-pane")!;
const paneMeta = document.querySelector<HTMLElement>("#pull-request-pane-meta")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#pull-request-refresh")!;
const browseButton = document.querySelector<HTMLButtonElement>("#pull-request-browse")!;
const liveRegion = document.querySelector<HTMLElement>("#pull-request-live");
const updatedNote = document.querySelector<HTMLElement>("#pull-request-updated");
// The body's children are rows the pane stack sizes the pane to (panes.ts).
paneBody.toggleAttribute("data-pane-rows", true);

// The details (branches, stats, readiness reasons, checks, reviewers) start
// folded on desktop: the pane is short, and the summary above the actions
// carries what matters at a glance. The toggle's choice holds for the page.
// On touch the expanded pane fills the Files tab's stack (the accordion
// folds the others), so the details start open there instead of leaving the
// space empty; a choice made with the toggle holds either way.
let detailsChoice: boolean | null = null;
const detailsOpen = () => detailsChoice ?? document.documentElement.dataset.uiMode === "touch";
// Desktop: the open details are a floating panel (positionDetails).
const detailsFloat = () => document.documentElement.dataset.uiMode !== "touch";
let scenarioBusy = false;
// Bumped by Reset data: the pane starts again at its top.
let resetGeneration = 0;
// What the pane showed last: a change scrolls it back to its top.
let shownKey = "";
let retryWas: string | null = null;
// The summary PR's detail is read once per summary change, for the review
// counters, the Files pane badges and the dialogs.
let detailKey = "";
// The viewed pull request whose detail was last requested, and why it failed.
let scopedRequested: number | null = null;
let scopedError: string | null = null;

export function initPullRequestPane(): void {
  pullRequestStore.subscribe(renderPullRequestPane);
  initPullRequestScope();
  onSidebarRepositories(syncPullRequestPane);
  // View here (the switcher): the PR becomes the viewed one and its
  // conversation comes forward (the Preview tab on touch); its files are in
  // the Files tab, one tap away.
  document.addEventListener(OPEN_PULL_REQUEST_EVENT, event => {
    const { repositoryId, number } = (event as CustomEvent<OpenPullRequestDetail>).detail;
    activatePullRequestPreview({ repositoryId, number }, { pushHistory: true });
    revealPreviewSurface();
    revealPullRequestHeading({ always: true });
  });
  // ← Back (the switcher's status card, chip or Viewing strip): Files and
  // Preview show the checkout again; focus lands where the control was.
  document.addEventListener(SHOW_BRANCH_EVENT, event => {
    const { focus } = (event as CustomEvent<ShowBranchDetail>).detail;
    showBranchPullRequest();
    requestAnimationFrame(() => {
      if (focus === "tree") focusWorkspaceTree();
      else if (focus === "heading") {
        const title = document.querySelector<HTMLElement>("#preview-title");
        if (!title) return;
        title.tabIndex = -1;
        title.focus({ preventScroll: true });
      }
    });
  });
  // In the header, so it is there whatever the pane shows: the switcher,
  // at its Pull requests.
  browseButton.addEventListener("click", () => openSwitcher({ opener: browseButton, section: "pull-requests" }));
  refreshButton.addEventListener("click", () => {
    // Busy, it says so (aria-disabled) but stays focusable: a keyboard
    // Refresh keeps focus on the button through the re-render.
    if (refreshButton.getAttribute("aria-disabled") === "true") return;
    const scoped = pullRequestStore.scopedNumber();
    if (scoped !== null) {
      scopedRequested = null;
      scopedError = null;
    }
    // Acknowledged once GitHub has answered: "Updated just now" in the
    // header for a few seconds (and said to screen readers).
    void pullRequestStore.refresh(true).then(() => acknowledgeRefresh());
  });
  // The pane header's #number and pending-review pill act like the body's.
  const onClick = (event: MouseEvent) => {
    const element = event.target as HTMLElement;
    const open = element.closest<HTMLAnchorElement>("[data-pr-open]");
    if (open) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      const repositoryId = pullRequestStore.state.repositoryId;
      if (!repositoryId) return;
      revealPreviewSurface();
      activatePullRequestPreview({ repositoryId, number: Number(open.dataset.prOpen), tab: open.dataset.prTab === "files" ? "files" : "conversation" }, { pushHistory: true });
      revealPullRequestHeading();
      return;
    }
    if (element.closest("[data-pr-details-toggle]")) {
      detailsChoice = !detailsOpen();
      renderPullRequestPane();
      // After the pane stack refits the taller content (a frame later).
      if (detailsChoice && !detailsFloat()) requestAnimationFrame(revealDetails);
      return;
    }
    const pendingOpen = element.closest<HTMLElement>("[data-pr-pending-open]");
    if (pendingOpen) {
      const repositoryId = pullRequestStore.state.repositoryId;
      if (!repositoryId) return;
      activatePullRequestPreview({ repositoryId, number: Number(pendingOpen.dataset.prPendingOpen), tab: "files" }, { pushHistory: true });
      revealPreviewSurface();
      revealPullRequestHeading();
      return;
    }
    const action = element.closest<HTMLButtonElement>("[data-pr-action]")?.dataset.prAction;
    const repositoryId = pullRequestStore.state.repositoryId;
    const number = pullRequestStore.currentNumber();
    if (action === "retry") {
      scopedRequested = null;
      scopedError = null;
      void pullRequestStore.retry();
    }
    if (action === "open-any") openSwitcher({ opener: element.closest("button") ?? browseButton, section: "pull-requests" });
    if (!repositoryId || !number) return;
    // Focus comes back to the same action, in the same place (the header's
    // pending count or the body's button), after the pane re-renders, or to
    // the title when that action is gone or disabled.
    // A published review turns Finish review into Review: the pane's
    // review button, either way, is where focus lands.
    const container = paneMeta.contains(element) ? paneMeta : paneBody;
    const fallbackFocus = () => container.querySelector<HTMLElement>(`[data-pr-action="${action}"]:not(:disabled)`)
      ?? paneBody.querySelector<HTMLElement>(`[data-pr-action="review"]:not(:disabled)`)
      ?? paneBody.querySelector<HTMLElement>(".pr-pane-title");
    // Review / Finish review (n) opens the review dialog (whose Add line
    // comments opens Files changed).
    if (action === "review") openSubmitReviewDialog({ repositoryId, number }, { fallbackFocus });
  };
  paneBody.addEventListener("click", onClick);
  // The floating details close on Escape (focus back on the toggle) and on
  // a click anywhere outside them and the toggle.
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !floatingDetailsShown()) return;
    const inside = paneBody.contains(document.activeElement);
    if (!inside && document.activeElement !== document.body) return;
    event.preventDefault();
    closeFloatingDetails(true);
  });
  document.addEventListener("pointerdown", event => {
    if (!floatingDetailsShown()) return;
    const target = event.target as HTMLElement;
    if (target.closest("#pr-pane-details, [data-pr-details-toggle], dialog")) return;
    closeFloatingDetails(false);
  });
  window.addEventListener("resize", positionDetails);
  paneMeta.addEventListener("click", onClick);
  paneBody.addEventListener("change", event => {
    const select = (event.target as HTMLElement).closest<HTMLSelectElement>("[data-pr-scenario]");
    if (select) void runScenario({ scenario: select.value as (typeof GITHUB_FAKE_SCENARIOS)[number] });
  });
  paneBody.addEventListener("click", async event => {
    if (!(event.target as HTMLElement).closest("[data-pr-reset]")) return;
    if (await confirmResetMockData()) void runScenario({ reset: true });
  });
}

// A manual refresh that GitHub answered says so briefly beside the number
// (and to screen readers); a refusal says itself (the stale line, the error
// card), so it gets no "updated".
let updatedTimer: ReturnType<typeof setTimeout> | null = null;
function acknowledgeRefresh(): void {
  const state = pullRequestStore.state;
  if (!updatedNote || state.error || !state.summary || staleNotice(state.summary)) return;
  updatedNote.hidden = false;
  if (liveRegion) liveRegion.textContent = `Pull request updated from GitHub at ${clockTime(state.summary.checkedAt)}.`;
  if (updatedTimer) clearTimeout(updatedTimer);
  updatedTimer = setTimeout(() => { updatedNote.hidden = true; }, 4000);
}

// Runs on every sidebar render: picks up branch/HEAD changes.
function syncPullRequestPane(): void {
  pullRequestStore.syncRepositories(appState.repositories);
}

async function runScenario(input: Parameters<typeof githubApi.setScenario>[0]): Promise<void> {
  if (scenarioBusy) return;
  scenarioBusy = true;
  try {
    await githubApi.setScenario(input);
    detailKey = "";
    if (input.reset) resetGeneration += 1;
    await pullRequestStore.refresh(true);
    const mode = appState.previewMode;
    // Reload an open PR preview against the new scenario (the view follows
    // the store). Not a navigation: that would count the shown pull request
    // as viewed once the branch has none.
    if (mode.kind === "pull-request") await pullRequestStore.loadDetail(mode.number, mode.repositoryId).catch(() => undefined);
  } finally {
    scenarioBusy = false;
  }
}

// What the folded pane's header says beside the number (touch mode's
// accordion; styles.css shows it only while the pane is folded).
function collapsedSummary(pr: PullRequestSummary): string {
  if (pr.state === "MERGED") return "Merged";
  if (pr.state === "CLOSED") return "Closed";
  if (pr.isDraft) return "Draft";
  if (pr.reviewDecision === "APPROVED") return "Approved";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "Review required";
  return "Open";
}

function setMeta(html: string): void {
  paneMeta.innerHTML = html;
}

// Why the pull request's detail couldn't be read, in the header's tooltip;
// it goes as soon as fresh data arrives (or GitHub's status changes).
let metaError: { message: string; status: string } | null = null;
function setMetaError(message: string | null): void {
  metaError = message === null ? null : { message, status: pullRequestStore.state.summary?.status ?? "" };
  if (message === null) paneMeta.removeAttribute("title");
  else paneMeta.title = message;
}

// A control inside the pane, described well enough to find its successor
// after a re-render (every store change re-renders the pane).
function focusKey(element: Element | null): string | null {
  if (!(element instanceof HTMLElement) || !(paneBody.contains(element) || paneMeta.contains(element))) return null;
  for (const name of ["data-pr-action", "data-pr-details-toggle", "data-pr-back-to-branch", "data-pr-pending-open", "data-pr-scenario", "data-pr-reset"]) {
    if (element.hasAttribute(name)) return `[${name}${element.getAttribute(name) ? `="${CSS.escape(element.getAttribute(name)!)}"` : ""}]`;
  }
  if (element.hasAttribute("data-pr-open")) return `.${CSS.escape(element.classList[0] ?? "pr-pane-title")}[data-pr-open]`;
  return null;
}

export function renderPullRequestPane(): void {
  const key = focusKey(document.activeElement);
  renderPane();
  if (!key || paneBody.contains(document.activeElement) || paneMeta.contains(document.activeElement)) return;
  const next = paneMeta.querySelector<HTMLElement>(key) ?? paneBody.querySelector<HTMLElement>(key);
  if (next && !(next as HTMLButtonElement).disabled) next.focus({ preventScroll: true });
}

// What the pane must always show, measured after every render and whenever
// its width changes (the title wraps): the pane allocator keeps the pane at
// least that tall (sidebar/panes.ts reads `[data-pane-essential-end]`).
// The content's height counts too: the stack sizes the pane to whole rows,
// so new rows (Details, a notice) refit it.
let essentialBottom = "";
function syncEssentialHeight(): void {
  const end = paneBody.querySelector<HTMLElement>("[data-pane-essential-end]");
  const bottom = end && paneBody.clientWidth > 0 ? `${Math.round(end.offsetTop + end.offsetHeight)}:${paneBody.scrollHeight}` : "";
  if (bottom === essentialBottom) return;
  essentialBottom = bottom;
  schedulePaneHeightNormalization();
}
if (typeof ResizeObserver === "function") {
  let width = -1;
  new ResizeObserver(() => {
    if (paneBody.clientWidth === width) return;
    width = paneBody.clientWidth;
    syncEssentialHeight();
  }).observe(paneBody);
}

// Details open below the actions. When their first rows are out of sight the
// pane scrolls just enough to show them, but never so far that the title
// goes under the pinned top row.
function revealDetails(): void {
  const details = paneBody.querySelector<HTMLElement>(".pr-pane-details");
  const title = paneBody.querySelector<HTMLElement>(".pr-pane-title");
  const top = paneBody.querySelector<HTMLElement>(".pr-pane-pin");
  if (!details || !title) return;
  const box = paneBody.getBoundingClientRect();
  const wanted = details.getBoundingClientRect().top + 48 - box.bottom;
  const room = title.getBoundingClientRect().top - (top ? top.getBoundingClientRect().bottom : box.top);
  let delta = Math.min(wanted, room);
  if (delta <= 0) return;
  // Stop where the pane's bottom edge falls between rows, not through one.
  const { rows } = paneRows(paneBody);
  delta -= wholeRowTrim(rows, paneBody.scrollTop + delta + paneBody.clientHeight);
  if (delta > 0) paneBody.scrollTop += delta;
}

function renderPane(): void {
  renderPaneContent();
  positionDetails();
  syncEssentialHeight();
}

const floatingDetailsShown = () => Boolean(paneBody.querySelector("#pr-pane-details.is-floating:not([hidden])"));
// Closed in place, not re-rendered: the pointerdown that closes them may be
// the start of a click on one of the pane's controls (Review), which must
// still be there to take it.
function closeFloatingDetails(focusToggle: boolean): void {
  detailsChoice = false;
  const details = paneBody.querySelector<HTMLElement>("#pr-pane-details.is-floating");
  const toggle = paneBody.querySelector<HTMLElement>("[data-pr-details-toggle]");
  if (details) details.hidden = true;
  if (toggle) {
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "▸ Details";
  }
  if (focusToggle) toggle?.focus();
}

// The floating details sit beside the pane, level with the Details toggle,
// so the summary and the actions stay in view (under the toggle when the
// window has no room beside it), as tall as the window allows (then they
// scroll on their own).
function positionDetails(): void {
  const details = paneBody.querySelector<HTMLElement>("#pr-pane-details.is-floating:not([hidden])");
  const toggle = paneBody.querySelector<HTMLElement>("[data-pr-details-toggle]");
  if (!details || !toggle) return;
  const box = paneBody.getBoundingClientRect();
  const toggleBox = toggle.getBoundingClientRect();
  const beside = window.innerWidth - box.right >= 380;
  const top = Math.max(8, beside ? toggleBox.top - 8 : toggleBox.bottom + 6);
  const left = Math.max(8, beside ? box.right + 6 : box.left + 8);
  details.style.setProperty("--pr-details-top", `${Math.round(top)}px`);
  details.style.setProperty("--pr-details-left", `${Math.round(left)}px`);
  details.style.setProperty("--pr-details-width", `${Math.round(Math.min(380, window.innerWidth - left - 12))}px`);
  details.style.setProperty("--pr-details-max-height", `${Math.round(window.innerHeight - top - 12)}px`);
}

function renderPaneContent(): void {
  const state = pullRequestStore.state;
  setPaneAvailable("pull-request", state.enabled === true && state.repositoryId !== null);
  refreshButton.setAttribute("aria-disabled", String(state.loading));
  refreshButton.classList.toggle("is-spinning", state.loading);
  if (state.enabled === false || !state.repositoryId) return;
  announceRetry();
  const summary = state.summary;
  if (metaError && metaError.status !== (summary?.status ?? "")) setMetaError(null);
  if (!summary) {
    setMeta("");
    paneBody.innerHTML = state.error
      ? stateCard("danger", "Couldn't read pull request data", escapeHtml(state.error), retryActionsHtml())
      : `<p class="pane-empty">Reading GitHub…</p>`;
    resetScrollOnChange(`error\n${Boolean(state.error)}`);
    return;
  }
  syncDetail();
  const scoped = pullRequestStore.scopedNumber();
  const pr = currentPullRequest();
  const pending = pr?.viewerPendingComments ?? 0;
  const pendingLabel = `Finish review (${pending} pending ${pending === 1 ? "comment" : "comments"})`;
  const paused = githubWritesPausedReason(summary);
  setMeta(pr ? `<a href="${escapeHtmlAttribute(previewHref(pr.number))}" data-pr-open="${pr.number}" class="pr-pane-number">#${pr.number}</a><span class="pane-collapsed-summary">· ${escapeHtml(collapsedSummary(pr))}</span>${pending && pr.state === "OPEN" ? `<button type="button" class="gh-pill gh-pill-attention gh-pill-xs gh-pill-button" data-pr-action="review" title="${escapeHtmlAttribute(paused ? `${pendingLabel}: ${paused}` : pendingLabel)}" aria-label="${escapeHtmlAttribute(pendingLabel)}"${paused ? ` disabled aria-describedby="pr-pane-paused"` : ""}><span aria-hidden="true">✎ ${pending}</span></button>` : ""}` : "");
  const stale = summary.status === "rate-limited" || summary.status === "unavailable";
  // No credential: nothing can be read. The preview, when it shows a pull
  // request, holds the full guidance; the pane says it in one line then.
  if (summary.status === "no-credential") {
    const variant = appState.previewMode.kind === "pull-request" ? "line" : "compact";
    paneBody.innerHTML = `${connectGithubHtml(variant, githubWorkspaceName())}${pendingElsewhereHtml([])}${scenarioControl()}`;
    resetScrollOnChange(`no-credential\n${scoped}\n${variant}`);
    return;
  }
  if (scoped !== null) {
    const body = pr ? summaryHtml(pr) : (scopedError ? stateCard("danger", `Couldn't read pull request #${scoped}`, escapeHtml(scopedError), retryActionsHtml())
      : `<p class="pane-empty">Reading pull request #${scoped}…</p>`);
    paneBody.innerHTML = `${stale ? staleLine(scoped) : ""}${body}${scenarioControl()}`;
  } else {
    // With a pull request to show, stale data gets one compact line above
    // it; without one, the status card explains.
    const status = stale && pr ? staleLine(pr.number) : statusSection(summary.status);
    paneBody.innerHTML = `${status}${pr ? summaryHtml(pr) : ""}${scenarioControl()}`;
  }
  // What the pane says changed (another PR or status, a review decision, the
  // pending count, a new update on GitHub, Reset data): back to its top, so
  // the title row is in view.
  resetScrollOnChange([summary.status, scoped, pr?.number, pr?.state, pr?.reviewDecision, pr?.viewerPendingComments, pr?.updatedAt, resetGeneration].join("\n"));
}

// A new thing to show starts at the pane's top: a stale position from the
// last pull request or status would hide the summary.
function resetScrollOnChange(key: string): void {
  if (key === shownKey) return;
  shownKey = key;
  paneBody.scrollTop = 0;
}

// Retry's outcome, for screen readers too: "Retrying…", then a new answer
// (GitHub answered, or the same refusal again at a new time).
function announceRetry(): void {
  const retry = pullRequestStore.state.retry;
  const key = retry ? (retry.status === "running" ? "running" : `${retry.at}`) : null;
  if (key === retryWas) return;
  retryWas = key;
  if (!retry || !liveRegion) return;
  const summary = pullRequestStore.state.summary;
  liveRegion.textContent = retry.status === "done" && retry.recovered
    ? `GitHub answered. Showing data as of ${summary ? clockTime(summary.checkedAt) : "now"}.`
    : retryNoticeText(retry, summary?.status, clockTimeWithSeconds) ?? "";
}

function retryActionsHtml(): string {
  const retry = pullRequestStore.state.retry;
  const running = retry?.status === "running";
  const note = retryNoticeText(retry, pullRequestStore.state.summary?.status, clockTimeWithSeconds);
  return `<button type="button" class="gh-button" data-pr-action="retry"${running ? " disabled" : ""}>${running ? "Retrying…" : "Retry"}</button>${note && !running ? `<span class="pr-muted pr-retry-note">${escapeHtml(note)}</span>` : ""}`;
}

// The pull request the pane shows: a viewed one, else the branch's own.
function currentPullRequest(): PullRequestSummary | null {
  const scoped = pullRequestStore.scopedNumber();
  if (scoped !== null) return pullRequestStore.detail(scoped)?.summary ?? null;
  return pullRequestStore.state.summary?.pullRequest ?? null;
}

function previewHref(number: number, tab: "conversation" | "files" = "conversation"): string {
  return buildPullRequestPreviewPath(pullRequestStore.state.repositoryId ?? "", number, tab);
}

function stateCard(tone: "danger" | "attention" | "neutral", title: string, bodyHtml: string, actionsHtml = ""): string {
  return `<div class="gh-state-card gh-state-card-${tone}" data-pane-essential-end>
      <h3>${escapeHtml(title)}</h3>
      <p>${bodyHtml}</p>
      ${actionsHtml ? `<div class="gh-state-card-actions">${actionsHtml}</div>` : ""}
    </div>`;
}

// Stale data over a pull request: one line, so the summary and the actions
// stay in view; the explanation is in its tooltip and in the preview banner.
function staleLine(shownNumber: number): string {
  const summary = pullRequestStore.state.summary!;
  const notice = staleNotice(summary)!;
  const retry = pullRequestStore.state.retry;
  const running = retry?.status === "running";
  const note = retryNoticeText(retry, summary.status, clockTimeWithSeconds);
  return `<div class="pr-pane-stale" role="status" title="${escapeHtmlAttribute(`${notice.title}. ${notice.why} Showing #${shownNumber} as it was then; sending is paused.`)}">
      <span id="pr-pane-paused"><strong>${summary.status === "rate-limited" ? "Rate-limited" : "GitHub unreachable"}</strong> · sending paused · as of ${escapeHtml(clockTime(summary.checkedAt))}</span>
      <button type="button" class="gh-link-button" data-pr-action="retry"${running ? " disabled" : ""}>${running ? "Retrying…" : "Retry"}</button>
      ${note && !running ? `<span class="pr-retry-note">${escapeHtml(note)}</span>` : ""}
    </div>`;
}

function statusSection(status: GithubStatus): string {
  const state = pullRequestStore.state;
  const summary = state.summary!;
  const repo = escapeHtml(repositoryName(summary));
  switch (status) {
    case "ready":
      return "";
    case "no-pull-request": {
      const branch = state.branch ?? "this branch";
      const create = summary.repository && state.branch
        ? externalLink(`https://${summary.repository.host}/${summary.repository.owner}/${summary.repository.name}/compare/${encodeURIComponent(state.branch)}?expand=1`, "Create on GitHub")
        : "";
      return stateCard("neutral", `No pull request for ${branch}`, `Nothing on ${repo} has this branch as its head.`,
        `<button type="button" class="gh-button" data-pr-action="open-any">Browse pull requests…</button>${create}`) + pendingElsewhereHtml([]);
    }
    case "rate-limited":
    case "unavailable": {
      const notice = staleNotice(summary)!;
      return stateCard("danger", notice.title, escapeHtml(notice.why), retryActionsHtml()) + pendingElsewhereHtml([]);
    }
    default:
      return stateCard("attention", "GitHub is unavailable", escapeHtml(summary.message ?? status)) + pendingElsewhereHtml([]);
  }
}

// The viewer's pending reviews on pull requests other than the ones shown:
// leaving a pull request with a pending review never hides it, and neither
// does a status without one (no pull request for the branch, no credential,
// GitHub unreachable): the store keeps the last known counts.
function pendingElsewhereHtml(shown: readonly number[]): string {
  const elsewhere = pullRequestStore.pendingElsewhere(shown);
  if (elsewhere.length === 0) return "";
  return `<ul class="pr-pane-elsewhere" aria-label="Your pending reviews on other pull requests">${elsewhere.map(({ number, count }) =>
    `<li><span class="gh-pill gh-pill-attention gh-pill-xs" aria-hidden="true">✎ ${count}</span> <span><a href="${escapeHtmlAttribute(previewHref(number, "files"))}" data-pr-pending-open="${number}" aria-label="Your review of #${number}">#${number}</a>: ${count} pending ${count === 1 ? "comment" : "comments"}</span></li>`).join("")}</ul>`;
}

function summaryHtml(pr: PullRequestSummary): string {
  const summary = pullRequestStore.state.summary!;
  const detail = pullRequestStore.detail(pr.number);
  const viewer = summary.viewer;
  const pending = pr.viewerPendingComments;
  const stale = summary.stale && summary.pullRequest?.number === pr.number;
  const reviewers = [...pr.reviewers];
  if (viewer && !reviewers.some(reviewer => reviewer.login === viewer) && pending > 0) reviewers.push({ login: viewer, state: "REQUESTED" });
  const open = pr.state === "OPEN";
  // GitHub can't be asked: the verdict is the last one read, said in place.
  const lastKnownAt = summary.status === "rate-limited" || summary.status === "unavailable" ? clockTime(summary.checkedAt) : null;
  const readiness = mergeReadinessView(pr, detail?.mergeReadiness ?? null, lastKnownAt);
  const scoped = pullRequestStore.scopedNumber() === pr.number;
  const toneClass = `is-${readiness.tone}${readiness.stale ? " is-stale" : ""}`;
  const previewed = appState.previewMode.kind === "pull-request" ? appState.previewMode.number : null;
  const paused = githubWritesPausedReason(summary);
  const finishPaused = pending > 0 && paused !== null;
  const reviewTitle = !open ? "This pull request is closed for review"
    : finishPaused ? `${paused} Your comments stay pending.`
    : pending > 0 ? "Finish your review: publish your pending comments as a comment, approval or change request"
    : "Approve, comment or request changes, with a summary and any line comments";
  // Always in view, even in a short pane: the top row (state, decision and
  // the Details toggle; the number is in the pane header) stays pinned while
  // the pane scrolls;
  // then the title, checks and the first blocker, then the actions. The rest
  // folds under Details. Rows are `data-pane-rows` children: the pane stack
  // sizes the pane to whole rows (sidebar/panes.ts).
  return `<div class="pr-pane${stale ? " is-stale" : ""}${scoped ? " is-viewed" : ""}" data-pane-rows>
      <div class="pr-pane-pin">
        <div class="pr-pane-top">
          <span class="pr-pane-row">
            ${stateBadge(pr)}
            ${open ? reviewDecisionBadge(pr.reviewDecision) : ""}
          </span>
          <button type="button" class="pr-pane-details-toggle" data-pr-details-toggle aria-expanded="${detailsOpen()}" aria-controls="pr-pane-details">${detailsOpen() ? "▾" : "▸"} Details</button>
        </div>
      </div>
      <a href="${escapeHtmlAttribute(previewHref(pr.number))}" data-pr-open="${pr.number}" class="pr-pane-title" title="${escapeHtmlAttribute(pr.title)}"><span class="pr-pane-title-text">${escapeHtml(pr.title)}</span></a>
      <p class="pr-pane-status ${toneClass}" title="${escapeHtmlAttribute([readiness.headline, ...readiness.reasons.slice(1)].join(" "))}"><span class="pr-pane-status-checks">${checksSummaryHtml(pr.checks)}</span> · <span>${escapeHtml(readiness.headline)}</span></p>
      ${open && readiness.pendingNote ? `<p class="pr-pane-pending"><span class="pr-pane-pending-full">${escapeHtml(readiness.pendingNote)}</span><span class="pr-pane-pending-short" aria-hidden="true">Finish your review before merging.</span></p>` : ""}
      <div class="pr-pane-actions"${detailsOpen() && !detailsFloat() ? "" : " data-pane-essential-end"}>
        <button type="button" class="gh-button${pending > 0 ? " gh-button-primary" : ""}" data-pr-action="review"${open && !finishPaused ? "" : " disabled"}${finishPaused ? ` aria-describedby="pr-pane-paused"` : ""} title="${escapeHtmlAttribute(reviewTitle)}">${reviewActionLabel(pending)}</button>
        ${open ? mergeLinkHtml(pr.url, readiness.tone === "ready" && !readiness.stale, "pr-pane-merge") : externalLink(pr.url, "View on GitHub")}
      </div>
      ${pendingElsewhereHtml([pr.number, ...(previewed === null ? [] : [previewed])])}
      <div id="pr-pane-details" class="pr-pane-details${detailsFloat() ? " is-floating" : ""}"${detailsFloat() ? ` role="group" aria-label="Details of #${pr.number}"` : " data-pane-rows"}${detailsOpen() ? (detailsFloat() ? "" : " data-pane-essential-end") : " hidden"}>
        <div class="pr-pane-branches">${branchesHtml(pr)}<span class="pr-pane-repo">${escapeHtml(repositoryName(summary))}</span></div>
        <div class="pr-pane-stats">${pr.commits} ${pr.commits === 1 ? "commit" : "commits"} · <a href="${escapeHtmlAttribute(previewHref(pr.number, "files"))}" data-pr-open="${pr.number}" data-pr-tab="files">${pr.changedFiles} ${pr.changedFiles === 1 ? "file" : "files"}</a> · <span class="gh-add">+${pr.additions}</span> <span class="gh-del">−${pr.deletions}</span> · by ${escapeHtml(pr.author)}</div>
        <h4 class="pr-pane-heading">Merge readiness</h4>
        <div class="pr-pane-readiness ${toneClass}" data-pane-rows>
          ${readiness.reasons.length ? `<ul class="pr-pane-reasons" data-pane-rows>${readiness.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}
          ${readiness.notes.map(note => `<p class="pr-muted">${escapeHtml(note)}</p>`).join("")}
        </div>
        <h4 class="pr-pane-heading">Checks · ${checksSummaryHtml(pr.checks)}</h4>
        <ul class="pr-pane-checks" data-pane-rows>${pr.checks.runs.map(run => `<li>${checkGlyph(run.state)}<span class="pr-pane-check-name">${escapeHtml(run.name)}</span><span class="pr-muted">${escapeHtml(run.detail)}</span></li>`).join("")}</ul>
        <h4 class="pr-pane-heading">Reviewers</h4>
        <ul class="pr-pane-reviewers" data-pane-rows>
          ${reviewers.length === 0 ? `<li class="pr-muted">No reviewers requested.</li>` : reviewers.map(reviewer => `<li>
            ${avatar(reviewer.login, "sm")}
            <span class="pr-pane-reviewer">${escapeHtml(reviewer.login)}${reviewer.login === viewer ? ` <span class="pr-muted">(you)</span>` : ""}</span>
            ${reviewerBadge(reviewer.state, reviewer.login === viewer ? pending : 0)}
          </li>`).join("")}
        </ul>
      </div>
    </div>`;
}

// Dev-only: shown only while the fake answers (`mock: true`).
function scenarioControl(): string {
  const summary = pullRequestStore.state.summary;
  if (!summary?.mock) return "";
  return `<div class="pr-pane-mock">
      ${mockNotice(true)}
      <label>Mock scenario
        <select data-pr-scenario>
          ${GITHUB_FAKE_SCENARIOS.map(scenario => `<option value="${scenario}"${scenario === summary.status ? " selected" : ""}>${scenario}</option>`).join("")}
        </select>
      </label>
      <button type="button" class="gh-link-button" data-pr-reset title="Re-seed the fake: deletes every comment, review and pending comment made so far">Reset data…</button>
    </div>`;
}

// Loads the summary PR's detail once per change, then feeds the Files pane
// its per-file thread / pending badges. A viewed PR's detail is read once per
// pick (and again on refresh); its writes keep it current.
function syncDetail(): void {
  syncScopedDetail();
  const summary = pullRequestStore.state.summary;
  const pr = summary?.pullRequest;
  if (!pr || summary?.status === "no-credential") {
    ensureTreeView().setReviewMarks(new Map(), "");
    return;
  }
  const key = `${pr.number}\n${pr.updatedAt}\n${pr.viewerPendingComments}\n${pr.checks.pending}`;
  const detail = pullRequestStore.detail(pr.number);
  if (detail) ensureTreeView().setReviewMarks(reviewMarksByPath(detail), `#${pr.number}`);
  if (key === detailKey) return;
  detailKey = key;
  pullRequestStore.loadDetail(pr.number).then(() => setMetaError(null), error => setMetaError(errorMessage(error)));
}

function syncScopedDetail(): void {
  const scoped = pullRequestStore.scopedNumber();
  // A viewed pull request is on screen: focus and Retry re-read it too.
  pullRequestStore.watch("pane", scoped);
  if (scoped === scopedRequested) return;
  scopedRequested = scoped;
  scopedError = null;
  if (scoped === null) return;
  pullRequestStore.loadDetail(scoped).catch(error => {
    if (pullRequestStore.scopedNumber() !== scoped) return;
    scopedError = errorMessage(error);
    renderPullRequestPane();
  });
}
