// "Browse pull requests…": the searchable list of the repository's open pull
// requests, reached by that name from the Pull request pane's header and its
// no-pull-request state, and as "From a pull request…" from the worktree
// (fork) menu, where its heading names that task ("Create a worktree from a
// pull request") so the default action is clear before Enter. Each row shows head branch, review state, checks and
// Draft / Fork badges, and the viewer's pending review if one is waiting. A
// PR whose branch is already checked out offers "Go to worktree" (in the
// footer, beside the other actions: options hold no controls of their own)
// instead of a duplicate.
//
// Creating the worktree is SIMULATED while GitHub data is mocked: the
// confirmation flow is real, the last step says plainly that nothing was
// created, and the Hub's worktree service is never called. "Show in
// workspace" makes the PR this workspace's current one without checking
// anything out: the Pull request pane, the PR preview and the Files pane's PR
// scope all show it, and focus moves to the PR's heading. The primary action
// (also a double click, or Enter on a row) follows where the picker was
// opened: "Create worktree…" from the worktree menu, "Show in workspace"
// elsewhere; the other stays beside it. Filter chips keep focus when chosen.
//
// The search field is a combobox over the list: Up / Down move the selection
// (aria-activedescendant, scrolled into view) while the caret stays put, and
// a re-render keeps the list's scroll position. On touch it is not focused
// on open (the keyboard would cover the list), and the picker is a
// full-height sheet.
//
// The list holds open pull requests only. A number (`642`, `#642`) or a pull
// request URL that matches none of them is looked up in any state, so a merged
// or closed one can still be shown here.

import { githubApi } from "../github/client";
import { errorMessage, pullRequestStore } from "../github/pull-request-store";
import { checkGlyph, mockNotice, reviewDecisionBadge, stateBadge } from "../github/present";
import { pullRequestLocalBranch, type PullRequestList, type PullRequestListItem, type PullRequestSummary } from "../shared/github-contract";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";

// Asks the page to show a pull request in this workspace. hub-nav.ts imports
// this module early, so it must not import shell/url.ts (that would pull the
// preview modules into the shell's import cycle); the Pull request pane,
// loaded from app.ts, performs the navigation.
export const OPEN_PULL_REQUEST_EVENT = "uatu:open-pull-request";
export type OpenPullRequestDetail = { repositoryId: string; number: number };

export type WorktreeMatch = { label: string; href: string | null; current: boolean };
type WorktreeContext = {
  // Display name of the main checkout ("uatu").
  workspaceName: () => string;
  findWorktree: (branch: string) => WorktreeMatch | null;
};

let worktreeContext: WorktreeContext | null = null;

// hub-nav.ts supplies the Hub's workspace inventory; outside a Hub there is
// none, and the picker offers only "Preview here".
export function setPullRequestPickerWorktrees(context: WorktreeContext): void {
  worktreeContext = context;
}

type Filter = "open" | "review-requested" | "mine" | "drafts";

// The pull request a search names outright: `642`, `#642`, or a pull request
// URL (`…/pull/642`, with or without a trailing path). Null for anything else.
export function pullRequestNumberFromQuery(query: string): number | null {
  const text = query.trim();
  const match = /^#?(\d{1,9})$/.exec(text) ?? /^https?:\/\/\S+\/pull\/(\d{1,9})(?:[/?#]\S*)?$/.exec(text);
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

const touchMode = () => document.documentElement.dataset.uiMode === "touch";

type Lookup = { status: "loading" } | { status: "found"; pr: PullRequestSummary } | { status: "error"; message: string };

export function openPullRequestPicker(options: {
  returnFocus?: HTMLElement;
  fallbackFocus?: () => HTMLElement | null | undefined;
  // What the picker is for: from the worktree menu, creating a worktree.
  intent?: "show" | "worktree";
} = {}): void {
  const repositoryId = pullRequestStore.state.repositoryId;
  const dialog = document.createElement("dialog");
  dialog.className = "gh-dialog gh-dialog-wide";
  const forWorktree = options.intent === "worktree";
  const heading = forWorktree ? "Create a worktree from a pull request" : "Browse pull requests";
  dialog.setAttribute("aria-label", heading);
  dialog.innerHTML = `<div class="gh-dialog-body"></div>`;
  document.body.append(dialog);
  // A shown pull request takes focus to its own heading (the Pull request
  // pane does that once the view is up); nothing to give back then.
  let shown = false;
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (shown) return;
    // The opener may be gone (a re-rendered pane, a closed menu): then the
    // fallback, then the Pull request pane's Browse button.
    for (const candidate of [options.returnFocus, options.fallbackFocus?.(), document.querySelector<HTMLElement>("#pull-request-browse")]) {
      if (!candidate?.isConnected) continue;
      candidate.focus();
      if (document.activeElement === candidate) return;
    }
  });
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  dialog.showModal();
  const body = dialog.querySelector<HTMLElement>(".gh-dialog-body")!;
  const close = () => dialog.close();

  const name = worktreeContext?.workspaceName() ?? "this repository";
  let list: PullRequestList | null = null;
  let error: string | null = null;
  let query = "";
  let filter: Filter = "open";
  let selected: number | null = null;
  let step: "list" | "confirm" | "done" = "list";
  // Pull requests looked up by number in any state, by number.
  const lookups = new Map<number, Lookup>();

  const matches = (item: PullRequestListItem): boolean => {
    if (filter === "review-requested" && !item.viewerReviewRequested) return false;
    if (filter === "mine" && item.author !== list?.viewer) return false;
    if (filter === "drafts" && !item.isDraft) return false;
    const needle = query.trim().toLowerCase().replace(/^#/, "");
    if (!needle) return true;
    return [String(item.number), item.title, item.author, item.headRefName, item.headOwner].some(field => field.toLowerCase().includes(needle));
  };
  const worktreeFor = (item: PullRequestListItem) => worktreeContext?.findWorktree(pullRequestLocalBranch(item)) ?? null;
  const folderFor = (item: PullRequestListItem) => `${name}.worktrees/${pullRequestLocalBranch(item).replace(/[^A-Za-z0-9._-]+/g, "-")}`;

  const load = async (manual: boolean) => {
    if (!repositoryId) {
      error = "No Git repository is loaded in this workspace yet.";
      render();
      return;
    }
    if (manual) { list = null; render(); }
    try {
      list = await githubApi.pullRequests(repositoryId);
      // The Pull request pane marks pending reviews from it too.
      pullRequestStore.applyList(list);
      error = null;
    } catch (failure) {
      error = errorMessage(failure);
    }
    render();
  };

  const lookUp = (number: number) => {
    if (!repositoryId || lookups.has(number)) return;
    lookups.set(number, { status: "loading" });
    githubApi.pullRequest({ repository: repositoryId, number }).then(
      detail => { lookups.set(number, { status: "found", pr: detail.summary }); },
      failure => { lookups.set(number, { status: "error", message: errorMessage(failure) }); },
    ).finally(() => { if (dialog.open && step === "list") render(); });
  };

  // A number the open list doesn't hold: its lookup, as a row of its own.
  function lookupHtml(number: number): string {
    const lookup = lookups.get(number);
    if (!lookup || lookup.status === "loading") return `<p class="pr-muted gh-dialog-empty" role="status">#${number} isn't open. Looking it up on GitHub…</p>`;
    if (lookup.status === "error") return `<p class="pr-muted gh-dialog-empty" role="status">#${number} isn't open, and GitHub couldn't show it: ${escapeHtml(lookup.message)}</p>`;
    const pr = lookup.pr;
    return `<div class="gh-picker-lookup" role="group" aria-label="Pull request #${pr.number}, ${escapeHtmlAttribute(pr.state.toLowerCase())}">
        <div class="gh-pr-row-main">
          <div class="gh-pr-row-title">${stateBadge(pr)} <span class="pr-muted">#${pr.number}</span> <strong>${escapeHtml(pr.title)}</strong></div>
          <div class="gh-pr-row-meta">${escapeHtml(pr.author)} · <code class="gh-ref">${escapeHtml(pr.isCrossRepository ? `${pr.headOwner}:${pr.headRefName}` : pr.headRefName)}</code> · not in the open list</div>
        </div>
        <button type="button" class="gh-button gh-button-primary" data-lookup-show="${pr.number}">Show #${pr.number} in workspace</button>
      </div>`;
  }

  const preview = (number: number) => {
    if (!repositoryId) return;
    shown = true;
    close();
    document.dispatchEvent(new CustomEvent<OpenPullRequestDetail>(OPEN_PULL_REQUEST_EVENT, { detail: { repositoryId, number } }));
  };

  function rowHtml(item: PullRequestListItem): string {
    const worktree = worktreeFor(item);
    // Words name the state; the glyph beside them is decoration.
    const checks = item.checks.failed > 0 ? `${checkGlyph("FAILURE", true)} ${item.checks.failed} failing`
      : item.checks.pending > 0 ? `${checkGlyph("PENDING", true)} running`
      : `${checkGlyph("SUCCESS", true)} ${item.checks.passed}/${item.checks.passed}<span class="sr-only"> passed</span>`;
    const review = item.viewerReviewRequested ? `<span class="gh-pill gh-pill-attention">Review requested</span>` : reviewDecisionBadge(item.reviewDecision);
    const head = item.isCrossRepository ? `${item.headOwner}:${item.headRefName}` : item.headRefName;
    const pending = Math.max(item.viewerPendingComments, pullRequestStore.pendingCount(item.number));
    const pendingText = `Your review is pending: ${pending} ${pending === 1 ? "comment" : "comments"}`;
    return `<li id="gh-pr-option-${item.number}" class="gh-pr-row${selected === item.number ? " is-selected" : ""}${worktree ? " has-worktree" : ""}" data-pr-row="${item.number}" role="option" aria-selected="${selected === item.number}">
        <div class="gh-pr-row-main">
          <div class="gh-pr-row-title"><span class="pr-muted">#${item.number}</span> <strong>${escapeHtml(item.title)}</strong>
            ${item.isDraft ? `<span class="gh-pill">Draft</span>` : ""}
            ${pending > 0 ? `<span class="gh-pill gh-pill-attention gh-pill-xs" title="${pendingText}"><span aria-hidden="true">✎ ${pending}</span><span class="sr-only">${pendingText}</span></span>` : ""}</div>
          <div class="gh-pr-row-meta">${escapeHtml(item.author)} · <code class="gh-ref">${escapeHtml(head)}</code>
            ${item.isCrossRepository ? `<span class="gh-pill gh-pill-fork">⑂ Fork</span>` : ""}
            ${worktree ? `· <span class="pr-muted">${worktree.current ? "checked out here" : "already open as a worktree"}</span>` : ""}
            ${item.number === pullRequestStore.currentNumber() ? `· <span class="gh-pill gh-pill-xs">Shown here</span>` : ""}</div>
        </div>
        <div class="gh-pr-row-aside">
          ${review}
          <span class="gh-pr-row-checks">${checks}</span>
        </div>
      </li>`;
  }

  // The primary action, by where the picker was opened; Enter and a double
  // click run it.
  const createFirst = options.intent === "worktree" && worktreeContext !== null;
  const primary = (number: number) => {
    if (!createFirst) { preview(number); return; }
    const item = list?.pullRequests.find(candidate => candidate.number === number);
    if (!item) return;
    selected = number;
    const worktree = worktreeFor(item);
    if (worktree) {
      if (worktree.current || !worktree.href) preview(number);
      else window.location.assign(worktree.href);
      return;
    }
    step = "confirm";
    render();
  };

  function render(options: { revealSelected?: boolean } = {}) {
    if (step === "confirm" || step === "done") {
      renderConfirm();
      return;
    }
    // A chosen filter chip (or Refresh) keeps focus across the re-render.
    const focusedControl = body.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).closest<HTMLElement>("[data-filter], [data-picker-refresh]")
      : null;
    const focusKey = focusedControl?.dataset.filter !== undefined ? `[data-filter="${focusedControl.dataset.filter}"]`
      : focusedControl ? "[data-picker-refresh]" : null;
    // What the re-render must keep: the list's scroll and the field's caret.
    const listScroll = body.querySelector<HTMLElement>(".gh-pr-list")?.scrollTop ?? 0;
    const oldInput = body.querySelector<HTMLInputElement>("input[type=search]");
    const caret = oldInput && document.activeElement === oldInput ? [oldInput.selectionStart, oldInput.selectionEnd] as const : null;
    const items = list?.pullRequests ?? [];
    const visible = items.filter(matches);
    if (selected !== null && !visible.some(item => item.number === selected)) selected = null;
    const chosen = items.find(item => item.number === selected) ?? null;
    const counts = {
      open: items.length,
      review: items.filter(item => item.viewerReviewRequested).length,
      mine: items.filter(item => item.author === list?.viewer).length,
      drafts: items.filter(item => item.isDraft).length,
    };
    const chip = (value: Filter, label: string, count: number) =>
      `<button type="button" class="gh-chip${filter === value ? " is-active" : ""}" data-filter="${value}" aria-pressed="${filter === value}">${label}${count ? ` · ${count}` : ""}</button>`;
    const chosenWorktree = chosen ? worktreeFor(chosen) : null;
    const wanted = pullRequestNumberFromQuery(query);
    const lookupNumber = list && wanted !== null && !visible.some(item => item.number === wanted) ? wanted : null;
    if (lookupNumber !== null) lookUp(lookupNumber);
    body.innerHTML = `
      <h2 class="gh-dialog-title">${heading} · ${escapeHtml(name)}</h2>
      <p class="gh-dialog-sub"><span class="gh-picker-help"><strong>Show in workspace</strong> reviews a PR here, with its files in the Files pane; <strong>Create worktree</strong> checks its head out as a new worktree of <strong>${escapeHtml(name)}</strong>. </span>${mockNotice(Boolean(list?.mock))}</p>
      <div class="gh-picker-search">
        <input type="search" class="gh-input" placeholder="Search titles, numbers, authors and branches" aria-label="Search pull requests" value="${escapeHtmlAttribute(query)}"
          role="combobox" aria-autocomplete="list" aria-expanded="${visible.length > 0}" aria-controls="gh-pr-listbox"${selected !== null && visible.some(item => item.number === selected) ? ` aria-activedescendant="gh-pr-option-${selected}"` : ""}>
        <button type="button" class="gh-button gh-icon-button" data-picker-refresh aria-label="Re-read open pull requests from GitHub" title="Re-read from GitHub">↻</button>
      </div>
      <div class="gh-chips" role="group" aria-label="Filter">
        ${chip("open", "Open", counts.open)}${chip("review-requested", "Review requested", counts.review)}${chip("mine", "Mine", counts.mine)}${chip("drafts", "Drafts", counts.drafts)}
      </div>
      ${error ? `<p class="gh-dialog-error" role="alert">${escapeHtml(error)}</p>` : ""}
      ${!list && !error ? `<p class="pr-muted">Reading open pull requests…</p>` : ""}
      ${list ? visible.length === 0
        ? lookupNumber === null ? `<p class="pr-muted gh-dialog-empty">No open pull request matches. Type a number or paste a pull request URL to find a merged or closed one.</p>` : ""
        : `<ul id="gh-pr-listbox" class="gh-pr-list" role="listbox" aria-label="Open pull requests">${visible.map(rowHtml).join("")}</ul>` : ""}
      ${lookupNumber !== null ? lookupHtml(lookupNumber) : ""}
      ${chosen?.isCrossRepository ? `<div class="gh-notice gh-notice-warn"><strong>#${chosen.number} comes from a fork.</strong> The worktree checks out <code>pull/${chosen.number}/head</code> as branch <code>${escapeHtml(pullRequestLocalBranch(chosen))}</code>. You can review and comment there; uatu doesn't push to <code>${escapeHtml(chosen.headOwner)}/${escapeHtml(list?.repository.name ?? "")}</code>.</div>` : ""}
      <div class="gh-dialog-footer">
        <span class="gh-dialog-attribution">${chosen && !chosenWorktree ? `Worktree folder: <code>${escapeHtml(folderFor(chosen))}</code>` : chosen ? `#${chosen.number} is already checked out.` : "Select a pull request."}</span>
        <span class="gh-dialog-actions">
          <button type="button" class="gh-button" data-dialog-cancel>Cancel</button>
          ${chosenWorktree ? `<button type="button" class="gh-button${createFirst ? " gh-button-primary" : ""}" data-go-worktree>Go to worktree</button>`
            : worktreeContext ? `<button type="button" class="gh-button${createFirst ? " gh-button-primary" : ""}" data-picker-create${chosen ? "" : " disabled"}>Create worktree…</button>` : ""}
          <button type="button" class="gh-button${createFirst ? "" : " gh-button-primary"}" data-picker-preview${chosen ? "" : " disabled"} title="Show this pull request and its files here, without checking it out">Show in workspace</button>
        </span>
      </div>`;

    const input = body.querySelector<HTMLInputElement>("input[type=search]")!;
    input.addEventListener("input", () => {
      query = input.value;
      render();
    });
    input.addEventListener("keydown", event => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
      const numbers = visible.map(item => item.number);
      const found = lookupNumber !== null ? lookups.get(lookupNumber) : undefined;
      if (numbers.length === 0) {
        // Enter shows a looked-up pull request, as it shows a selected row.
        if (event.key === "Enter" && found?.status === "found") {
          event.preventDefault();
          preview(found.pr.number);
        }
        return;
      }
      event.preventDefault();
      if (event.key === "Enter") {
        if (selected !== null) primary(selected);
        return;
      }
      const index = selected === null ? -1 : numbers.indexOf(selected);
      selected = numbers[(index + (event.key === "ArrowDown" ? 1 : numbers.length - 1)) % numbers.length] ?? null;
      render({ revealSelected: true });
    });
    body.querySelector("[data-picker-refresh]")!.addEventListener("click", () => { lookups.clear(); void load(true); });
    body.querySelector<HTMLButtonElement>("[data-lookup-show]")?.addEventListener("click", event => preview(Number((event.currentTarget as HTMLButtonElement).dataset.lookupShow)));
    for (const button of body.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
      button.addEventListener("click", () => { filter = button.dataset.filter as Filter; render(); });
    }
    for (const row of body.querySelectorAll<HTMLElement>("[data-pr-row]")) {
      row.addEventListener("click", () => {
        selected = Number(row.dataset.prRow);
        render();
      });
      row.addEventListener("dblclick", () => primary(Number(row.dataset.prRow)));
    }
    body.querySelector("[data-go-worktree]")?.addEventListener("click", () => {
      if (!chosen || !chosenWorktree) return;
      if (chosenWorktree.current || !chosenWorktree.href) preview(chosen.number);
      else window.location.assign(chosenWorktree.href);
    });
    body.querySelector("[data-dialog-cancel]")!.addEventListener("click", close);
    body.querySelector("[data-picker-preview]")!.addEventListener("click", () => { if (selected !== null) preview(selected); });
    body.querySelector("[data-picker-create]")?.addEventListener("click", () => { step = "confirm"; render(); });
    const listElement = body.querySelector<HTMLElement>(".gh-pr-list");
    if (listElement) listElement.scrollTop = listScroll;
    if (options.revealSelected) body.querySelector<HTMLElement>(".gh-pr-row.is-selected")?.scrollIntoView({ block: "nearest" });
    const keepFocus = focusKey ? body.querySelector<HTMLElement>(focusKey) : null;
    if (keepFocus) {
      keepFocus.focus({ preventScroll: true });
    } else if (caret) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(caret[0] ?? input.value.length, caret[1] ?? input.value.length);
    } else if (document.activeElement === document.body || !body.contains(document.activeElement)) {
      // On touch, focus stays off the field: the keyboard would cover the
      // list. The dialog itself takes focus there.
      if (touchMode()) {
        dialog.tabIndex = -1;
        dialog.focus({ preventScroll: true });
      } else {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  function renderConfirm() {
    const item = list?.pullRequests.find(candidate => candidate.number === selected);
    if (!item) { step = "list"; render(); return; }
    const branch = pullRequestLocalBranch(item);
    const source = item.isCrossRepository ? `<code>pull/${item.number}/head</code> from the base repository` : `<code>origin/${escapeHtml(item.headRefName)}</code>`;
    if (step === "done") {
      body.innerHTML = `
        <h2 class="gh-dialog-title">Simulated: no worktree was created</h2>
        <div class="gh-notice gh-notice-warn">GitHub data is mocked in this build, so creating a worktree for #${item.number} is simulated. Nothing was fetched, no branch was created, and the Hub's worktree list is unchanged.</div>
        <p>With real GitHub data this would now open <strong>${escapeHtml(name)} · ${escapeHtml(branch)}</strong> in <code>${escapeHtml(folderFor(item))}</code>, with #${item.number}'s review in its sidebar.</p>
        <div class="gh-dialog-footer"><span></span><span class="gh-dialog-actions">
          <button type="button" class="gh-button" data-dialog-cancel>Close</button>
          <button type="button" class="gh-button gh-button-primary" data-picker-preview>Show #${item.number} in this workspace</button>
        </span></div>`;
    } else {
      body.innerHTML = `
        <h2 class="gh-dialog-title">Create a worktree for #${item.number}?</h2>
        <p class="gh-dialog-sub">${escapeHtml(item.title)}</p>
        <dl class="gh-facts">
          <dt>Branch</dt><dd><code>${escapeHtml(branch)}</code>${item.isCrossRepository ? " (new local branch)" : " (tracks the PR's head branch)"}</dd>
          <dt>From</dt><dd>${source}</dd>
          <dt>Folder</dt><dd><code>${escapeHtml(folderFor(item))}</code></dd>
          <dt>Credentials</dt><dd>Inherited from <strong>${escapeHtml(name)}</strong></dd>
        </dl>
        <div class="gh-notice gh-notice-warn"><strong>Simulated.</strong> GitHub data is mocked here, so confirming shows the result without creating anything.</div>
        <div class="gh-dialog-footer"><span></span><span class="gh-dialog-actions">
          <button type="button" class="gh-button" data-picker-back>Back</button>
          <button type="button" class="gh-button gh-button-primary" data-picker-confirm>Create worktree (simulated)</button>
        </span></div>`;
    }
    body.querySelector("[data-dialog-cancel]")?.addEventListener("click", close);
    body.querySelector("[data-picker-back]")?.addEventListener("click", () => { step = "list"; render(); });
    body.querySelector("[data-picker-confirm]")?.addEventListener("click", () => { step = "done"; render(); });
    body.querySelector("[data-picker-preview]")?.addEventListener("click", () => preview(item.number));
    // The safe choice, as in every confirmation: Back from the question,
    // Close from the result.
    body.querySelector<HTMLButtonElement>("[data-picker-back], [data-dialog-cancel]")?.focus();
  }

  render();
  void load(false);
}
