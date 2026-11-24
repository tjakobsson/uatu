// Review submission and the discard confirmations for a pull request. Each
// dialog re-reads the pull request when it opens, so it never acts on what an
// older page render showed, and each states who acts (`As @viewer`) and what
// will be published. uatu never merges: merging happens on GitHub (design
// D11).
//
// Every dialog opens at its top with its footer pinned, puts focus on its
// safe choice (never on a button that publishes; on touch, never on a text
// field, which would raise the keyboard over the facts), and gives focus back
// to whatever opened it when it closes: the same control even when a
// re-render replaced it meanwhile. A dialog belongs to one pull request:
// when the workspace stops showing it (another PR, Back / Forward), the
// dialog closes, and what was typed stays as a draft.

import { githubWritesPausedReason } from "../github/availability";
import { githubApi } from "../github/client";
import { errorMessage, pullRequestStore } from "../github/pull-request-store";
import { branchesHtml, mockNotice } from "../github/present";
import { bodyLengthCheck, type PendingComment, type PullRequestDetail, type ReviewEvent } from "../shared/github-contract";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { anchorLabel, lineExcerpt } from "./diff-review-lines";
import { draftAlreadySent, draftKey, matchingComments, prDrafts, type Draft, type DraftLocation } from "./pr-drafts";

type Target = { repositoryId: string; number: number };

type DialogOptions = {
  // Where focus goes on close when the element that opened the dialog is
  // gone (re-rendered away) by then.
  fallbackFocus?: () => HTMLElement | null | undefined;
};

type OpenOptions = DialogOptions & {
  // The pull request the dialog acts on; it closes when that PR is no longer
  // shown.
  number?: number;
  // Asked before Escape, the backdrop or Cancel closes the dialog; resolves
  // false to keep it open (an unsaved edit).
  guard?: () => Promise<boolean>;
};

type OpenDialog = { number: number; label: string; dialog: HTMLDialogElement };
const openDialogs = new Set<OpenDialog>();

const touchMode = () => document.documentElement.dataset.uiMode === "touch";

// Finds a control again after a re-render replaced it: the same data
// attribute (and value) inside the same nearest container with an id (the
// pane header's pending count, the pane's Finish review, Files changed's
// review bar), first one that is shown and enabled.
export function relocateControl(element: HTMLElement): () => HTMLElement | null {
  const scope = element.parentElement?.closest<HTMLElement>("[id]");
  const name = element.getAttributeNames().find(attribute => attribute.startsWith("data-"));
  if (!scope || !name) return () => null;
  const value = element.getAttribute(name) ?? "";
  const selector = value ? `[${name}="${CSS.escape(value)}"]` : `[${name}]`;
  const id = scope.id;
  return () => [...(document.getElementById(id)?.querySelectorAll<HTMLElement>(selector) ?? [])]
    .find(candidate => !(candidate as HTMLButtonElement).disabled && candidate.checkVisibility()) ?? null;
}

function openDialog(label: string, options: OpenOptions = {}): { dialog: HTMLDialogElement; body: HTMLElement; close: () => void; closeTo: (focus: () => void) => void; returnTarget: () => HTMLElement | null; requestClose: () => void } {
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const relocated = opener ? relocateControl(opener) : () => null;
  const dialog = document.createElement("dialog");
  dialog.className = "gh-dialog";
  dialog.setAttribute("aria-label", label);
  dialog.innerHTML = `<div class="gh-dialog-body"></div>`;
  document.body.append(dialog);
  const entry = options.number === undefined ? null : { number: options.number, label, dialog };
  if (entry) openDialogs.add(entry);
  // closeTo: the action's own focus target replaces the opener.
  let focusOnClose: (() => void) | null = null;
  dialog.addEventListener("close", () => {
    if (entry) openDialogs.delete(entry);
    dialog.remove();
    if (focusOnClose) { focusOnClose(); return; }
    // A nested confirmation hands focus back to the dialog under it. An
    // opener that is gone or now disabled gives way to the fallback.
    focusFirst(opener, relocated, () => options.fallbackFocus?.());
  });
  let asking = false;
  const requestClose = () => {
    if (!options.guard) { dialog.close(); return; }
    if (asking) return;
    asking = true;
    void options.guard().then(ok => { asking = false; if (ok && dialog.open) dialog.close(); });
  };
  // Escape asks the guard first. Handled on keydown, not `cancel`: a browser
  // may skip `cancel` on a second Escape and close outright.
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    requestClose();
  });
  dialog.addEventListener("cancel", event => {
    if (!options.guard) return;
    event.preventDefault();
    requestClose();
  });
  // A click on the backdrop (the dialog element itself) closes it.
  dialog.addEventListener("click", event => { if (event.target === dialog) requestClose(); });
  trackDialogFooter(dialog);
  dialog.showModal();
  const closeTo = (focus: () => void) => {
    focusOnClose = focus;
    dialog.close();
  };
  // Where the dialog hands focus back to, for an action that chose another
  // place first: the opener, found again, else the fallback.
  const returnTarget = () => [opener, relocated(), options.fallbackFocus?.()]
    .find((candidate): candidate is HTMLElement => !!candidate?.isConnected && !(candidate as HTMLButtonElement).disabled && candidate.checkVisibility()) ?? null;
  return { dialog, body: dialog.querySelector<HTMLElement>(".gh-dialog-body")!, close: () => dialog.close(), closeTo, returnTarget, requestClose };
}

// The pinned footer's height, for the dialog's scroll padding (styles.css):
// a focused control (Tab to Save in an open edit) or one scrolled to never
// ends up under it. The footer is re-rendered with the dialog's content, so
// the dialog's own size changes are what is watched.
export function trackDialogFooter(dialog: HTMLDialogElement): void {
  if (typeof ResizeObserver !== "function") return;
  let last = "";
  const sync = () => {
    const height = dialog.querySelector<HTMLElement>(".gh-dialog-footer")?.offsetHeight ?? 0;
    // A pinned head (the review dialog's) counts at the top the same way.
    const head = dialog.querySelector<HTMLElement>(".gh-dialog-head");
    const headHeight = head && getComputedStyle(head).position === "sticky" ? head.offsetHeight : 0;
    if (`${height}:${headHeight}` === last) return;
    last = `${height}:${headHeight}`;
    dialog.style.setProperty("--gh-dialog-footer-height", `${height}px`);
    dialog.style.setProperty("--gh-dialog-head-height", `${headHeight}px`);
  };
  const observer = new ResizeObserver(sync);
  observer.observe(dialog);
  const mutations = new MutationObserver(() => {
    sync();
    for (const part of dialog.querySelectorAll<HTMLElement>(".gh-dialog-footer, .gh-dialog-head")) observer.observe(part);
  });
  mutations.observe(dialog, { childList: true, subtree: true });
  dialog.addEventListener("close", () => { observer.disconnect(); mutations.disconnect(); }, { once: true });
}

// Closes every pull request dialog whose PR is not among `shown` (the
// previewed PR and the workspace's current one), saying so: the workspace
// moved on (another PR picked, Back / Forward), so its Submit must not stay
// within reach. Drafts are kept, so nothing typed is lost.
export function closePullRequestDialogsOutside(shown: readonly number[]): void {
  for (const entry of [...openDialogs]) {
    if (shown.includes(entry.number) || !entry.dialog.open) continue;
    openDialogs.delete(entry);
    // The workspace moved on: a verdict chosen for that pull request goes.
    for (const key of keptChoices.keys()) if (key.endsWith(`#${entry.number}`)) keptChoices.delete(key);
    entry.dialog.close();
    const now = shown[0];
    showToast(`Closed “${entry.label}”${now !== undefined ? `: the workspace now shows #${now}` : ""}. What you typed is kept as a draft.`);
  }
}

// Focuses the first candidate that can take focus (connected, enabled,
// rendered); a function is asked only when the ones before it could not.
export function focusFirst(...candidates: (HTMLElement | null | undefined | (() => HTMLElement | null | undefined))[]): boolean {
  for (const candidate of candidates) {
    const element = typeof candidate === "function" ? candidate() : candidate;
    if (!element?.isConnected) continue;
    element.focus();
    if (document.activeElement === element) return true;
  }
  return false;
}

// A text field whose text was put there for the user (a saved draft, the
// comment being edited) is focused with the caret after that text, never
// before it: typing goes on where the text ends. Applied where the field is
// filled, so every later focus (programmatic or a returning dialog) lands
// there unless the user has moved the caret.
export function caretAtEnd(field: Pick<HTMLTextAreaElement, "value" | "setSelectionRange">): void {
  field.setSelectionRange(field.value.length, field.value.length);
}

// Opens at the top, whatever the focused control's position: on a phone the
// footer is pinned, so focusing Cancel there must not scroll the facts away.
function focusAtTop(dialog: HTMLDialogElement, element: HTMLElement | null | undefined): void {
  element?.focus({ preventScroll: true });
  dialog.scrollTop = 0;
}

function loadingHtml(title: string): string {
  return `<h2 class="gh-dialog-title">${escapeHtml(title)}</h2><p class="pr-muted">Reading the pull request from GitHub…</p>`;
}

function failureHtml(title: string, error: unknown): string {
  return `<h2 class="gh-dialog-title">${escapeHtml(title)}</h2>
    <p class="gh-dialog-error" role="alert">${escapeHtml(errorMessage(error))}</p>
    <div class="gh-dialog-footer"><span></span><span class="gh-dialog-actions"><button type="button" class="gh-button" data-dialog-cancel>Close</button></span></div>`;
}

async function readDetail(target: Target): Promise<PullRequestDetail> {
  const detail = await githubApi.pullRequest({ repository: target.repositoryId, number: target.number });
  pullRequestStore.applyDetail(detail);
  return detail;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// --- Toasts ------------------------------------------------------------------

// A short-lived message for outcomes with no inline place to show them: a
// write refused from a button outside a composer (`alert`), or a confirmation
// that a dialog's action went through (`status`). It never takes focus or
// taps (focus goes to a stable control where the action happened, chosen by
// the caller), it is said through a live region that is always in the page,
// and it goes on its timeout. On a short touch screen it is one compact line
// over the pinned header, clear of the diff (styles.css).
export function showToast(text: string, role: "alert" | "status" = "status"): HTMLElement {
  announce(text, role);
  const toast = document.createElement("div");
  toast.className = `pr-toast${role === "alert" ? " is-error" : ""}`;
  // The live region says it; the toast is what sighted users read.
  toast.setAttribute("aria-hidden", "true");
  toast.textContent = text;
  // Toasts that overlap in time stack instead of covering each other.
  const below = [...document.querySelectorAll<HTMLElement>(".pr-toast")].reduce((sum, other) => sum + other.offsetHeight + 8, 0);
  if (below) toast.style.setProperty("--pr-toast-offset", `${below}px`);
  document.body.append(toast);
  // Long messages stay long enough to be read.
  setTimeout(() => toast.remove(), toastDuration(text, role));
  return toast;
}

export function toastDuration(text: string, role: "alert" | "status"): number {
  return role === "alert" || text.length > 90 ? 7000 : 3500;
}

// One polite and one assertive region, created once: a region added with
// its text already in it is often not read.
const liveRegions = new Map<"alert" | "status", HTMLElement>();
export function announce(text: string, role: "alert" | "status" = "status"): void {
  let region = liveRegions.get(role);
  if (!region?.isConnected) {
    region = document.createElement("div");
    region.className = "sr-only";
    region.setAttribute("role", role);
    region.setAttribute("aria-live", role === "alert" ? "assertive" : "polite");
    region.dataset.prLive = role;
    document.body.append(region);
    liveRegions.set(role, region);
  }
  // Cleared first, so the same words twice are said twice.
  region.textContent = "";
  const target = region;
  requestAnimationFrame(() => { target.textContent = text; });
}

// --- Confirmations -----------------------------------------------------------

function confirmAction(options: { label: string; title: string; bodyHtml: string; keep: string; confirm: string; number?: number }): Promise<boolean> {
  return new Promise(resolve => {
    const { dialog, body, close } = openDialog(options.label, { number: options.number });
    let answer = false;
    body.innerHTML = `
      <h2 class="gh-dialog-title">${escapeHtml(options.title)}</h2>
      <p>${options.bodyHtml}</p>
      <div class="gh-dialog-footer"><span></span><span class="gh-dialog-actions">
        <button type="button" class="gh-button" data-dialog-cancel>${escapeHtml(options.keep)}</button>
        <button type="button" class="gh-button gh-button-danger" data-dialog-confirm>${escapeHtml(options.confirm)}</button>
      </span></div>`;
    dialog.addEventListener("close", () => resolve(answer));
    body.querySelector("[data-dialog-cancel]")!.addEventListener("click", close);
    body.querySelector("[data-dialog-confirm]")!.addEventListener("click", () => { answer = true; close(); });
    focusAtTop(dialog, body.querySelector<HTMLButtonElement>("[data-dialog-cancel]"));
  });
}

export function confirmDiscardReview(count: number, number?: number): Promise<boolean> {
  return confirmAction({
    number,
    label: "Discard pending review",
    title: "Discard your pending review?",
    bodyHtml: `${count} pending ${count === 1 ? "comment is" : "comments are"} deleted from GitHub. Nobody else has seen ${count === 1 ? "it" : "them"}, and this can't be undone.`,
    keep: "Keep reviewing",
    confirm: `Discard ${plural(count, "comment", "comments")}`,
  });
}

export function confirmDiscardPendingComment(where: string, number?: number): Promise<boolean> {
  return confirmAction({
    number,
    label: "Discard pending comment",
    title: "Discard this pending comment?",
    bodyHtml: `Your comment on <code>${escapeHtml(where)}</code> is deleted from your pending review on GitHub. Nobody else has seen it, and this can't be undone.`,
    keep: "Keep it",
    confirm: "Discard comment",
  });
}

// Unsent text in a composer or an open edit (Cancel, Escape, or another
// line clicked). `what` names the draft ("your comment on links.ts:1 (new)"):
// the prompt may come while the user is looking at another line.
export function confirmDiscardDraft(what?: string): Promise<boolean> {
  return confirmAction({
    label: "Discard draft",
    title: what ? `Discard ${what}?` : "Discard this draft?",
    bodyHtml: `What you typed${what ? ` in ${escapeHtml(what)}` : ""} hasn't been sent anywhere yet. Discarding it can't be undone.`,
    keep: "Keep editing",
    confirm: "Discard draft",
  });
}

// Dev-only (the fake's Reset data): it deletes what was written so far.
export function confirmResetMockData(pending = 0): Promise<boolean> {
  return confirmAction({
    label: "Reset mocked GitHub data",
    title: "Reset the mocked GitHub data?",
    bodyHtml: `The fake starts over: every comment, reply, review and resolution made in this session is deleted${pending > 0 ? `, including your ${plural(pending, "pending comment", "pending comments")}` : ", pending comments included"}. Unsent drafts stay. Nothing reaches GitHub.`,
    keep: "Keep data",
    confirm: "Reset data",
  });
}

// The one name of the review button everywhere it appears (the Pull request
// pane, the review bar, the touch tabs row): it opens the review dialog, to
// review, or to finish the review in progress.
export function reviewActionLabel(pending: number): string {
  return pending > 0 ? `Finish review (${pending})` : "Review";
}

// The review dialog's final button names what it publishes.
export function submitReviewLabel(choice: ReviewEvent | null): string {
  return choice === "APPROVE" ? "Publish approval" : choice === "REQUEST_CHANGES" ? "Request changes" : choice === "COMMENT" ? "Post comment review" : "Submit review";
}

// "Add line comments" in the review dialog: the dialog closes (its summary
// and verdict stay as drafts) and Files changed opens a composer on the first
// changed line (pull-request-view.ts listens).
export const ADD_LINE_COMMENTS_EVENT = "uatu:pull-request-add-line-comments";

// What Finish review starts from when it opens: the saved summary, unless it
// is only whitespace, and the verdict chosen when the dialog was last
// dismissed on this page (`kept`). Verdicts live in page memory only: a
// reload, a submitted review or the workspace moving to another pull request
// drops them, so a Request changes never comes back from an earlier visit.
export function reviewDialogStart(saved: Draft | null, kept: ReviewEvent | null = null): { summary: string; choice: ReviewEvent | null } {
  return { summary: saved && saved.text.trim() !== "" ? saved.text : "", choice: kept };
}

// The verdict last chosen per pull request (`<repositoryId>#<number>`).
const keptChoices = new Map<string, ReviewEvent>();

// Line comments and replies typed in Files changed but not added to the
// review: Finish review names them and asks, so it never publishes without
// them by surprise. Drafts GitHub already holds, or for files and threads
// no longer in the pull request, don't count.
export type UnsentReviewDraft = { location: Extract<DraftLocation, { kind: "inline" } | { kind: "reply" }>; text: string; where: string };
export function unsentReviewDrafts(
  drafts: readonly { location: DraftLocation; draft: Draft }[],
  detail: Pick<PullRequestDetail, "viewer" | "pendingReview" | "timeline" | "files" | "threads">,
): UnsentReviewDraft[] {
  return drafts.flatMap(({ location, draft }): UnsentReviewDraft[] => {
    if (draft.text.trim() === "" || draftAlreadySent(location, draft, detail)) return [];
    if (location.kind === "inline") {
      if (!detail.files.some(file => file.path === location.path)) return [];
      return [{ location, text: draft.text, where: anchorLabel(location) }];
    }
    if (location.kind === "reply") {
      const thread = detail.threads.find(candidate => candidate.id === location.threadId);
      if (!thread) return [];
      return [{ location, text: draft.text, where: `reply on ${thread.line === null ? thread.path : anchorLabel({ path: thread.path, line: thread.line, side: thread.side })}` }];
    }
    return [];
  });
}

// Unsent drafts the reviewer chose to leave out of the review ("Leave it as
// a draft"): remembered for this page while the draft's text is the text
// that was left, so closing and reopening Finish review doesn't ask again,
// and editing the draft does.
export function createLeftAsDrafts() {
  const left = new Map<string, string>();
  return {
    leave(target: { repositoryId: string; number: number }, draft: Pick<UnsentReviewDraft, "location" | "text">): void {
      left.set(draftKey(target, draft.location), draft.text);
    },
    has(target: { repositoryId: string; number: number }, draft: Pick<UnsentReviewDraft, "location" | "text">): boolean {
      return left.get(draftKey(target, draft.location)) === draft.text;
    },
  };
}
const leftAsDrafts = createLeftAsDrafts();

// --- Submit review ---------------------------------------------------------

const REVIEW_CHOICES: { event: ReviewEvent; label: string; description: string }[] = [
  { event: "COMMENT", label: "Comment", description: "General feedback without explicit approval." },
  { event: "APPROVE", label: "Approve", description: "Give your approval to merge these changes." },
  { event: "REQUEST_CHANGES", label: "Request changes", description: "Feedback that must be addressed before merging." },
];

// Why Submit review is disabled, first reason first; null when it can go.
// `editing` names the pending comment whose edit is open: submitting then
// would publish its old text and lose the edit.
export function reviewSubmitReason(input: {
  paused: string | null;
  pr: { number: number; state: string };
  choice: ReviewEvent | null;
  summary: string;
  pendingComments: number;
  editing?: string | null;
  // Unsent drafts not yet added to the review or left as drafts.
  unsent?: number;
}): string | null {
  const blank = input.summary.trim() === "";
  if (input.paused) return input.paused;
  if (input.pr.state !== "OPEN") return `#${input.pr.number} is ${input.pr.state.toLowerCase()}; it can no longer be reviewed.`;
  if (input.editing) return `Save or cancel your edit of the comment on ${input.editing} first.`;
  if (input.unsent) return input.unsent === 1 ? "Add your unsent comment to the review, or leave it as a draft." : `Add your ${input.unsent} unsent comments to the review, or leave them as drafts.`;
  const tooLong = bodyLengthCheck(input.summary.length).tooLong;
  if (tooLong) return `Summary: ${tooLong}`;
  if (!input.choice) return "Choose Comment, Approve or Request changes.";
  if (input.choice === "COMMENT" && blank && input.pendingComments === 0) return "Write a summary or add a line comment first.";
  if (input.choice === "REQUEST_CHANGES" && blank) return "Say what needs to change in the summary.";
  return null;
}

// What the summary field asks for, following the verdict and the pending
// count, by the same rule reviewSubmitReason enforces (and GitHub's): a
// summary is required to request changes, and for a comment review without
// line comments; it is optional for an approval, and for a comment review
// that publishes pending comments.
export function summaryGuidance(choice: ReviewEvent | null, pendingComments: number): { need: "required" | "optional" | null; placeholder: string } {
  const lines = pendingComments === 1 ? "your pending comment" : `your ${pendingComments} pending comments`;
  if (choice === "REQUEST_CHANGES") return { need: "required", placeholder: "Say what needs to change (Markdown)." };
  if (choice === "APPROVE") return { need: "optional", placeholder: "Optional: add a note to your approval (Markdown)." };
  if (choice === "COMMENT") {
    return pendingComments > 0
      ? { need: "optional", placeholder: `Optional: ${lines} ${pendingComments === 1 ? "is" : "are"} published with it (Markdown).` }
      : { need: "required", placeholder: "Write your comment (Markdown)." };
  }
  return { need: null, placeholder: pendingComments > 0
    ? "Leave a summary (Markdown). Required to request changes."
    : "Leave a summary (Markdown). Required to comment or request changes; optional to approve." };
}

export function openSubmitReviewDialog(target: Target, options: DialogOptions = {}): void {
  const draftTarget = { repositoryId: target.repositoryId, number: target.number };
  // The open edit of a pending comment, if any; its text is a draft too, so
  // neither a re-render nor the dialog closing loses it.
  let editing: string | null = null;
  let editOriginal = "";
  let editText: string | null = null;
  const editDirty = () => editing !== null && editText !== null && editText !== editOriginal;
  let editWhere = "";
  const editName = () => `your edit of the comment on ${editWhere}`;
  const { dialog, body, close, closeTo, returnTarget, requestClose } = openDialog(`Review #${target.number}`, {
    ...options,
    number: target.number,
    // An unsaved edit of a pending comment asks before it goes, as the
    // inline composer does; the summary and verdict are drafts anyway.
    guard: async () => {
      if (!editDirty()) return true;
      if (!(await confirmDiscardDraft(editName()))) return false;
      if (editing) prDrafts.clear(draftTarget, { kind: "edit", commentId: editing });
      return true;
    },
  });
  // Its head (the number and title) stays pinned while it scrolls, and on a
  // short screen the verdicts come right under it (styles.css).
  dialog.classList.add("gh-review-dialog");
  body.innerHTML = loadingHtml(`Review · #${target.number}`);
  // The summary outlives the dialog (Escape, a backdrop click, a reload)
  // until the review is submitted; the verdict only while this page shows
  // the pull request (reviewDialogStart).
  const choiceKey = `${target.repositoryId}#${target.number}`;
  let { summary, choice } = reviewDialogStart(prDrafts.get(draftTarget, { kind: "review" }), keptChoices.get(choiceKey) ?? null);
  const save = () => prDrafts.set(draftTarget, { kind: "review" }, summary);
  const startEdit = (comment: PendingComment) => {
    editing = comment.id;
    editWhere = anchorLabel(comment);
    editOriginal = comment.body;
    const kept = prDrafts.text(draftTarget, { kind: "edit", commentId: comment.id });
    editText = kept || comment.body;
  };
  const stopEdit = () => {
    if (editing) prDrafts.clear(draftTarget, { kind: "edit", commentId: editing });
    editing = null;
    editText = null;
  };

  const render = (detail: PullRequestDetail, focus: "summary" | "editing" | "list" | "unsent" = "summary") => {
    const pr = detail.summary;
    const comments = detail.pendingReview?.comments ?? [];
    const own = pr.author === detail.viewer;
    const closed = pr.state !== "OPEN";
    if (choice && (closed || own && choice !== "COMMENT")) {
      choice = null;
      keptChoices.delete(choiceKey);
    }
    if (editing && !comments.some(comment => comment.id === editing)) stopEdit();
    const unsent = closed ? [] : unsentReviewDrafts([...prDrafts.list(draftTarget, "inline"), ...prDrafts.list(draftTarget, "reply")], detail);
    const undecided = unsent.filter(draft => !leftAsDrafts.has(draftTarget, draft));
    const one = undecided.length === 1;
    const unsentHtml = undecided.length > 0
      ? `<div class="gh-notice gh-notice-warn gh-unsent" role="group" aria-labelledby="gh-unsent-title" data-unsent>
          <p id="gh-unsent-title"><strong>${one ? "1 comment isn't" : `${undecided.length} comments aren't`} in your review yet.</strong> ${one ? "It was typed in Files changed but not added, so submitting wouldn't publish it." : "They were typed in Files changed but not added, so submitting wouldn't publish them."}</p>
          <ul class="gh-unsent-list">${undecided.map(draft => `<li><code>${escapeHtml(draft.where)}</code> <span class="gh-unsent-text">${escapeHtml(draft.text.trim().replace(/\s+/g, " ").slice(0, 120))}</span></li>`).join("")}</ul>
          <div class="gh-unsent-actions">
            <button type="button" class="gh-button gh-button-primary" data-unsent-add>${one ? "Add it to the review" : "Add them to the review"}</button>
            <button type="button" class="gh-button" data-unsent-leave>${one ? "Leave it as a draft" : "Leave them as drafts"}</button>
          </div>
        </div>`
      : unsent.length > 0
        ? `<p class="gh-dialog-note pr-muted" data-unsent-left>${unsent.length === 1 ? "1 unsent comment stays a draft in Files changed; this review doesn't publish it." : `${unsent.length} unsent comments stay drafts in Files changed; this review doesn't publish them.`}</p>`
        : "";
    body.innerHTML = `
      <div class="gh-dialog-head">
        <h2 class="gh-dialog-title">${comments.length ? "Finish your review" : "Review"} · #${pr.number}</h2>
        <p class="gh-dialog-sub" title="${escapeHtmlAttribute(pr.title)}">${escapeHtml(pr.title)} — ${branchesHtml(pr)} ${mockNotice(detail.mock)}</p>
      </div>
      ${unsentHtml}
      <label class="gh-dialog-label" for="gh-review-summary">Summary <span class="gh-dialog-label-need" data-summary-need></span></label>
      <textarea id="gh-review-summary" class="gh-input" rows="3">${escapeHtml(summary)}</textarea>
      <p class="gh-field-counter" data-summary-counter aria-live="polite" hidden></p>
      <div class="gh-choice-list" role="radiogroup" aria-label="Review type">
        ${REVIEW_CHOICES.map(item => {
          const disabled = closed || own && item.event !== "COMMENT";
          return `<label class="gh-choice${disabled ? " is-disabled" : ""}${choice === item.event ? " is-selected" : ""}">
            <input type="radio" name="gh-review-event" value="${item.event}"${choice === item.event ? " checked" : ""}${disabled ? " disabled" : ""}>
            <span><strong>${item.label}</strong><span class="gh-choice-description">${disabled && own ? "You can't approve or request changes on your own pull request." : item.description}</span></span>
          </label>`;
        }).join("")}
      </div>
      <div class="gh-dialog-section-row">
        <h3 class="gh-dialog-section">Pending comments · ${comments.length}</h3>
        <span class="gh-dialog-section-actions">
          ${comments.length > 0 ? `<button type="button" class="gh-link-button" data-review-discard aria-label="Discard your pending review (${plural(comments.length, "comment", "comments")})">Discard review…</button>` : ""}
          ${closed ? "" : `<button type="button" class="gh-button" data-review-add-lines title="Close this dialog and comment on lines in Files changed; your summary and verdict are kept">Add line comments</button>`}
        </span>
      </div>
      ${comments.length === 0 ? `<p class="pr-muted gh-dialog-empty">No pending comments. The review publishes the summary only, or add line comments first.</p>` : `<ul class="gh-pending-list">
        ${comments.map(comment => {
          const where = anchorLabel(comment);
          const excerpt = lineExcerpt(detail.files, comment);
          return `<li data-pending-id="${escapeHtmlAttribute(comment.id)}">
          <div class="gh-pending-row">
            <a href="#" class="gh-pending-location" data-pending-jump>${escapeHtml(where)}${comment.threadId ? " · reply" : ""}</a>
            <span class="gh-pending-actions"><button type="button" class="gh-link-button" data-pending-edit aria-label="Edit pending comment on ${escapeHtmlAttribute(where)}">Edit</button> · <button type="button" class="gh-link-button" data-pending-discard aria-label="Discard pending comment on ${escapeHtmlAttribute(where)}">Discard</button></span>
          </div>
          ${excerpt ? `<code class="gh-pending-excerpt" title="${escapeHtmlAttribute(excerpt)}">${escapeHtml(excerpt)}</code>` : ""}
          ${editing === comment.id
            ? `<textarea class="gh-input" rows="3" data-pending-text aria-label="Pending comment on ${escapeHtmlAttribute(where)}" aria-describedby="gh-pending-save-reason">${escapeHtml(editText ?? comment.body)}</textarea>
               <div class="gh-pending-edit-actions"><span id="gh-pending-save-reason" class="gh-dialog-reason" data-pending-save-reason></span><button type="button" class="gh-button" data-pending-cancel>Cancel</button><button type="button" class="gh-button gh-button-primary" data-pending-save>Save</button></div>`
            : `<p class="gh-pending-body">${escapeHtml(comment.body)}</p>`}
        </li>`;
        }).join("")}
      </ul>`}
      <p class="gh-dialog-error" role="alert" hidden></p>
      <div class="gh-dialog-footer">
        <p class="gh-dialog-reason" data-submit-reason></p>
        <span class="gh-dialog-attribution">As <strong>@${escapeHtml(detail.viewer)}</strong> · publishes ${plural(comments.length, "comment", "comments")}</span>
        <span class="gh-dialog-actions">
          <button type="button" class="gh-button" data-dialog-cancel>Cancel</button>
          <button type="button" class="gh-button gh-button-primary" data-review-submit>${escapeHtml(submitReviewLabel(choice))}</button>
        </span>
      </div>`;

    const textarea = body.querySelector<HTMLTextAreaElement>("#gh-review-summary")!;
    for (const field of body.querySelectorAll<HTMLTextAreaElement>("textarea")) caretAtEnd(field);
    const submit = body.querySelector<HTMLButtonElement>("[data-review-submit]")!;
    const reason = body.querySelector<HTMLElement>("[data-submit-reason]")!;
    const summaryCounter = body.querySelector<HTMLElement>("[data-summary-counter]")!;
    const summaryNeed = body.querySelector<HTMLElement>("[data-summary-need]")!;
    const errorLine = body.querySelector<HTMLElement>(".gh-dialog-error")!;
    const edited = editing ? comments.find(comment => comment.id === editing) : undefined;
    const sync = () => {
      const why = reviewSubmitReason({
        paused: githubWritesPausedReason(pullRequestStore.state.summary), pr, choice, summary, pendingComments: comments.length,
        editing: edited ? anchorLabel(edited) : null, unsent: undecided.length,
      });
      submit.disabled = why !== null;
      if (submit.textContent !== "Submitting…") submit.textContent = submitReviewLabel(choice);
      reason.textContent = why ?? "";
      // The field says what it needs for the chosen verdict.
      const guidance = summaryGuidance(choice, comments.length);
      textarea.placeholder = guidance.placeholder;
      summaryNeed.textContent = guidance.need === null ? "" : `(${guidance.need})`;
      const length = bodyLengthCheck(summary.length);
      summaryCounter.hidden = length.counter === null;
      summaryCounter.textContent = length.counter ?? "";
      summaryCounter.classList.toggle("is-error", length.tooLong !== null);
      const saveButton = body.querySelector<HTMLButtonElement>("[data-pending-save]");
      if (saveButton) {
        const text = editText ?? "";
        const why = text.trim() === "" ? "A comment can't be empty; Discard removes it." : bodyLengthCheck(text.length).tooLong ?? "";
        saveButton.disabled = why !== "" || text === editOriginal;
        body.querySelector<HTMLElement>("[data-pending-save-reason]")!.textContent = why;
      }
    };
    textarea.addEventListener("input", () => { summary = textarea.value; save(); sync(); });
    for (const radio of body.querySelectorAll<HTMLInputElement>("input[name=gh-review-event]")) {
      radio.addEventListener("change", () => {
        choice = radio.value as ReviewEvent;
        keptChoices.set(choiceKey, choice);
        save();
        for (const option of body.querySelectorAll(".gh-choice")) option.classList.toggle("is-selected", option.contains(radio));
        sync();
      });
    }
    for (const row of body.querySelectorAll<HTMLElement>("[data-pending-id]")) {
      const id = row.dataset.pendingId!;
      const comment = comments.find(candidate => candidate.id === id)!;
      row.querySelector("[data-pending-jump]")?.addEventListener("click", event => {
        event.preventDefault();
        requestClose();
        // Once the dialog has gone (an unsaved edit may keep it open).
        const reveal = () => document.dispatchEvent(new CustomEvent("uatu:pull-request-reveal", { detail: { number: pr.number, path: comment.path, threadId: comment.threadId, pendingId: comment.threadId ? undefined : comment.id } }));
        if (!dialog.open) reveal();
        else dialog.addEventListener("close", reveal, { once: true });
      });
      row.querySelector("[data-pending-edit]")?.addEventListener("click", async () => {
        if (editing === id) return;
        if (editDirty() && !(await confirmDiscardDraft(editName()))) return;
        stopEdit();
        startEdit(comment);
        render(detail, "editing");
      });
      // ⌘/Ctrl+Enter saves, as it does in the composers.
      row.querySelector<HTMLTextAreaElement>("[data-pending-text]")?.addEventListener("keydown", event => {
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        const save = row.querySelector<HTMLButtonElement>("[data-pending-save]");
        if (save && !save.disabled) save.click();
      });
      row.querySelector<HTMLTextAreaElement>("[data-pending-text]")?.addEventListener("input", event => {
        editText = (event.target as HTMLTextAreaElement).value;
        prDrafts.set(draftTarget, { kind: "edit", commentId: id }, editText === editOriginal ? "" : editText);
        sync();
      });
      row.querySelector("[data-pending-cancel]")?.addEventListener("click", async () => {
        if (editDirty() && !(await confirmDiscardDraft(editName()))) return;
        stopEdit();
        render(detail, "list");
      });
      row.querySelector<HTMLButtonElement>("[data-pending-save]")?.addEventListener("click", async event => {
        const button = event.currentTarget as HTMLButtonElement;
        const text = editText ?? "";
        if (text.trim() === "") return;
        button.disabled = true;
        try {
          const next = await githubApi.editPendingComment({ repository: target.repositoryId, number: pr.number }, id, text);
          stopEdit();
          pullRequestStore.applyDetail(next);
          render(next, "list");
        } catch (error) {
          button.disabled = false;
          showError(errorLine, error);
        }
      });
      row.querySelector("[data-pending-discard]")?.addEventListener("click", async () => {
        if (!(await confirmDiscardPendingComment(anchorLabel(comment), pr.number))) return;
        try {
          const next = await githubApi.deletePendingComment({ repository: target.repositoryId, number: pr.number }, id);
          pullRequestStore.applyDetail(next);
          if (editing === id) stopEdit();
          render(next, "list");
        } catch (error) { showError(errorLine, error); }
      });
    }
    body.querySelector("[data-review-add-lines]")?.addEventListener("click", () => {
      // The summary is saved as typed and the verdict is kept for this page;
      // an open edit stays a draft and reopens with the dialog.
      closeTo(() => document.dispatchEvent(new CustomEvent(ADD_LINE_COMMENTS_EVENT, { detail: { repositoryId: target.repositoryId, number: pr.number } })));
    });
    body.querySelector("[data-review-discard]")?.addEventListener("click", async () => {
      if (!(await confirmDiscardReview(comments.length, pr.number))) return;
      try {
        const next = await githubApi.discardReview({ repository: target.repositoryId, number: pr.number });
        stopEdit();
        pullRequestStore.applyDetail(next);
        render(next, "summary");
      } catch (error) { showError(errorLine, error); }
    });
    body.querySelector("[data-unsent-leave]")?.addEventListener("click", () => {
      for (const draft of undecided) leftAsDrafts.leave(draftTarget, draft);
      render(detail, "unsent");
    });
    body.querySelector<HTMLButtonElement>("[data-unsent-add]")?.addEventListener("click", async event => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      button.textContent = "Adding…";
      const where = { repository: target.repositoryId, number: pr.number };
      let latest = detail;
      try {
        // One at a time, each draft dropped the moment GitHub has it.
        for (const draft of undecided) {
          const location = draft.location;
          // Marked first, as a composer's send is: a reload mid-way drops it.
          prDrafts.markSending(draftTarget, location, draft.text, matchingComments(location, draft.text, latest));
          latest = location.kind === "inline"
            ? await githubApi.createThread(where, { headOid: latest.summary.headRefOid, path: location.path, line: location.line, side: location.side, body: draft.text })
            : await githubApi.reply(where, location.threadId, draft.text);
          prDrafts.clear(draftTarget, location);
        }
        pullRequestStore.applyDetail(latest);
        render(latest, "unsent");
      } catch (error) {
        if (latest !== detail) pullRequestStore.applyDetail(latest);
        render(latest, "unsent");
        showError(body.querySelector<HTMLElement>(".gh-dialog-error")!, error);
      }
    });
    body.querySelector("[data-dialog-cancel]")!.addEventListener("click", requestClose);
    submit.addEventListener("click", async () => {
      if (!choice || editing) return;
      submit.disabled = true;
      submit.textContent = "Submitting…";
      try {
        const next = await githubApi.submitReview({ repository: target.repositoryId, number: pr.number }, choice, summary);
        prDrafts.clear(draftTarget, { kind: "review" });
        keptChoices.delete(choiceKey);
        pullRequestStore.applyDetail(next);
        const verdict = REVIEW_CHOICES.find(item => item.event === choice)!.label;
        // Every entry point (the pane, the review bar, the tabs row) and
        // every device: the outcome is announced, and focus
        // goes back where the dialog came from, or its stable fallback (the
        // review bar or the tabs row, the pane's review button), without
        // scrolling the page.
        closeTo(() => {
          showToast(`Review submitted on #${pr.number}: ${verdict}${comments.length ? `, ${plural(comments.length, "comment", "comments")} published` : ""}.`);
          returnTarget()?.focus({ preventScroll: true });
        });
      } catch (error) {
        submit.textContent = submitReviewLabel(choice);
        showError(errorLine, error);
        sync();
      }
    });
    sync();
    // Never onto Submit (it publishes): the choice that is left, else the
    // summary (Cancel on touch, where the keyboard would cover the facts).
    // After the unsent comments were added or left, the dialog stays where
    // it was (its head is pinned) instead of jumping to the focused control.
    if (focus === "unsent") {
      const scroll = dialog.scrollTop;
      const next = body.querySelector<HTMLElement>("[data-unsent-add]") ?? (touchMode() ? body.querySelector<HTMLElement>("[data-dialog-cancel]") : textarea);
      next?.focus({ preventScroll: true });
      dialog.scrollTop = scroll;
    }
    else if (focus === "editing") body.querySelector<HTMLTextAreaElement>("[data-pending-text]")?.focus();
    else if (focus === "list") (body.querySelector<HTMLElement>("[data-pending-edit]") ?? textarea).focus();
    // On touch the keyboard would cover the verdicts and the pending list:
    // focus starts on Cancel there.
    else focusAtTop(dialog, touchMode() ? body.querySelector<HTMLButtonElement>("[data-dialog-cancel]") : textarea);
  };

  readDetail(target).then(detail => {
    if (!dialog.open) return;
    // An edit left open when the dialog last closed comes back open.
    const kept = prDrafts.list(draftTarget, "edit")
      .map(entry => detail.pendingReview?.comments.find(comment => entry.location.kind === "edit" && comment.id === entry.location.commentId))
      .find(comment => comment !== undefined);
    if (kept) startEdit(kept);
    render(detail, kept ? "editing" : "summary");
  }, error => {
    body.innerHTML = failureHtml(`Review · #${target.number}`, error);
    body.querySelector("[data-dialog-cancel]")!.addEventListener("click", close);
  });
}

function showError(element: HTMLElement, error: unknown) {
  element.hidden = false;
  element.textContent = errorMessage(error);
}
