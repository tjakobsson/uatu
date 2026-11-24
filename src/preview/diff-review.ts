// Files changed: the pull request's diffs against its base, with inline
// review on top of `@pierre/diffs` line annotations (design D10). Threads,
// the viewer's pending comments and the open composers are annotations;
// the gutter "+", a click or tap on a line number, or Enter on a focused
// line number (src/preview/diff-review-lines.ts) opens a composer, and
// "Add to review" is its only action, so every inline comment lands in the
// pending review. Several lines may hold unsent drafts at once: opening
// another line keeps a composer with text open and closes an empty one. On
// touch, each file also offers a full-size "Comment on a line" button, and
// the composer's line picker moves it. A bar above the files, pinned while
// the files scroll, counts pending comments and offers Discard review /
// Finish review (n); without any, Start review moves focus to the first
// file's line numbers. On a phone the bar is one row: a count badge, Discard
// and Finish (n). A resolved thread folds away unless it holds the viewer's
// pending reply or an open reply box.
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
import { previewScrollRoot } from "../shell/preview-scroll-root";
import { tabBarBottomInset } from "../shell/tab-bar";
import type { DiffStyle } from "../shared/types";
import { createComposer, type Composer } from "./pr-composer";
import { draftAlreadySent, prDrafts } from "./pr-drafts";
import { confirmDiscardPendingComment, confirmDiscardReview, openSubmitReviewDialog, reviewActionLabel, showToast } from "./review-dialogs";
import { anchorLabel } from "./diff-review-lines";
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
  // Start review: focus where a review comment begins (the first file's line
  // numbers; on touch, its "Comment on a line…").
  focusFirstLine: () => void;
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

export function mountFilesChanged(host: HTMLElement, initial: PullRequestDetail, repositoryId: string): FilesChangedView {
  let detail = initial;
  let version = 0;
  const draftTarget = { repositoryId, number: initial.summary.number };
  // The open inline composers, by line (composerKey), kept across
  // annotation re-renders. Several may hold drafts at once; an empty one
  // gives way when another line is opened.
  const composers = new Map<string, ComposerTarget>();
  const composerBoxes = new Map<string, { wrapper: HTMLElement; box: Composer }>();
  // Focus a composer's textarea (or its line picker) when it next renders.
  let composerFocus: { key: string; kind: "text" | "line" } | null = null;
  // Threads whose reply box is open, and their composers.
  const openReplies = new Set<string>();
  const replyBoxes = new Map<string, Composer>();
  // Pending comments being edited in place, and their composers.
  const openEdits = new Set<string>();
  const editBoxes = new Map<string, Composer>();
  const expandedResolved = new Set<string>();
  const handles = new Map<string, DiffReviewHandle<AnnotationData>>();
  const target = () => ({ repository: repositoryId, number: detail.summary.number });
  let diffStyle: DiffStyle = appState.diffStyle;
  let narrow = false;
  let rendered: Promise<void> = Promise.resolve();
  const blockedReason = () => sendBlockedReason(pullRequestStore.state.summary, detail.summary);

  // Drafts left by an earlier page: reopen them where they were, except
  // those GitHub already holds (the page went away after sending them).
  const unsent = (kind: "inline" | "reply" | "edit") => prDrafts.list(draftTarget, kind).filter(entry => {
    if (!draftAlreadySent(entry.location, entry.draft.text, initial)) return true;
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
      <details class="pr-file-index">
        <summary class="pr-files-summary" data-pr-files-summary></summary>
        <nav aria-label="Changed files" data-pr-file-index></nav>
      </details>
      <div class="view-control" role="radiogroup" aria-label="Diff layout">
        <button type="button" class="view-segment" role="radio" data-diff-style="unified">Unified</button>
        <button type="button" class="view-segment" role="radio" data-diff-style="split">Split</button>
      </div>
    </div>
    <div class="pr-files" data-pr-files></div>`;
  const bar = host.querySelector<HTMLElement>("[data-pr-review-bar]")!;
  const filesElement = host.querySelector<HTMLElement>("[data-pr-files]")!;
  const indexElement = host.querySelector<HTMLElement>("[data-pr-file-index]")!;
  const effectiveStyle = (): DiffStyle => (narrow ? "unified" : diffStyle);

  // The bar is pinned under the preview's sticky header, at
  // --pr-sticky-top (set on the view by pull-request-view.ts).
  // Jumps and focus scrolling land below the pinned review bar (CSS
  // scroll-margin reads this); an inactive bar scrolls away, so it counts 0.
  const syncBarHeight = () => {
    host.style.setProperty("--pr-review-bar-height", `${bar.classList.contains("is-active") ? bar.offsetHeight : 0}px`);
  };
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
  const focusBar = () => (bar.querySelector<HTMLElement>("[data-review-finish]:not(:disabled)") ?? bar.querySelector<HTMLElement>("[data-review-start]"))?.focus();

  function renderBar() {
    renderReviewBar(bar, detail, repositoryId, { surface: "files", onStart: () => view.focusFirstLine() });
    syncBarHeight();
  }

  function renderSummary() {
    const pr = detail.summary;
    host.querySelector("[data-pr-files-summary]")!.innerHTML = `<span class="pr-files-summary-toggle">${plural(pr.changedFiles, "file", "files")}</span> · <span class="gh-add">+${pr.additions}</span> <span class="gh-del">−${pr.deletions}</span> · base <code>${escapeHtml(pr.baseRefName)} @ ${escapeHtml(shortOid(pr.baseRefOid))}</code> (PR base) · head <code>${escapeHtml(shortOid(pr.headRefOid))}</code>${detail.mock ? ` · <span class="gh-mock-label">Mocked diffs</span>` : ""}`;
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
    indexElement.innerHTML = detail.files.map(file => `
      <a href="#" class="pr-file-index-item" data-jump-path="${escapeHtmlAttribute(file.path)}">
        <span class="pr-file-index-path">${escapeHtml(file.path)}</span>
        ${reviewMarkBadges(marks.get(file.path))}
        <span class="gh-add">+${file.additions}</span><span class="gh-del">−${file.deletions}</span>
      </a>`).join("");
    for (const file of detail.files) {
      const header = filesElement.querySelector<HTMLElement>(`[data-file-header="${CSS.escape(file.path)}"] [data-file-badges]`);
      if (header) header.innerHTML = reviewMarkBadges(marks.get(file.path));
    }
  }

  indexElement.addEventListener("click", event => {
    const link = (event.target as HTMLElement).closest<HTMLElement>("[data-jump-path]");
    if (!link) return;
    event.preventDefault();
    view.reveal({ path: link.dataset.jumpPath });
  });
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

  function replyComposer(thread: ReviewThread): Composer {
    let reply = replyBoxes.get(thread.id);
    if (reply) return reply;
    reply = createComposer({
      placeholder: "Reply…",
      label: `Reply to the thread on ${thread.path} line ${thread.line}`,
      draftName: `your reply on ${thread.line === null ? thread.path : anchorLabel({ path: thread.path, line: thread.line, side: thread.side })}`,
      submitLabel: "Add reply to review",
      shortcutAction: "adds to review",
      note: `Goes into your pending review as @${detail.viewer}.`,
      draft: { target: draftTarget, location: { kind: "reply", threadId: thread.id } },
      alreadySent: text => draftAlreadySent({ kind: "reply", threadId: thread.id }, text, detail),
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
    const replies = pendingComments().filter(comment => comment.threadId === thread.id);
    const total = thread.comments.length;
    const blocked = blockedReason();
    const resolveAttributes = blocked ? ` disabled title="${escapeHtmlAttribute(blocked)}"` : "";
    const header = `<div class="pr-thread-header">
        <span>Line ${thread.line} · ${plural(total, "comment", "comments")}${replies.length ? ` · ${replies.length} pending` : ""}</span>
        ${thread.isResolved ? `<span class="gh-pill">Resolved</span>` : `<span class="gh-pill gh-pill-attention">Unresolved</span>`}
      </div>`;
    // A resolved thread folds away, unless it holds something of the
    // viewer's not yet sent: a pending reply, or an open reply box.
    if (thread.isResolved && !expandedResolved.has(thread.id) && replies.length === 0 && !openReplies.has(thread.id)) {
      element.classList.add("is-resolved");
      element.innerHTML = `${header}<div class="pr-thread-footer">
        <span class="pr-muted">Conversation resolved.</span>
        <span class="pr-thread-actions"><button type="button" class="gh-button gh-button-quiet" data-thread-show aria-label="Show resolved conversation on ${escapeHtmlAttribute(where)}">Show</button>
        <button type="button" class="gh-button" data-thread-resolve="false" aria-label="Unresolve conversation on ${escapeHtmlAttribute(where)}"${resolveAttributes}>Unresolve</button></span></div>`;
    } else {
      element.innerHTML = `${header}
        ${thread.comments.map(comment => commentHtml(comment.author, comment.createdAt, comment.bodyHtml)).join("")}
        ${replies.map(comment => commentHtml(detail.viewer, comment.createdAt, comment.bodyHtml, true)).join("")}
        <div class="pr-thread-footer">
          <div class="pr-thread-reply" data-thread-reply></div>
          <span class="pr-thread-actions">
            ${thread.isResolved && replies.length === 0 && !openReplies.has(thread.id) ? `<button type="button" class="gh-button gh-button-quiet" data-thread-hide aria-label="Hide resolved conversation on ${escapeHtmlAttribute(where)}">Hide</button>` : ""}
            <button type="button" class="gh-button" data-thread-resolve="${thread.isResolved ? "false" : "true"}" aria-label="${thread.isResolved ? "Unresolve" : "Resolve"} conversation on ${escapeHtmlAttribute(where)}"${resolveAttributes}>${thread.isResolved ? "Unresolve" : "Resolve conversation"}</button>
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
      if (resolved) expandedResolved.delete(thread.id);
      void write(() => githubApi.resolve(target(), thread.id, resolved))
        .then(() => focusLater(`[data-thread-id="${CSS.escape(thread.id)}"] [data-thread-resolve]`), error => alertError(error));
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
      label: `Edit your pending comment on ${comment.path} line ${comment.line}`,
      draftName: `your edit of the comment on ${anchorLabel(comment)}`,
      submitLabel: "Save",
      shortcutAction: "saves",
      note: "Still pending: nobody sees it until you finish your review.",
      draft: { target: draftTarget, location },
      alreadySent: text => draftAlreadySent(location, text, detail),
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
      const text = line.text.trim();
      option.textContent = `line ${line.lineNumber}${line.side === "deletions" ? " (old)" : ""}${text ? ` · ${text.length > 40 ? `${text.slice(0, 40)}…` : text}` : ""}`;
      select.append(option);
    }
    const current = `${position.side}:${position.line}`;
    if (!seen.has(current)) {
      const option = document.createElement("option");
      option.value = current;
      option.textContent = `line ${position.line}${position.side === "LEFT" ? " (old)" : ""}`;
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
    refreshAnnotations();
  }

  function renderInlineComposer(file: PullRequestFile, key: string): HTMLElement {
    const position = composers.get(key)!;
    const kept = composerBoxes.get(key);
    if (kept) {
      kept.box.setBlocked(blockedReason());
      return kept.wrapper;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "pr-inline-composer";
    const count = pendingComments().length;
    const focus = composerFocus?.key === key ? composerFocus.kind : null;
    if (focus) composerFocus = null;
    const box = createComposer({
      heading: lineHeading(file, position),
      shortcutAction: "adds to review",
      placeholder: `Comment on ${file.path}:${position.line} as @${detail.viewer}…`,
      draftName: `your comment on ${anchorLabel({ path: file.path, line: position.line, side: position.side })}`,
      submitLabel: "Add to review",
      note: count === 0 ? "Starts your review. Nothing is published until you finish it." : `Your review has ${plural(count, "pending comment", "pending comments")}.`,
      draft: { target: draftTarget, location: { kind: "inline", ...position } },
      alreadySent: text => draftAlreadySent({ kind: "inline", ...position }, text, detail),
      blockedReason: blockedReason(),
      autofocus: focus === "text",
      onCancel: () => {
        closeComposer(key);
        handles.get(position.path)?.focusLine({ side: fromSide(position.side), lineNumber: position.line });
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
  function startComment(next: ComposerTarget, focus: "text" | "line" = "text") {
    if (detail.summary.state !== "OPEN") return;
    const key = composerKey(next);
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
    keepComposerInView(key);
  }

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
      const top = viewport.top + (parseFloat(getComputedStyle(host).getPropertyValue("--pr-sticky-top")) || 0)
        + (bar.classList.contains("is-active") ? bar.offsetHeight : 0) + lineRoom;
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
    for (const file of detail.files) {
      const section = document.createElement("details");
      section.className = "pr-file";
      section.open = true;
      section.dataset.filePath = file.path;
      section.innerHTML = `<summary class="pr-file-header" data-file-header="${escapeHtmlAttribute(file.path)}">
          <span class="pr-file-path">${escapeHtml(file.path)}</span>
          ${file.status === "added" ? `<span class="gh-pill">New</span>` : ""}
          <span class="gh-del">−${file.deletions}</span><span class="gh-add">+${file.additions}</span>
          <span class="pr-file-badges" data-file-badges>${reviewMarkBadges(marks.get(file.path))}</span>
        </summary>
        ${detail.summary.state === "OPEN" ? `<div class="pr-file-tools"><button type="button" class="gh-button" data-file-comment>Comment on a line…</button></div>` : ""}
        <div class="uatu-diff-host pr-file-diff"></div>`;
      filesElement.append(section);
      section.querySelector("[data-file-comment]")?.addEventListener("click", () => {
        const first = handles.get(file.path)?.lines().find(line => line.side === "additions") ?? handles.get(file.path)?.lines()[0];
        if (first) void startComment({ path: file.path, side: toSide(first.side), line: first.lineNumber }, "line");
      });
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
    const pinned = (parseFloat(getComputedStyle(host).getPropertyValue("--pr-sticky-top")) || 0)
      + (bar.classList.contains("is-active") ? bar.offsetHeight : 0) + 12;
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
      if (text.trim() !== "" && prDrafts.text(draftTarget, location) === "" && draftAlreadySent(location, text, detail)) {
        composers.delete(key);
        composerBoxes.delete(key);
      }
    }
    for (const threadId of [...openReplies]) {
      const location = { kind: "reply" as const, threadId };
      const text = replyBoxes.get(threadId)?.value() ?? "";
      if (text.trim() !== "" && prDrafts.text(draftTarget, location) === "" && draftAlreadySent(location, text, detail)) {
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
      const findSection = () => filesElement.querySelector<HTMLDetailsElement>(`[data-file-path="${CSS.escape(filePath)}"]`);
      const pending = findSection();
      if (pending) pending.open = true;
      void rendered.then(() => requestAnimationFrame(() => {
        const section = findSection();
        if (section) section.open = true;
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
    focusFirstLine() {
      void rendered.then(() => requestAnimationFrame(() => {
        const first = detail.files[0];
        const section = first ? filesElement.querySelector<HTMLDetailsElement>(`[data-file-path="${CSS.escape(first.path)}"]`) : null;
        if (!first || !section) return;
        section.open = true;
        // Files changed from its top when the first file's opening lines
        // still show below the bar and summary: no row is left half under
        // the pinned header. Otherwise the first file goes to the top.
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
        const button = section.querySelector<HTMLElement>("[data-file-comment]");
        if (touchMode() && button) { button.focus({ preventScroll: true }); return; }
        const handle = handles.get(first.path);
        const line = handle?.lines()[0];
        if (!line || !handle?.focusLine(line)) button?.focus({ preventScroll: true });
      }));
    },
  };

  renderBar();
  renderSummary();
  rendered = renderFiles();
  return view;
}

// The review bar, on Files changed and (while a review is pending) on
// Conversation: the pending count, Discard review and Finish review (n), or
// on Files changed without one, how to start and Start review (which only
// moves focus to the first line: nothing is written). One paused-write rule
// for every review write: while GitHub can't take writes (rate limit,
// outage, no credential), Discard and Finish are disabled, and the reason is
// shown in the bar and named by both buttons.
export function renderReviewBar(bar: HTMLElement, detail: PullRequestDetail, repositoryId: string, options: { surface: "files" | "conversation"; onStart?: () => void }): void {
  const count = detail.pendingReview?.comments.length ?? 0;
  const pr = detail.summary;
  const open = pr.state === "OPEN";
  const paused = githubWritesPausedReason(pullRequestStore.state.summary);
  const reasonId = `pr-review-bar-reason-${options.surface}`;
  const reason = paused ? `<span class="pr-review-bar-reason" id="${reasonId}">${escapeHtml(paused)} Your comments stay pending.</span>` : "";
  const pausedAttributes = paused ? ` disabled aria-describedby="${reasonId}" title="${escapeHtmlAttribute(paused)}"` : "";
  const focused = bar.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : null;
  if (detail.pendingReview && count > 0) {
    const comments = plural(count, "pending comment", "pending comments");
    // On a phone the pinned bar is one short row: the count and Finish.
    const compact = touchMode();
    bar.hidden = false;
    bar.className = `pr-review-bar is-active${paused ? " is-paused" : ""}`;
    bar.innerHTML = `
      <span class="gh-pill gh-pill-solid-attention">${compact ? `<span aria-hidden="true">✎ ${count}</span><span class="sr-only">Review in progress: ${comments}</span>` : "Review in progress"}</span>
      <span class="pr-review-bar-text"><strong>${comments}</strong> on #${pr.number} · visible only to you until submitted</span>
      <span class="pr-review-bar-actions">
        <button type="button" class="gh-button${compact ? " gh-button-quiet" : ""}" data-review-discard aria-label="Discard your pending review (${plural(count, "comment", "comments")})"${pausedAttributes}>${compact ? "Discard" : "Discard review"}</button>
        <button type="button" class="gh-button gh-button-primary" data-review-finish${compact ? ` aria-label="${reviewActionLabel(count)}"` : ""}${pausedAttributes}>${compact ? `Finish (${count})` : reviewActionLabel(count)}</button>
      </span>
      ${reason}`;
  } else if (options.surface === "conversation") {
    bar.hidden = true;
    bar.className = "pr-review-bar";
    bar.innerHTML = "";
    return;
  } else {
    bar.hidden = false;
    bar.className = "pr-review-bar";
    bar.innerHTML = open
      ? `<span class="pr-review-bar-text">${touchMode() ? "Tap a line number, or use <strong>Comment on a line</strong> on a file," : "Click a line number (or hover a line and click <kbd>+</kbd>), or Tab to a file's line numbers and press <kbd>Enter</kbd>,"} to start a review comment. Comments stay pending until you finish your review.</span>
         <span class="pr-review-bar-actions"><button type="button" class="gh-button gh-button-quiet" data-review-summary-only title="Approve, comment or request changes with a summary and no line comments">Review without line comments…</button><button type="button" class="gh-button" data-review-start>${reviewActionLabel(0)}</button></span>`
      : `<span class="pr-review-bar-text">This pull request is ${pr.state.toLowerCase()}; reviewing is closed.</span>`;
  }
  const target = { repository: repositoryId, number: pr.number };
  const focusFinish = () => (bar.querySelector<HTMLElement>("[data-review-finish]:not(:disabled)") ?? bar.querySelector<HTMLElement>("[data-review-start]"))?.focus();
  bar.querySelector("[data-review-discard]")?.addEventListener("click", async () => {
    if (!(await confirmDiscardReview(count, pr.number))) return;
    await githubApi.discardReview(target).then(next => {
      pullRequestStore.applyDetail(next);
      focusFinish();
    }, error => alertError(error));
  });
  bar.querySelector("[data-review-finish]")?.addEventListener("click", () => openSubmitReviewDialog({ repositoryId, number: pr.number }, { fallbackFocus: () => bar.querySelector<HTMLElement>("[data-review-finish]") }));
  bar.querySelector("[data-review-start]")?.addEventListener("click", () => options.onStart?.());
  // Approving (or a summary-only comment) needs no line comments: the dialog
  // stays one click away.
  bar.querySelector("[data-review-summary-only]")?.addEventListener("click", () => openSubmitReviewDialog({ repositoryId, number: pr.number }, { fallbackFocus: () => bar.querySelector<HTMLElement>("[data-review-summary-only]") }));
  // A re-render keeps the bar's focused button focused.
  if (focused) {
    const key = "reviewDiscard" in focused ? "[data-review-discard]" : "reviewStart" in focused ? "[data-review-start]" : "reviewSummaryOnly" in focused ? "[data-review-summary-only]" : "[data-review-finish]";
    const next = bar.querySelector<HTMLButtonElement>(key);
    if (next && !next.disabled) next.focus();
    else focusFinish();
  }
}

// Writes from buttons outside a composer have no inline error line; a
// short-lived toast keeps the refusal visible without a modal.
export function alertError(error: unknown) {
  showToast(error instanceof Error ? error.message : "The request failed.", "alert");
}
