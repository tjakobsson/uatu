// Files changed: the pull request's diffs against its base, with inline
// review on top of `@pierre/diffs` line annotations (design D10). Threads,
// the viewer's pending comments and the open composers are annotations;
// the gutter "+", a click or tap on a line number, or Enter on a focused
// line number (src/preview/diff-review-lines.ts) opens a composer, and
// "Add to review" is its only action, so every inline comment lands in the
// pending review. Several lines may hold unsent drafts at once: opening
// another line keeps a composer with text open and closes an empty one.
// Files are listed in tree order (src/shared/tree-order.ts), as the Files
// pane lists them. Each file's header, pinned only within its own file
// while its diff scrolls, names the file and holds Comment on a line (a
// composer on the file's first non-blank changed line, whose line picker
// moves it; on touch with a visible "Comment" label). Jump to file (a list of
// every file) is one button in the preview header's pinned tabs row
// (pull-request-view.ts opens it through openJump), and so is the one review
// button, Review (it opens the review dialog, whose Add line comments comes
// back here through addLineComments), or Finish (n) while a review is in
// progress (reviewBarShownOn). On desktop a bar above the files holds the
// how-to and, while a review is in progress, the pending count and Discard
// review, pinned. On touch the how-to is a one-line hint in the files
// toolbar that folds to an icon once the reviewer starts or scrolls
// (remembered per device), and a tap on a line's row opens its composer. A
// resolved thread folds away the moment it is resolved, unless it holds the
// viewer's pending reply or reply text; a pending reply has its own Edit and
// Discard.
//
// Unsent text survives re-renders and reloads: composers are kept across
// annotation re-renders and their text is saved per location
// (src/preview/pr-drafts.ts); a saved draft GitHub already holds is dropped,
// not reopened. The viewer's pending comments can be edited in place. While
// GitHub can't take writes, composers stay open for drafting and every
// sending control says why it waits. Opening the composer keeps the line it
// comments on in view above it, and its actions clear of the touch tab bar.
//
// The diffs come from the GitHub service. With the fake they are synthetic,
// so every displayed line is the PR's own line and commenting is always
// offered; the real service applies the anchoring rule (D8) first.

import { githubWritesPausedReason, sendBlockedReason } from "../github/availability";
import { githubApi } from "../github/client";
import { pullRequestStore } from "../github/pull-request-store";
import { age, avatar, shortOid } from "../github/present";
import type { DiffSide, PendingComment, PullRequestDetail, PullRequestFile, ReviewThread } from "../shared/github-contract";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { appState } from "../shell/state";
import { previewScrollEventTarget, previewScrollRoot } from "../shell/preview-scroll-root";
import { tabBarBottomInset } from "../shell/tab-bar";
import { onUiModeChange } from "../shell/ui-mode";
import type { DiffStyle } from "../shared/types";
import { createComposer, type Composer } from "./pr-composer";
import { draftAlreadySent, matchingComments, prDrafts } from "./pr-drafts";
import { confirmDiscardPendingComment, confirmDiscardReview, openSubmitReviewDialog, reviewActionLabel, showToast, trackDialogFooter } from "./review-dialogs";
import { anchorLabel, filterJumpPaths, firstCommentLine, inlineComposerPrompt, lineOptionText, moveLineIndex } from "./diff-review-lines";
import { inTreeOrder } from "../shared/tree-order";
import { presentationLocalStorage } from "../shell/presentation-storage";
import { renderReviewDiff, type DiffAnnotationSide, type DiffReviewAnnotation, type DiffReviewHandle } from "./diff-view";

type AnnotationData =
  | { kind: "thread"; threadId: string; version: number }
  | { kind: "pending"; commentId: string; version: number }
  | { kind: "composer"; key: string; version: number };

type ComposerTarget = { path: string; side: DiffSide; line: number };
const composerKey = (target: ComposerTarget) => `${target.path}\n${target.side}\n${target.line}`;

export type FilesChangedView = {
  update: (detail: PullRequestDetail) => void;
  // Re-reads whether GitHub takes writes now (the summary moved).
  syncAvailability: () => void;
  reveal: (target: { path?: string; threadId?: string; pendingId?: string }) => void;
  // "Add line comments" (the review dialog): a composer on the first file's
  // first non-blank changed line, with focus in its text (the line picker is
  // one Shift+Tab back).
  addLineComments: () => void;
  // Jump to file: the list of every file, the one being read marked.
  openJump: (opener: HTMLElement) => void;
};

// Split needs room for two code columns; below this the diff stays Unified.
export const SPLIT_MIN_WIDTH = 600;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  md: "markdown", ts: "typescript", tsx: "tsx", js: "javascript", json: "json", css: "css", html: "html", yaml: "yaml", yml: "yaml",
};

function languageFor(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

const toSide = (side: DiffAnnotationSide): DiffSide => (side === "deletions" ? "LEFT" : "RIGHT");
const fromSide = (side: DiffSide): DiffAnnotationSide => (side === "LEFT" ? "deletions" : "additions");
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// The per-file counts the Files pane badges and the file headers share.
export function reviewMarksByPath(detail: PullRequestDetail): Map<string, { threads: number; pending: number }> {
  const marks = new Map<string, { threads: number; pending: number }>();
  const entry = (path: string) => {
    let mark = marks.get(path);
    if (!mark) marks.set(path, (mark = { threads: 0, pending: 0 }));
    return mark;
  };
  for (const thread of detail.threads) if (!thread.isResolved) entry(thread.path).threads += 1;
  for (const comment of detail.pendingReview?.comments ?? []) entry(comment.path).pending += 1;
  return marks;
}

// The glyphs are decoration; the count reads as words.
export function reviewMarkBadges(mark: { threads: number; pending: number } | undefined): string {
  if (!mark) return "";
  const threads = `${plural(mark.threads, "open review thread", "open review threads")}`;
  const pending = `${plural(mark.pending, "pending comment", "pending comments")} in your review`;
  return `${mark.threads > 0 ? `<span class="gh-count gh-count-thread" title="${threads}"><span aria-hidden="true">💬 ${mark.threads}</span><span class="sr-only">${threads}</span></span>` : ""}`
    + `${mark.pending > 0 ? `<span class="gh-count gh-count-pending" title="${pending}"><span aria-hidden="true">✎ ${mark.pending}</span><span class="sr-only">${pending}</span></span>` : ""}`;
}

// Whether the composer's line picker should be offered as a separate,
// full-size control: touch, where line numbers are too small to aim at.
const touchMode = () => document.documentElement.dataset.uiMode === "touch";

// Beside Resolve / Unresolve on touch, where no tooltip shows: resolving is
// not part of the pending review. Decoration: the button's name says it.
const APPLIES_NOW = `<span class="pr-applies-now" aria-hidden="true">Applies now</span>`;
// How long a thread just resolved offers Undo in its folded footer.
const UNDO_RESOLVE_MS = 8000;

// The file header's Comment button icon (decoration: the button is named;
// on touch a short visible label sits beside it).
const COMMENT_PLUS_ICON = `<svg class="pr-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-4.6A8.5 8.5 0 1 1 21 11.5z"/><path d="M12.25 8v7M8.75 11.5h7"/></svg>`;

// The touch how-to hint (in the files toolbar), once folded to its icon on
// this device: dismissed, or folded on its own once the reviewer started (a
// pending comment, an open composer) or scrolled the files.
const REVIEW_HINT_KEY = "uatu:pr-review-hint-dismissed";
export const reviewHintDismissed = (): boolean => presentationLocalStorage()?.getItem(REVIEW_HINT_KEY) === "1";
const dismissReviewHint = () => presentationLocalStorage()?.setItem(REVIEW_HINT_KEY, "1");

// Where the review state shows. The one review button (Review, or Finish
// while a review is pending) is in the preview header's tabs row (the
// "header" surface, pinned while the diff scrolls) on both tabs, on touch
// and desktop alike. Desktop adds a bar above the files on Files changed
// (the how-to, and while a review is pending its count and Discard review)
// and above the conversation while a review is pending; touch has no such
// band, so it takes no rows.
export type ReviewBarSurface = "files" | "conversation" | "header";
export function reviewBarShownOn(surface: ReviewBarSurface, layout: { touch: boolean; pending: number; open: boolean }): boolean {
  if (surface === "header") return layout.open || layout.pending > 0;
  if (surface === "files") return !layout.touch;
  return layout.pending > 0 && !layout.touch;
}

// The keys that comment on a line, said in the desktop bar.
export const REVIEW_KEYS_HINT = "Click a line number (or hover a line and click <kbd>+</kbd>) to comment on it. From the keyboard: <kbd>Tab</kbd> to a file's line numbers, move with <kbd>↑</kbd> <kbd>↓</kbd>, and press <kbd>Enter</kbd>.";

export function mountFilesChanged(host: HTMLElement, initial: PullRequestDetail, repositoryId: string): FilesChangedView {
  let detail = initial;
  let version = 0;
  const draftTarget = { repositoryId, number: initial.summary.number };
  // The open inline composers, by line (composerKey), kept across
  // annotation re-renders. Several may hold drafts at once; an empty one
  // gives way when another line is opened.
  const composers = new Map<string, ComposerTarget>();
  const composerBoxes = new Map<string, { wrapper: HTMLElement; box: Composer }>();
  const composerOpeners = new Map<string, HTMLElement | null>();
  // Focus a composer's textarea (or its line picker) when it next renders.
  let composerFocus: { key: string; kind: "text" | "line" } | null = null;
  // Threads whose reply box is open, and their composers.
  const openReplies = new Set<string>();
  const replyBoxes = new Map<string, Composer>();
  // Pending comments being edited in place, and their composers.
  const openEdits = new Set<string>();
  const editBoxes = new Map<string, Composer>();
  const expandedResolved = new Set<string>();
  // Threads being resolved or unresolved: shown in their new state at once,
  // while GitHub takes the write.
  const resolving = new Map<string, boolean>();
  // Threads the reviewer has just resolved: their folded footer says so,
  // with the way back named Undo, for UNDO_RESOLVE_MS (the same button as
  // Unresolve, so focus stays on it when the window ends).
  const justResolved = new Map<string, ReturnType<typeof setTimeout>>();
  const forgetJustResolved = (threadId: string) => {
    const timer = justResolved.get(threadId);
    if (timer !== undefined) clearTimeout(timer);
    justResolved.delete(threadId);
  };
  // The files in tree order, as the Files pane lists them.
  const orderedFiles = () => inTreeOrder(detail.files);
  const handles = new Map<string, DiffReviewHandle<AnnotationData>>();
  const target = () => ({ repository: repositoryId, number: detail.summary.number });
  let diffStyle: DiffStyle = appState.diffStyle;
  let narrow = false;
  let rendered: Promise<void> = Promise.resolve();
  const blockedReason = () => sendBlockedReason(pullRequestStore.state.summary, detail.summary);

  // Drafts left by an earlier page: reopen them where they were, except
  // those GitHub already holds (the page went away after sending them).
  const unsent = (kind: "inline" | "reply" | "edit") => prDrafts.list(draftTarget, kind).filter(entry => {
    if (!draftAlreadySent(entry.location, entry.draft, initial)) return true;
    prDrafts.clear(draftTarget, entry.location);
    return false;
  });
  for (const entry of unsent("inline")) {
    const location = entry.location;
    if (location.kind !== "inline" || !initial.files.some(file => file.path === location.path)) continue;
    const position = { path: location.path, side: location.side, line: location.line };
    composers.set(composerKey(position), position);
  }
  for (const entry of unsent("reply")) {
    if (entry.location.kind === "reply" && initial.threads.some(thread => thread.id === (entry.location as { threadId: string }).threadId)) {
      openReplies.add(entry.location.threadId);
    }
  }
  for (const entry of unsent("edit")) if (entry.location.kind === "edit") openEdits.add(entry.location.commentId);

  host.innerHTML = `
    <div class="pr-review-bar" data-pr-review-bar role="region" aria-label="Your review"></div>
    <div class="pr-files-toolbar">
      <p class="pr-files-summary" data-pr-files-summary></p>
      <span class="pr-review-hint" data-review-hint hidden></span>
      <div class="view-control" role="radiogroup" aria-label="Diff layout">
        <button type="button" class="view-segment" role="radio" data-diff-style="unified">Unified</button>
        <button type="button" class="view-segment" role="radio" data-diff-style="split">Split</button>
      </div>
    </div>
    <div class="pr-files" data-pr-files></div>`;
  const bar = host.querySelector<HTMLElement>("[data-pr-review-bar]")!;
  const filesElement = host.querySelector<HTMLElement>("[data-pr-files]")!;
  const effectiveStyle = (): DiffStyle => (narrow ? "unified" : diffStyle);

  // The bar is pinned under the preview's sticky header, at
  // --pr-sticky-top (set on the view by pull-request-view.ts).
  // Jumps and focus scrolling land below the pinned review bar (CSS
  // scroll-margin reads this); an inactive bar scrolls away, so it counts 0.
  const syncBarHeight = () => {
    host.style.setProperty("--pr-review-bar-height", `${bar.classList.contains("is-active") ? bar.offsetHeight : 0}px`);
    const header = filesElement.querySelector<HTMLElement>(".pr-file-header");
    if (header) host.style.setProperty("--pr-file-header-height", `${header.offsetHeight}px`);
  };
  // What is pinned over the files at the top of the scroll root: the preview
  // header, an active review bar, and (inside a file) its header.
  const pinnedHeight = (insideFile: boolean) => (parseFloat(getComputedStyle(host).getPropertyValue("--pr-sticky-top")) || 0)
    + (bar.classList.contains("is-active") ? bar.offsetHeight : 0)
    + (insideFile ? filesElement.querySelector<HTMLElement>(".pr-file-header")?.offsetHeight ?? 0 : 0);
  const resizeObserver = new ResizeObserver(() => {
    syncBarHeight();
    const nextNarrow = host.clientWidth > 0 && host.clientWidth < SPLIT_MIN_WIDTH;
    if (nextNarrow === narrow) return;
    narrow = nextNarrow;
    renderSummary();
    if (diffStyle === "split") rendered = renderFiles();
  });
  resizeObserver.observe(host);
  resizeObserver.observe(bar);
  narrow = host.clientWidth > 0 && host.clientWidth < SPLIT_MIN_WIDTH;

  const pendingComments = () => detail.pendingReview?.comments ?? [];
  const write = async (run: () => Promise<PullRequestDetail>) => {
    const next = await run();
    pullRequestStore.applyDetail(next);
  };
  // The one review button, in the preview header's tabs row; else the bar.
  const focusBar = () => {
    const button = document.querySelector<HTMLElement>("#pr-view-review [data-review-finish]:not(:disabled), #pr-view-review [data-review-open]");
    if (button) { button.focus({ preventScroll: true }); return; }
    bar.tabIndex = -1;
    bar.focus({ preventScroll: true });
  };

  function renderBar() {
    renderReviewBar(bar, detail, repositoryId, { surface: "files", fallbackFocus: afterReviewFocus });
    renderHint();
    syncBarHeight();
  }

  // Touch's how-to: one line in the files toolbar, with a button that folds
  // it to an icon (remembered on this device). It folds on its own once the
  // reviewer has started (a pending comment, an open composer) or scrolled
  // the files; the icon opens it again for this page.
  const hintElement = host.querySelector<HTMLElement>("[data-review-hint]")!;
  let hintOpen: boolean | null = null;
  function renderHint() {
    const show = touchMode() && detail.summary.state === "OPEN";
    hintElement.hidden = !show;
    if (!show) { hintElement.innerHTML = ""; return; }
    if (pendingComments().length > 0 || composers.size > 0) foldHint();
    const expanded = hintOpen ?? !reviewHintDismissed();
    const hadFocus = hintElement.contains(document.activeElement);
    const id = `pr-review-hint-${detail.summary.number}`;
    hintElement.classList.toggle("is-folded", !expanded);
    hintElement.innerHTML = `${expanded ? `<span class="pr-review-hint-text" id="${id}">Tap a line to comment on it.</span>` : ""}<button type="button" class="pr-review-hint-toggle" data-review-hint-toggle aria-expanded="${expanded}"${expanded ? ` aria-controls="${id}" aria-label="Hide how to comment" title="Hide this hint"` : ` aria-label="How to comment" title="How to comment"`}>${expanded ? "×" : "?"}</button>`;
    if (hadFocus) hintElement.querySelector<HTMLElement>("[data-review-hint-toggle]")?.focus({ preventScroll: true });
  }
  // Folded for good on this device; a hint reopened on this page stays open.
  function foldHint() {
    if (!reviewHintDismissed()) dismissReviewHint();
  }
  hintElement.addEventListener("click", event => {
    if (!(event.target as HTMLElement).closest("[data-review-hint-toggle]")) return;
    const expanded = hintOpen ?? !reviewHintDismissed();
    if (expanded) { dismissReviewHint(); hintOpen = false; } else hintOpen = true;
    renderHint();
  });
  // The first scroll of the files folds the hint.
  const scrollTarget = previewScrollEventTarget();
  const scrollStart = previewScrollRoot().scrollTop;
  const onFirstScroll = () => {
    if (!host.isConnected) { scrollTarget.removeEventListener("scroll", onFirstScroll); return; }
    if (host.closest<HTMLElement>("[data-pr-panel]")?.hidden || Math.abs(previewScrollRoot().scrollTop - scrollStart) < 24) return;
    scrollTarget.removeEventListener("scroll", onFirstScroll);
    if (reviewHintDismissed()) return;
    foldHint();
    renderHint();
  };
  scrollTarget.addEventListener("scroll", onFirstScroll, { passive: true });

  // The file being read: the one taking the most of the visible rows under
  // the pinned chrome, else the first.
  function currentSection(): HTMLElement | null {
    const sections = [...filesElement.querySelectorAll<HTMLElement>(".pr-file")];
    const root = previewScrollRoot();
    const page = root === document.scrollingElement;
    const top = (page ? 0 : root.getBoundingClientRect().top) + pinnedHeight(false);
    const bottom = Math.min(window.innerHeight, page ? window.innerHeight : root.getBoundingClientRect().bottom) - tabBarBottomInset();
    let best: HTMLElement | null = null;
    let most = 0;
    for (const section of sections) {
      const rect = section.getBoundingClientRect();
      const shown = Math.min(rect.bottom, bottom) - Math.max(rect.top, top);
      if (shown > most) { most = shown; best = section; }
    }
    return best ?? sections[0] ?? null;
  }

  // After Finish review publishes the review (the bar's Finish is gone),
  // focus stays in Files changed: on the bar when it is in view, else on
  // the header of the file being read.
  function afterReviewFocus(): HTMLElement | null {
    const rect = bar.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < window.innerHeight - tabBarBottomInset()) {
      bar.tabIndex = -1;
      return bar;
    }
    return currentSection()?.querySelector<HTMLElement>("[data-file-toggle]") ?? null;
  }

  // One line: the counts, then base → head (what the diffs compare).
  function renderSummary() {
    const pr = detail.summary;
    const refs = `Compared against the pull request's base, ${pr.baseRefName} at ${shortOid(pr.baseRefOid)}; head ${shortOid(pr.headRefOid)}`;
    host.querySelector("[data-pr-files-summary]")!.innerHTML = `<strong>${plural(pr.changedFiles, "file", "files")}</strong> · <span class="gh-add">+${pr.additions}</span> <span class="gh-del">−${pr.deletions}</span> · <span class="pr-files-refs" title="${escapeHtmlAttribute(refs)}"><span class="sr-only">base </span><code>${escapeHtml(pr.baseRefName)}@${escapeHtml(shortOid(pr.baseRefOid))}</code> <span aria-hidden="true">←</span><span class="sr-only"> head </span> <code>${escapeHtml(shortOid(pr.headRefOid))}</code></span>${detail.mock ? ` · <span class="gh-mock-label" title="Mocked diffs: served by the in-memory fake; nothing reaches GitHub">Mocked</span>` : ""}`;
    for (const button of host.querySelectorAll<HTMLButtonElement>("[data-diff-style]")) {
      const active = button.dataset.diffStyle === effectiveStyle();
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(active));
    }
    // Below SPLIT_MIN_WIDTH Split isn't offered at all (two code columns
    // don't fit), so there is no layout to choose.
    const layout = host.querySelector<HTMLElement>(".pr-files-toolbar .view-control");
    if (layout) layout.hidden = narrow;
    const marks = reviewMarksByPath(detail);
    for (const file of detail.files) {
      const header = filesElement.querySelector<HTMLElement>(`[data-file-header="${CSS.escape(file.path)}"] [data-file-badges]`);
      if (header) header.innerHTML = reviewMarkBadges(marks.get(file.path));
    }
  }

  // Jump to file: every file in tree order, with its counts; the file being
  // read is marked. A filter field over the list narrows it by path (focused
  // on desktop; on touch, where it would raise the keyboard, a tap away):
  // Enter there opens the first match, and the arrow keys move between the
  // filter and the rows. Picking one scrolls to it and focuses its header.
  function openJumpDialog(opener: HTMLElement) {
    const marks = reviewMarksByPath(detail);
    // The file being read.
    const current = currentSection()?.dataset.filePath ?? null;
    const files = orderedFiles();
    const dialog = document.createElement("dialog");
    dialog.className = "gh-dialog pr-jump-dialog";
    dialog.setAttribute("aria-labelledby", "pr-jump-title");
    dialog.innerHTML = `<div class="gh-dialog-body">
        <h2 class="gh-dialog-title" id="pr-jump-title">Jump to file</h2>
        <p class="gh-dialog-sub">${plural(files.length, "file", "files")} in #${detail.summary.number}</p>
        <input type="search" class="gh-input pr-jump-filter" data-jump-filter placeholder="Filter by path" aria-label="Filter files by path" aria-controls="pr-jump-list" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">
        <p class="pr-muted pr-jump-empty" data-jump-empty role="status" hidden></p>
        <ul class="pr-jump-list" id="pr-jump-list">${files.map(file => `<li data-jump-row="${escapeHtmlAttribute(file.path)}"><button type="button" class="pr-jump-item" data-jump-path="${escapeHtmlAttribute(file.path)}"${file.path === current ? ` aria-current="true"` : ""}>
            <span class="pr-jump-path">${escapeHtml(file.path)}</span>
            ${reviewMarkBadges(marks.get(file.path))}
            <span class="pr-jump-counts"><span class="gh-add">+${file.additions}</span> <span class="gh-del">−${file.deletions}</span></span>
          </button></li>`).join("")}</ul>
        <div class="gh-dialog-footer"><span></span><span class="gh-dialog-actions"><button type="button" class="gh-button" data-dialog-cancel>Close</button></span></div>
      </div>`;
    document.body.append(dialog);
    const filter = dialog.querySelector<HTMLInputElement>("[data-jump-filter]")!;
    const empty = dialog.querySelector<HTMLElement>("[data-jump-empty]")!;
    const shownItems = () => [...dialog.querySelectorAll<HTMLElement>("[data-jump-row]:not([hidden]) [data-jump-path]")];
    filter.addEventListener("input", () => {
      const matches = new Set(filterJumpPaths(files.map(file => file.path), filter.value));
      for (const row of dialog.querySelectorAll<HTMLElement>("[data-jump-row]")) row.hidden = !matches.has(row.dataset.jumpRow!);
      empty.hidden = matches.size > 0;
      empty.textContent = matches.size > 0 ? "" : `No file path contains “${filter.value.trim()}”.`;
    });
    let picked: string | null = null;
    filter.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        const first = shownItems()[0];
        if (first) { picked = first.dataset.jumpPath!; dialog.close(); }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        shownItems()[0]?.focus();
      }
    });
    dialog.querySelector(".pr-jump-list")!.addEventListener("keydown", event => {
      const key = (event as KeyboardEvent).key;
      const items = shownItems();
      const index = items.indexOf(event.target as HTMLElement);
      if (index < 0) return;
      if (key === "ArrowUp" && index === 0) {
        event.preventDefault();
        filter.focus();
        return;
      }
      const next = moveLineIndex(index, key, items.length);
      if (next === null) return;
      event.preventDefault();
      items[next]!.focus();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (picked === null) { if (opener.isConnected) opener.focus({ preventScroll: true }); return; }
      view.reveal({ path: picked });
      // The URL follows (pull-request-view.ts), so a reload lands here too.
      document.dispatchEvent(new CustomEvent("uatu:pull-request-anchor", { detail: { number: detail.summary.number, file: picked } }));
      void rendered.then(() => requestAnimationFrame(() => requestAnimationFrame(() =>
        filesElement.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(picked!)}"] [data-file-toggle]`)?.focus({ preventScroll: true }))));
    });
    dialog.addEventListener("click", event => {
      if (event.target === dialog) { dialog.close(); return; }
      const item = (event.target as HTMLElement).closest<HTMLElement>("[data-jump-path]");
      if (item) { picked = item.dataset.jumpPath!; dialog.close(); }
    });
    dialog.querySelector("[data-dialog-cancel]")!.addEventListener("click", () => dialog.close());
    trackDialogFooter(dialog);
    dialog.showModal();
    if (touchMode()) (dialog.querySelector<HTMLElement>('[aria-current="true"]') ?? dialog.querySelector<HTMLElement>("[data-jump-path]"))?.focus();
    else filter.focus();
  }

  // A file's header toggles its diff; Comment on a line opens its composer.
  function setFileOpen(section: HTMLElement, open: boolean) {
    section.classList.toggle("is-collapsed", !open);
    section.querySelector<HTMLElement>("[data-file-toggle]")?.setAttribute("aria-expanded", String(open));
    const body = section.querySelector<HTMLElement>(".pr-file-body");
    if (body) body.hidden = !open;
  }

  // A whole file's composer: on its first non-blank changed line
  // (firstCommentLine). From the file's Comment button focus goes to the
  // line picker, so the composer can be moved; from Add line comments, into
  // the text.
  function commentOnFile(path: string, opener: HTMLElement | null = null, focus: "text" | "line" = "line") {
    const first = firstCommentLine(handles.get(path)?.lines() ?? []);
    const section = filesElement.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(path)}"]`);
    if (section) setFileOpen(section, true);
    if (first) startComment({ path, side: toSide(first.side), line: first.lineNumber }, focus, opener);
  }
  for (const button of host.querySelectorAll<HTMLButtonElement>("[data-diff-style]")) {
    button.addEventListener("click", () => {
      const next = button.dataset.diffStyle as DiffStyle;
      if (next === diffStyle || button.disabled) return;
      diffStyle = next;
      renderSummary();
      rendered = renderFiles();
    });
  }

  function annotationsFor(file: PullRequestFile): DiffReviewAnnotation<AnnotationData>[] {
    version += 1;
    const annotations: DiffReviewAnnotation<AnnotationData>[] = [];
    for (const thread of detail.threads) {
      if (thread.path !== file.path || thread.line === null || thread.isOutdated) continue;
      annotations.push({ side: fromSide(thread.side), lineNumber: thread.line, metadata: { kind: "thread", threadId: thread.id, version } });
    }
    for (const comment of pendingComments()) {
      if (comment.path !== file.path || comment.threadId) continue;
      annotations.push({ side: fromSide(comment.side), lineNumber: comment.line, metadata: { kind: "pending", commentId: comment.id, version } });
    }
    for (const [key, position] of composers) {
      if (position.path === file.path) annotations.push({ side: fromSide(position.side), lineNumber: position.line, metadata: { kind: "composer", key, version } });
    }
    return annotations;
  }

  function renderAnnotation(file: PullRequestFile, annotation: DiffReviewAnnotation<AnnotationData>): HTMLElement {
    const data = annotation.metadata;
    if (data.kind === "thread") {
      const thread = detail.threads.find(candidate => candidate.id === data.threadId);
      return thread ? renderThread(thread) : document.createElement("div");
    }
    if (data.kind === "pending") {
      const comment = pendingComments().find(candidate => candidate.id === data.commentId);
      return comment ? renderPending(comment) : document.createElement("div");
    }
    return renderInlineComposer(file, data.key);
  }

  function commentHtml(author: string, createdAt: string, bodyHtml: string, pending = false): string {
    return `<div class="pr-thread-comment">
      ${avatar(author, "sm")}
      <div class="pr-thread-comment-main">
        <div class="pr-thread-comment-meta"><strong>${escapeHtml(author)}</strong> · ${escapeHtml(age(createdAt))}${pending ? ` <span class="gh-pill gh-pill-attention">Pending</span>` : ""}</div>
        <div class="markdown-body pr-thread-comment-body">${bodyHtml}</div>
      </div>
    </div>`;
  }

  // The viewer's pending reply in a thread: the comment with its Pending
  // badge, then Edit and Discard (or its open edit).
  function pendingReplyHtml(comment: PendingComment, where: string, blocked: string | null): string {
    const editing = openEdits.has(comment.id) && detail.summary.state === "OPEN";
    return `<div class="pr-pending-reply" data-pending-id="${escapeHtmlAttribute(comment.id)}" tabindex="-1" role="group" aria-label="Your pending reply on ${escapeHtmlAttribute(where)}">
      ${editing ? `<div class="pr-pending-edit" data-pending-edit-slot></div>` : `${commentHtml(detail.viewer, comment.createdAt, comment.bodyHtml, true)}
      <div class="pr-pending-reply-actions">
        <button type="button" class="gh-button gh-button-quiet" data-pending-edit aria-label="Edit pending reply on ${escapeHtmlAttribute(where)}"${detail.summary.state === "OPEN" ? "" : " disabled"}>Edit</button>
        <button type="button" class="gh-button gh-button-quiet" data-pending-discard aria-label="Discard pending reply on ${escapeHtmlAttribute(where)}"${blocked ? ` disabled title="${escapeHtmlAttribute(blocked)}"` : ""}>Discard</button>
      </div>`}
    </div>`;
  }

  function replyComposer(thread: ReviewThread): Composer {
    let reply = replyBoxes.get(thread.id);
    if (reply) return reply;
    reply = createComposer({
      placeholder: "Reply…",
      label: `Reply to the thread on ${thread.line === null ? thread.path : anchorLabel({ path: thread.path, line: thread.line, side: thread.side })}`,
      draftName: `your reply on ${thread.line === null ? thread.path : anchorLabel({ path: thread.path, line: thread.line, side: thread.side })}`,
      submitLabel: "Add reply to review",
      shortcutAction: "adds to review",
      note: `Goes into your pending review as @${detail.viewer}.`,
      draft: { target: draftTarget, location: { kind: "reply", threadId: thread.id } },
      sentAgainst: () => detail,
      blockedReason: blockedReason(),
      autofocus: true,
      rows: 2,
      onCancel: () => {
        closeReply(thread.id);
        focusLater(`[data-thread-id="${CSS.escape(thread.id)}"] [data-thread-reply-open]`);
      },
      send: async body => {
        const next = await githubApi.reply(target(), thread.id, body);
        return () => {
          pullRequestStore.applyDetail(next);
          closeReply(thread.id);
          focusLater(`[data-thread-id="${CSS.escape(thread.id)}"] [data-thread-reply-open]`);
        };
      },
    });
    replyBoxes.set(thread.id, reply);
    return reply;
  }

  function closeReply(threadId: string) {
    openReplies.delete(threadId);
    replyBoxes.delete(threadId);
    refreshAnnotations();
  }

  function renderThread(thread: ReviewThread): HTMLElement {
    const element = document.createElement("div");
    element.className = "pr-thread";
    element.dataset.threadId = thread.id;
    element.tabIndex = -1;
    element.setAttribute("role", "group");
    const where = `${thread.path} line ${thread.line}`;
    element.setAttribute("aria-label", `Review thread on ${where}`);
    // Shown as resolved (or not) the moment the button is pressed.
    const isResolved = resolving.get(thread.id) ?? thread.isResolved;
    const replies = pendingComments().filter(comment => comment.threadId === thread.id);
    const total = thread.comments.length;
    const blocked = blockedReason();
    // Resolving isn't part of the pending review: GitHub applies it at once,
    // which the tooltip and the accessible name say.
    const resolveNow = "Applies on GitHub now, not with your review";
    const resolveAttributes = blocked ? ` disabled title="${escapeHtmlAttribute(blocked)}"` : ` title="${resolveNow}"`;
    const header = `<div class="pr-thread-header">
        <span>Line ${thread.line} · ${plural(total, "comment", "comments")}${replies.length ? ` · ${replies.length} pending` : ""}</span>
        ${isResolved ? `<span class="gh-pill">Resolved</span>` : `<span class="gh-pill gh-pill-attention">Unresolved</span>`}
      </div>`;
    // A resolved thread folds away, unless it holds something of the
    // viewer's not yet sent: a pending reply, or an open reply box.
    if (isResolved && !expandedResolved.has(thread.id) && replies.length === 0 && !openReplies.has(thread.id)) {
      element.classList.add("is-resolved");
      const undo = justResolved.has(thread.id) && !blocked;
      element.innerHTML = `${header}<div class="pr-thread-footer">
        <span class="pr-muted"${undo ? ` data-thread-outcome` : ""}>${undo ? "Resolved on GitHub just now." : "Conversation resolved."}</span>
        <span class="pr-thread-actions"><button type="button" class="gh-button gh-button-quiet" data-thread-show aria-label="Show resolved conversation on ${escapeHtmlAttribute(where)}">Show</button>
        ${blocked || undo ? "" : APPLIES_NOW}<button type="button" class="gh-button" data-thread-resolve="false" aria-label="${undo ? "Undo: unresolve" : "Unresolve"} conversation on ${escapeHtmlAttribute(where)} (applies now)"${resolveAttributes}>${undo ? "Undo" : "Unresolve"}</button></span></div>`;
    } else {
      element.innerHTML = `${header}
        ${thread.comments.map(comment => commentHtml(comment.author, comment.createdAt, comment.bodyHtml)).join("")}
        ${replies.map(comment => pendingReplyHtml(comment, where, blocked)).join("")}
        <div class="pr-thread-footer">
          <div class="pr-thread-reply" data-thread-reply></div>
          <span class="pr-thread-actions">
            ${isResolved && replies.length === 0 && !openReplies.has(thread.id) ? `<button type="button" class="gh-button gh-button-quiet" data-thread-hide aria-label="Hide resolved conversation on ${escapeHtmlAttribute(where)}">Hide</button>` : ""}
            ${blocked ? "" : APPLIES_NOW}<button type="button" class="gh-button" data-thread-resolve="${isResolved ? "false" : "true"}" aria-label="${isResolved ? "Unresolve" : "Resolve"} conversation on ${escapeHtmlAttribute(where)} (applies now)"${resolveAttributes}>${isResolved ? "Unresolve" : "Resolve conversation"}</button>
          </span>
        </div>`;
      const replySlot = element.querySelector<HTMLElement>("[data-thread-reply]")!;
      if (openReplies.has(thread.id) && detail.summary.state === "OPEN") {
        const reply = replyComposer(thread);
        reply.setBlocked(blocked);
        replySlot.append(reply.element);
        element.querySelector(".pr-thread-footer")!.classList.add("is-replying");
      } else {
        replySlot.innerHTML = `<button type="button" class="pr-thread-reply-placeholder" data-thread-reply-open aria-label="Reply to the thread on ${escapeHtmlAttribute(where)}…"${detail.summary.state === "OPEN" ? "" : " disabled"}>Reply…</button>`;
        replySlot.querySelector("[data-thread-reply-open]")!.addEventListener("click", () => {
          openReplies.add(thread.id);
          refreshAnnotations();
        });
      }
    }
    // A pending reply is edited or discarded in place, as a pending line
    // comment is.
    for (const reply of replies) {
      const slot = element.querySelector<HTMLElement>(`[data-pending-id="${CSS.escape(reply.id)}"]`);
      if (!slot) continue;
      if (openEdits.has(reply.id) && detail.summary.state === "OPEN") {
        const box = editComposer(reply);
        box.setBlocked(blocked);
        slot.querySelector<HTMLElement>("[data-pending-edit-slot]")?.append(box.element);
      }
      slot.querySelector("[data-pending-edit]")?.addEventListener("click", () => {
        openEdits.add(reply.id);
        refreshAnnotations();
      });
      slot.querySelector("[data-pending-discard]")?.addEventListener("click", async () => {
        if (!(await confirmDiscardPendingComment(`your reply on ${where}`, detail.summary.number))) return;
        await write(() => githubApi.deletePendingComment(target(), reply.id)).then(
          () => focusLater(`[data-thread-id="${CSS.escape(thread.id)}"] [data-thread-reply-open]`),
          error => alertError(error));
      });
    }
    element.querySelector("[data-thread-show]")?.addEventListener("click", () => {
      expandedResolved.add(thread.id);
      refreshAnnotations();
      focusLater(`[data-thread-id="${CSS.escape(thread.id)}"] [data-thread-hide]`);
    });
    element.querySelector("[data-thread-hide]")?.addEventListener("click", () => {
      expandedResolved.delete(thread.id);
      refreshAnnotations();
      focusLater(`[data-thread-id="${CSS.escape(thread.id)}"] [data-thread-show]`);
    });
    element.querySelector<HTMLButtonElement>("[data-thread-resolve]")?.addEventListener("click", event => {
      const resolved = (event.currentTarget as HTMLButtonElement).dataset.threadResolve === "true";
      if (resolved) {
        expandedResolved.delete(thread.id);
        // An empty reply box goes with it; reply text keeps the thread open.
        if (openReplies.has(thread.id) && (replyBoxes.get(thread.id)?.value() ?? "").trim() === "") {
          openReplies.delete(thread.id);
          replyBoxes.delete(thread.id);
          prDrafts.clear(draftTarget, { kind: "reply", threadId: thread.id });
        }
      }
      const focusResolve = () => focusLater(`[data-thread-id="${CSS.escape(thread.id)}"] [data-thread-resolve]`);
      forgetJustResolved(thread.id);
      if (resolved) {
        justResolved.set(thread.id, setTimeout(() => {
          justResolved.delete(thread.id);
          if (!host.isConnected) return;
          const focused = document.activeElement?.closest?.(`[data-thread-id="${CSS.escape(thread.id)}"] [data-thread-resolve]`);
          refreshAnnotations();
          if (focused) focusResolve();
        }, UNDO_RESOLVE_MS));
      }
      resolving.set(thread.id, resolved);
      refreshAnnotations();
      focusResolve();
      void write(() => githubApi.resolve(target(), thread.id, resolved))
        .then(() => { resolving.delete(thread.id); }, error => {
          resolving.delete(thread.id);
          forgetJustResolved(thread.id);
          refreshAnnotations();
          focusResolve();
          alertError(error);
        });
    });
    return element;
  }

  function renderPending(comment: PendingComment): HTMLElement {
    const element = document.createElement("div");
    element.className = "pr-thread is-pending";
    element.dataset.pendingId = comment.id;
    element.tabIndex = -1;
    element.setAttribute("role", "group");
    const where = anchorLabel(comment);
    element.setAttribute("aria-label", `Your pending comment on ${where}`);
    const blocked = blockedReason();
    const editing = openEdits.has(comment.id) && detail.summary.state === "OPEN";
    element.innerHTML = `<div class="pr-thread-header"><span>Line ${comment.line} (${comment.side === "LEFT" ? "old" : "new"}) · your pending comment</span><span class="gh-pill gh-pill-attention">Pending</span></div>
      ${editing ? `<div class="pr-pending-edit" data-pending-edit-slot></div>` : commentHtml(detail.viewer, comment.createdAt, comment.bodyHtml, false)}
      ${editing ? "" : `<div class="pr-thread-footer"><span class="pr-muted">Visible only to you until you finish your review.</span>
        <span class="pr-thread-actions">
          <button type="button" class="gh-button gh-button-quiet" data-pending-edit aria-label="Edit pending comment on ${escapeHtmlAttribute(where)}"${detail.summary.state === "OPEN" ? "" : " disabled"}>Edit</button>
          <button type="button" class="gh-button gh-button-quiet" data-pending-discard aria-label="Discard pending comment on ${escapeHtmlAttribute(where)}"${blocked ? ` disabled title="${escapeHtmlAttribute(blocked)}"` : ""}>Discard</button>
        </span></div>`}`;
    if (editing) {
      const box = editComposer(comment);
      box.setBlocked(blocked);
      element.querySelector<HTMLElement>("[data-pending-edit-slot]")!.append(box.element);
    }
    element.querySelector("[data-pending-edit]")?.addEventListener("click", () => {
      openEdits.add(comment.id);
      refreshAnnotations();
    });
    element.querySelector("[data-pending-discard]")?.addEventListener("click", async () => {
      if (!(await confirmDiscardPendingComment(where, detail.summary.number))) return;
      await write(() => githubApi.deletePendingComment(target(), comment.id)).then(() => {
        if (!handles.get(comment.path)?.focusLine({ side: fromSide(comment.side), lineNumber: comment.line })) focusBar();
      }, error => alertError(error));
    });
    return element;
  }

  // Edits one of the viewer's pending comments in place; the text is a
  // draft like any other, and Cancel or Escape with changes asks first.
  function editComposer(comment: PendingComment): Composer {
    let box = editBoxes.get(comment.id);
    if (box) return box;
    const location = { kind: "edit" as const, commentId: comment.id };
    const close = () => {
      openEdits.delete(comment.id);
      editBoxes.delete(comment.id);
      refreshAnnotations();
      focusLater(`[data-pending-id="${CSS.escape(comment.id)}"] [data-pending-edit]`);
    };
    box = createComposer({
      placeholder: "Edit your pending comment…",
      label: `Edit your pending comment on ${anchorLabel(comment)}`,
      draftName: `your edit of the comment on ${anchorLabel(comment)}`,
      submitLabel: "Save",
      shortcutAction: "saves",
      note: "Still pending: nobody sees it until you finish your review.",
      draft: { target: draftTarget, location },
      sentAgainst: () => detail,
      initialText: comment.body,
      blockedReason: blockedReason(),
      autofocus: true,
      rows: 3,
      onCancel: close,
      send: async body => {
        const next = await githubApi.editPendingComment(target(), comment.id, body);
        return () => {
          openEdits.delete(comment.id);
          editBoxes.delete(comment.id);
          pullRequestStore.applyDetail(next);
          focusLater(`[data-pending-id="${CSS.escape(comment.id)}"] [data-pending-edit]`);
        };
      },
    });
    editBoxes.set(comment.id, box);
    return box;
  }

  // "New comment on line [picker]": the picker lists the file's diff lines,
  // so a comment can be placed (or moved) without aiming at a line number.
  function lineHeading(file: PullRequestFile, position: ComposerTarget): HTMLElement {
    const heading = document.createElement("label");
    heading.className = "pr-composer-line";
    heading.append("New comment on ");
    const select = document.createElement("select");
    select.dataset.composerLine = "";
    select.setAttribute("aria-label", "Line to comment on");
    const lines = handles.get(file.path)?.lines() ?? [];
    const seen = new Set<string>();
    for (const line of lines) {
      const value = `${toSide(line.side)}:${line.lineNumber}`;
      if (seen.has(value)) continue;
      seen.add(value);
      const option = document.createElement("option");
      option.value = value;
      option.textContent = lineOptionText(line, line.text);
      select.append(option);
    }
    const current = `${position.side}:${position.line}`;
    if (!seen.has(current)) {
      const option = document.createElement("option");
      option.value = current;
      option.textContent = lineOptionText({ side: fromSide(position.side), lineNumber: position.line }, "");
      select.prepend(option);
    }
    select.value = current;
    select.addEventListener("change", () => {
      const [side, line] = select.value.split(":");
      const next: ComposerTarget = { path: file.path, side: side as DiffSide, line: Number(line) };
      const key = composerKey(position);
      const nextKey = composerKey(next);
      // That line already has a composer: go there, this one stays put.
      if (composers.has(nextKey)) {
        select.value = `${position.side}:${position.line}`;
        composerBoxes.get(nextKey)?.box.focus();
        return;
      }
      // The text moves with the composer.
      const text = composerBoxes.get(key)?.box.value() ?? "";
      prDrafts.clear(draftTarget, { kind: "inline", ...position });
      prDrafts.set(draftTarget, { kind: "inline", ...next }, text);
      composers.delete(key);
      composerBoxes.delete(key);
      composers.set(nextKey, next);
      composerFocus = { key: nextKey, kind: "line" };
      refreshAnnotations();
    });
    heading.append(select);
    return heading;
  }

  function closeComposer(key: string) {
    composers.delete(key);
    composerBoxes.delete(key);
    composerOpeners.delete(key);
    refreshAnnotations();
  }

  function renderInlineComposer(file: PullRequestFile, key: string): HTMLElement {
    const position = composers.get(key)!;
    const kept = composerBoxes.get(key);
    if (kept) {
      kept.box.setBlocked(blockedReason());
      kept.box.refresh();
      return kept.wrapper;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "pr-inline-composer";
    const focus = composerFocus?.key === key ? composerFocus.kind : null;
    if (focus) composerFocus = null;
    const box = createComposer({
      heading: lineHeading(file, position),
      shortcutAction: "adds to review",
      placeholder: inlineComposerPrompt(position, detail.viewer),
      draftName: `your comment on ${anchorLabel({ path: file.path, line: position.line, side: position.side })}`,
      submitLabel: "Add to review",
      // Read live: a review submitted or a comment added elsewhere changes it.
      note: () => {
        const count = pendingComments().length;
        return count === 0 ? "Starts your review. Nothing is published until you finish it." : `Your review has ${plural(count, "pending comment", "pending comments")}.`;
      },
      draft: { target: draftTarget, location: { kind: "inline", ...position } },
      sentAgainst: () => detail,
      blockedReason: blockedReason(),
      autofocus: focus === "text",
      onCancel: () => {
        const opener = composerOpeners.get(key);
        closeComposer(key);
        if (opener?.isConnected && opener.checkVisibility()) opener.focus({ preventScroll: true });
        else handles.get(position.path)?.focusLine({ side: fromSide(position.side), lineNumber: position.line });
      },
      // The draft goes the moment GitHub has the comment (sendThenClearDraft),
      // before the page updates: a reload can't bring it back as unsent.
      send: async body => {
        const next = await githubApi.createThread(target(), { headOid: detail.summary.headRefOid, path: file.path, line: position.line, side: position.side, body });
        return () => {
          composers.delete(key);
          composerBoxes.delete(key);
          pullRequestStore.applyDetail(next);
          // Focus the comment just added (the newest pending one on that line).
          const added = next.pendingReview?.comments.filter(comment => comment.path === file.path && comment.line === position.line && comment.side === position.side && !comment.threadId).at(-1);
          if (added) focusLater(`[data-pending-id="${CSS.escape(added.id)}"]`);
        };
      },
    });
    wrapper.append(box.element);
    composerBoxes.set(key, { wrapper, box });
    if (focus === "line") queueMicrotask(() => wrapper.querySelector<HTMLSelectElement>("[data-composer-line]")?.focus());
    return wrapper;
  }

  // Opens a composer on a line. Composers holding text elsewhere stay open
  // as drafts (Finish review lists them); empty ones give way.
  function startComment(next: ComposerTarget, focus: "text" | "line" = "text", opener: HTMLElement | null = null) {
    if (detail.summary.state !== "OPEN") return;
    const key = composerKey(next);
    // Cancel gives focus back to what opened it: Comment on a line, else
    // the line's number (a click or tap on the number or its row).
    composerOpeners.set(key, opener);
    if (composers.has(key)) {
      const kept = composerBoxes.get(key);
      if (focus === "line") kept?.wrapper.querySelector<HTMLElement>("[data-composer-line]")?.focus();
      else kept?.box.focus();
      return;
    }
    for (const [other, position] of composers) {
      const location = { kind: "inline" as const, ...position };
      if ((composerBoxes.get(other)?.box.value() ?? prDrafts.text(draftTarget, location)).trim() !== "") continue;
      composers.delete(other);
      composerBoxes.delete(other);
      prDrafts.clear(draftTarget, location);
    }
    composers.set(key, next);
    composerFocus = { key, kind: focus };
    refreshAnnotations();
    renderHint();
    keepComposerInView(key);
  }

  // A rotation or a resized window keeps the composer being written in view
  // and its actions above the touch tab bar.
  let resizeFrame = 0;
  const onResize = () => {
    if (!host.isConnected) { window.removeEventListener("resize", onResize); return; }
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      for (const [key, { wrapper }] of composerBoxes) if (wrapper.contains(document.activeElement)) keepComposerInView(key, 20);
    });
  };
  window.addEventListener("resize", onResize);

  // The line being commented on stays visible above the composer (about two
  // lines of room under the pinned header and review bar), and the
  // composer's actions stay clear of the touch tab bar; when both can't fit,
  // the line wins.
  function keepComposerInView(key: string, frames = 10) {
    requestAnimationFrame(() => {
      const wrapper = composerBoxes.get(key)?.wrapper;
      if (!wrapper?.isConnected) {
        if (frames > 0) keepComposerInView(key, frames - 1);
        return;
      }
      const root = previewScrollRoot();
      const viewport = root === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : root.getBoundingClientRect();
      const lineRoom = 48;
      const top = viewport.top + pinnedHeight(true) + lineRoom;
      const bottom = Math.min(viewport.bottom, window.innerHeight) - tabBarBottomInset() - 8;
      const rect = wrapper.getBoundingClientRect();
      let delta = rect.bottom > bottom ? rect.bottom - bottom : 0;
      if (rect.top - delta < top) delta = rect.top - top;
      if (Math.abs(delta) >= 1) root.scrollTop += delta;
    });
  }

  // Annotations are rebuilt on every refresh; give focus back to the same
  // control (by selector) once the new ones are in place.
  function focusLater(selector: string, frames = 10) {
    requestAnimationFrame(() => {
      const element = host.querySelector<HTMLElement>(selector);
      if (element) element.focus();
      else if (frames > 0) focusLater(selector, frames - 1);
    });
  }

  // Annotations (and Pierre's line numbers) are rebuilt on every refresh,
  // which a background re-read of the pull request can trigger at any time:
  // whatever had focus gets it back afterwards.
  function captureFocus(): () => void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !host.contains(active)) return () => undefined;
    let restore: () => boolean;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) {
      // A kept composer: the same element moves into the new annotation.
      const selection = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] as const : null;
      restore = () => {
        if (!active.isConnected) return false;
        active.focus({ preventScroll: true });
        if (selection && active instanceof HTMLTextAreaElement) active.setSelectionRange(selection[0], selection[1]);
        return true;
      };
    } else if (active.tagName === "DIFFS-CONTAINER") {
      const path = active.closest<HTMLElement>("[data-file-path]")?.dataset.filePath ?? "";
      const line = handles.get(path)?.focusedLine() ?? null;
      restore = () => line !== null && Boolean(handles.get(path)?.focusLine(line));
    } else {
      // A thread or pending card, or a button in one, found again by its keys.
      const card = active.closest<HTMLElement>("[data-thread-id], [data-pending-id]");
      if (!card) return () => undefined;
      const cardSelector = card.dataset.threadId ? `[data-thread-id="${CSS.escape(card.dataset.threadId)}"]` : `[data-pending-id="${CSS.escape(card.dataset.pendingId!)}"]`;
      const control = active === card ? null : Object.keys(active.dataset)[0];
      const selector = control ? `${cardSelector} [data-${control.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}]` : cardSelector;
      restore = () => {
        const element = host.querySelector<HTMLElement>(selector);
        element?.focus({ preventScroll: true });
        return Boolean(element);
      };
    }
    return () => {
      if (document.activeElement === active && active.isConnected) return;
      if (!restore()) requestAnimationFrame(() => { if (!host.contains(document.activeElement)) restore(); });
    };
  }

  function refreshAnnotations() {
    const restoreFocus = captureFocus();
    for (const file of detail.files) {
      const handle = handles.get(file.path);
      handle?.setAnnotations(annotationsFor(file));
      if (![...composers.values()].some(position => position.path === file.path)) handle?.clearSelection();
    }
    restoreFocus();
  }

  async function renderFiles() {
    handles.clear();
    composerBoxes.clear();
    replyBoxes.clear();
    editBoxes.clear();
    filesElement.innerHTML = "";
    const marks = reviewMarksByPath(detail);
    const style = effectiveStyle();
    for (const [index, file] of orderedFiles().entries()) {
      const section = document.createElement("section");
      section.className = "pr-file";
      section.dataset.filePath = file.path;
      const bodyId = `pr-file-body-${detail.summary.number}-${index}`;
      // The header is one row: the toggle (path, counts, marks), then the
      // icon buttons. The path keeps its end (the file name) when it must be
      // shortened.
      section.innerHTML = `<div class="pr-file-header" data-file-header="${escapeHtmlAttribute(file.path)}">
          <button type="button" class="pr-file-toggle" data-file-toggle aria-expanded="true" aria-controls="${bodyId}">
            <span class="pr-file-chevron" aria-hidden="true"></span>
            <span class="pr-file-path" dir="rtl"><bdi dir="ltr">${escapeHtml(file.path)}</bdi></span>
            ${file.status === "added" ? `<span class="gh-pill">New</span>` : ""}
            <span class="pr-file-counts"><span class="gh-del">−${file.deletions}</span><span class="gh-add">+${file.additions}</span></span>
            <span class="pr-file-badges" data-file-badges>${reviewMarkBadges(marks.get(file.path))}</span>
          </button>
          <span class="pr-file-actions">
            ${detail.summary.state === "OPEN" ? `<button type="button" class="pr-file-action" data-file-comment aria-label="Comment on a line in ${escapeHtmlAttribute(file.path)}" title="Comment on a line…">${COMMENT_PLUS_ICON}<span class="pr-file-action-label" aria-hidden="true">Comment</span></button>` : ""}
          </span>
        </div>
        <div class="pr-file-body" id="${bodyId}"><div class="uatu-diff-host pr-file-diff"></div></div>`;
      filesElement.append(section);
      section.querySelector("[data-file-toggle]")!.addEventListener("click", () => setFileOpen(section, section.classList.contains("is-collapsed")));
      section.querySelector("[data-file-comment]")?.addEventListener("click", event => commentOnFile(file.path, event.currentTarget as HTMLElement));
      if (index === 0) syncBarHeight();
      const diffHost = section.querySelector<HTMLElement>(".pr-file-diff")!;
      const handle = await renderReviewDiff<AnnotationData>(diffHost, {
        path: file.path,
        oldContents: file.oldContents,
        newContents: file.newContents,
        languageHint: languageFor(file.path),
      }, {
        diffStyle: style,
        // Touch screens are too narrow for side-scrolling code beside a
        // comment box: always wrap there.
        wrap: appState.wrap || touchMode(),
        review: {
          annotations: annotationsFor(file),
          renderAnnotation: annotation => renderAnnotation(file, annotation),
          onStartComment: position => void startComment({ path: file.path, side: toSide(position.side), line: position.lineNumber }),
          rowTap: touchMode,
        },
      });
      if (handle) handles.set(file.path, handle);
    }
  }

  // Scrolls the preview (vertically only: scrollIntoView would also scroll a
  // Split column sideways) so `element` sits near the middle.
  function scrollToElement(element: HTMLElement, block: "start" | "center") {
    const root = previewScrollRoot();
    const rootTop = root === document.scrollingElement ? 0 : root.getBoundingClientRect().top;
    const rect = element.getBoundingClientRect();
    // Never under the pinned header and review bar (pinned only while a
    // review is active), even for a card taller than half the screen.
    const pinned = pinnedHeight(!element.classList.contains("pr-file")) + 12;
    const offset = block === "center" ? Math.max(pinned, (Math.min(window.innerHeight, root.clientHeight) - rect.height) / 2) : pinned;
    root.scrollTop += rect.top - rootTop - offset;
  }

  // Text Finish review added to the review ("Add it to the review") is no
  // longer a draft: its saved copy is gone and GitHub holds it, so its
  // composer closes.
  function dropTakenComposers() {
    for (const [key, position] of composers) {
      const location = { kind: "inline" as const, ...position };
      const text = composerBoxes.get(key)?.box.value() ?? "";
      if (text.trim() !== "" && prDrafts.text(draftTarget, location) === "" && matchingComments(location, text, detail).length > 0) {
        composers.delete(key);
        composerBoxes.delete(key);
      }
    }
    for (const threadId of [...openReplies]) {
      const location = { kind: "reply" as const, threadId };
      const text = replyBoxes.get(threadId)?.value() ?? "";
      if (text.trim() !== "" && prDrafts.text(draftTarget, location) === "" && matchingComments(location, text, detail).length > 0) {
        openReplies.delete(threadId);
        replyBoxes.delete(threadId);
      }
    }
  }

  const view: FilesChangedView = {
    update(next) {
      detail = next;
      dropTakenComposers();
      renderBar();
      renderSummary();
      refreshAnnotations();
    },
    syncAvailability() {
      renderBar();
      refreshAnnotations();
    },
    reveal({ path, threadId, pendingId }) {
      const threadPath = threadId ? detail.threads.find(thread => thread.id === threadId)?.path : undefined;
      const pendingPath = pendingId ? pendingComments().find(comment => comment.id === pendingId)?.path : undefined;
      const filePath = path ?? threadPath ?? pendingPath ?? "";
      // Files append one by one as they render: look the section up again
      // once they all have.
      const findSection = () => filesElement.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(filePath)}"]`);
      const pending = findSection();
      if (pending) setFileOpen(pending, true);
      void rendered.then(() => requestAnimationFrame(() => {
        const section = findSection();
        if (section) setFileOpen(section, true);
        const card = threadId ? host.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`)
          : pendingId ? host.querySelector<HTMLElement>(`[data-pending-id="${CSS.escape(pendingId)}"]`) : null;
        const targetElement = card ?? section;
        if (!targetElement) return;
        scrollToElement(targetElement, card ? "center" : "start");
        handles.get(filePath)?.resetHorizontalScroll();
        if (card) {
          card.focus({ preventScroll: true });
          card.classList.add("is-flash");
          setTimeout(() => card.classList.remove("is-flash"), 1600);
        }
      }));
    },
    openJump: opener => openJumpDialog(opener),
    addLineComments() {
      void rendered.then(() => requestAnimationFrame(() => {
        const first = orderedFiles()[0];
        const section = first ? filesElement.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(first.path)}"]`) : null;
        if (!first || !section) return;
        setFileOpen(section, true);
        // Files changed from its top when the first file's opening lines
        // still show below the bar and summary; otherwise the first file
        // goes to the top. Then the composer opens there (keepComposerInView
        // settles its position).
        const root = previewScrollRoot();
        const page = root === document.scrollingElement;
        const rootTop = page ? 0 : root.getBoundingClientRect().top;
        const viewportBottom = Math.min(window.innerHeight, page ? window.innerHeight : root.getBoundingClientRect().bottom) - tabBarBottomInset();
        const pinnedTop = rootTop + (parseFloat(getComputedStyle(host).getPropertyValue("--pr-sticky-top")) || 0);
        const hostTop = host.getBoundingClientRect().top;
        const sectionTop = section.getBoundingClientRect().top;
        const room = 160;
        if (hostTop >= pinnedTop - 1 && sectionTop + room <= viewportBottom) {
          // Already in view from its top.
        } else if (pinnedTop + (sectionTop - hostTop) + room <= viewportBottom) {
          root.scrollTop += hostTop - pinnedTop;
        } else {
          scrollToElement(section, "start");
        }
        if (detail.summary.state === "OPEN" && (handles.get(first.path)?.lines().length ?? 0) > 0) commentOnFile(first.path, null, "text");
        else section.querySelector<HTMLElement>("[data-file-toggle]")?.focus({ preventScroll: true });
      }));
    },
  };

  // Touch and desktop render the files differently (touch always wraps), and
  // the review bar's place follows the mode: a switch re-renders what
  // changed, without a reload.
  let wasTouch = touchMode();
  const stopUiMode = onUiModeChange(() => {
    if (!host.isConnected) { stopUiMode(); return; }
    renderBar();
    renderSummary();
    if (touchMode() === wasTouch) return;
    wasTouch = touchMode();
    rendered = renderFiles();
  });

  renderBar();
  renderSummary();
  rendered = renderFiles();
  return view;
}

// The review bar, on Files changed and (while a review is pending) on
// Conversation, or on touch in the preview header's tabs row
// (reviewBarShownOn). One review button everywhere: Review, which opens the
// review dialog (verdict, summary, the pending comments, and Add line
// comments), or Finish review (n) while comments are pending; the desktop
// bars add the pending count and Discard review (on touch Discard is in the
// dialog). One paused-write rule for every review write: while GitHub can't
// take writes (rate limit, outage, no credential), Discard and Finish are
// disabled, and the reason is shown in the bar and named by both buttons.
export function renderReviewBar(bar: HTMLElement, detail: PullRequestDetail, repositoryId: string, options: {
  surface: ReviewBarSurface;
  // The pull request view's tab (the header surface follows it).
  tab?: "files" | "conversation";
  // Where focus goes once Finish review has published the review and the
  // bar's Finish is gone (Files changed: the bar, or the file being read).
  fallbackFocus?: () => HTMLElement | null;
}): void {
  const count = detail.pendingReview?.comments.length ?? 0;
  const pr = detail.summary;
  const open = pr.state === "OPEN";
  const header = options.surface === "header";
  const base = header ? "pr-header-review" : "pr-review-bar";
  // (The bar itself, focused after a review was published, keeps focus as is.)
  const focused = bar.contains(document.activeElement) && document.activeElement !== bar ? (document.activeElement as HTMLElement).dataset : null;
  const touch = touchMode();
  if (!reviewBarShownOn(options.surface, { touch, pending: detail.pendingReview ? count : 0, open })) {
    bar.hidden = true;
    bar.className = base;
    bar.innerHTML = "";
    // Moved away under focus (touch: to the tabs row and back).
    if (focused) options.fallbackFocus?.()?.focus({ preventScroll: true });
    return;
  }
  const paused = githubWritesPausedReason(pullRequestStore.state.summary);
  const reasonId = `pr-review-bar-reason-${options.surface}`;
  const reason = paused ? `<span class="pr-review-bar-reason" id="${reasonId}">${escapeHtml(paused)} Your comments stay pending.</span>` : "";
  const pausedAttributes = paused ? ` disabled aria-describedby="${reasonId}" title="${escapeHtmlAttribute(paused)}"` : "";
  bar.hidden = false;
  if (detail.pendingReview && count > 0) {
    const comments = plural(count, "pending comment", "pending comments");
    bar.className = `${base} is-active${paused ? " is-paused" : ""}`;
    // In the tabs row it is one short button: the count and Finish (named in
    // full). The desktop bars say what is pending and hold Discard review.
    bar.innerHTML = header
      ? `<button type="button" class="gh-button gh-button-primary" data-review-finish aria-label="${reviewActionLabel(count)}" title="${escapeHtmlAttribute(paused ?? `${reviewActionLabel(count)}: publish your pending comments as a comment, approval or change request`)}"${paused ? ` disabled aria-describedby="${reasonId}"` : ""}><span class="pr-header-review-count" aria-hidden="true">✎ ${count}</span> Finish</button>${reason}`
      : `<span class="gh-pill gh-pill-solid-attention">Review in progress</span>
      <span class="pr-review-bar-text"><strong>${comments}</strong> on #${pr.number} · visible only to you until submitted</span>
      <span class="pr-review-bar-actions">
        <button type="button" class="gh-button" data-review-discard aria-label="Discard your pending review (${plural(count, "comment", "comments")})"${pausedAttributes}>Discard review</button>
      </span>
      ${reason}`;
  } else {
    bar.className = base;
    // Desktop's how-to is in the bar; touch's is a one-line hint in the files
    // toolbar (mountFilesChanged). The tabs-row copy is the one button.
    bar.innerHTML = !open ? `<span class="pr-review-bar-text">This pull request is ${pr.state.toLowerCase()}; reviewing is closed.</span>`
      : header ? `<span class="pr-review-bar-actions"><button type="button" class="gh-button" data-review-open title="Approve, comment or request changes, with a summary and any line comments">${reviewActionLabel(0)}</button></span>`
      : `<span class="pr-review-bar-text">${REVIEW_KEYS_HINT} Comments stay pending until you finish your review.</span>`;
  }
  const target = { repository: repositoryId, number: pr.number };
  // Never scrolling: the bar may be pinned (the tabs row on touch), and a
  // plain focus() scrolls to where it would sit unpinned.
  const focusFinish = () => (bar.querySelector<HTMLElement>("[data-review-finish]:not(:disabled)") ?? bar.querySelector<HTMLElement>("[data-review-open]"))?.focus({ preventScroll: true });
  bar.querySelector("[data-review-discard]")?.addEventListener("click", async () => {
    if (!(await confirmDiscardReview(count, pr.number))) return;
    await githubApi.discardReview(target).then(next => {
      pullRequestStore.applyDetail(next);
      // The bar may have moved (touch: the header copy goes with the review).
      if (bar.contains(document.activeElement)) return;
      if (!bar.hidden) focusFinish();
      if (!bar.contains(document.activeElement)) options.fallbackFocus?.()?.focus({ preventScroll: true });
    }, error => alertError(error));
  });
  // After the dialog: the bar's review button (Review, or Finish while
  // comments stay pending), else the fallback.
  const afterReview = () => bar.querySelector<HTMLElement>("[data-review-finish], [data-review-open]") ?? options.fallbackFocus?.() ?? null;
  for (const button of bar.querySelectorAll("[data-review-finish], [data-review-open]")) {
    button.addEventListener("click", () => openSubmitReviewDialog({ repositoryId, number: pr.number }, { fallbackFocus: afterReview }));
  }
  // A re-render keeps the bar's focused button focused.
  if (focused) {
    const key = "reviewDiscard" in focused ? "[data-review-discard]" : "[data-review-finish], [data-review-open]";
    const next = bar.querySelector<HTMLButtonElement>(key);
    if (next && !next.disabled) next.focus({ preventScroll: true });
    else focusFinish();
  }
}

// Writes from buttons outside a composer have no inline error line; a
// short-lived toast keeps the refusal visible without a modal.
export function alertError(error: unknown) {
  showToast(error instanceof Error ? error.message : "The request failed.", "alert");
}
