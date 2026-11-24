// The pull request surfaces' one Markdown composer: a textarea, an optional
// Write / Preview toggle (Preview renders through the session's sanitized
// Markdown renderer), a submit button that names its action, and an inline
// error line. ⌘/Ctrl+Enter submits.
//
// Unsent text is never lost: with a `draft` location the text is saved as it
// is typed (src/preview/pr-drafts.ts) and restored by the next composer for
// the same place, a re-render or a reload included; the draft is dropped the
// moment GitHub takes the text (sendThenClearDraft), and a restored draft
// GitHub already holds (`alreadySent`) is dropped instead of reopened.
// Once GitHub takes the text the composer is back on an empty Write tab.
// Cancel or Escape with changed text asks first. While GitHub can't take
// writes (`setBlocked`) the reason replaces the note and only sending waits;
// typing stays possible. Near GitHub's length limit a counter shows, and past
// it sending is refused with the reason.

import { githubApi } from "../github/client";
import { errorMessage } from "../github/pull-request-store";
import { bodyLengthCheck } from "../shared/github-contract";
import { escapeHtml } from "../shared/html";
import { detectIsMac } from "../terminal/clipboard";
import { prDrafts, sendThenClearDraft, type DraftLocation } from "./pr-drafts";
import { confirmDiscardDraft } from "./review-dialogs";

export type ComposerOptions = {
  placeholder: string;
  // The textarea's accessible name, when the placeholder alone lacks context.
  label?: string;
  submitLabel: string;
  // Left of the buttons: what submitting does.
  note?: string;
  tabs?: boolean;
  // Header line above the textarea (inline composers). A node is used as is.
  heading?: string | HTMLElement;
  // What ⌘/Ctrl+Enter does, for the heading's hint ("to submit").
  shortcutAction?: string;
  // Where unsent text is kept between renders and reloads.
  draft?: { target: { repositoryId: string; number: number }; location: DraftLocation };
  // Names the draft in the discard prompt ("your comment on a.md:4 (new)").
  draftName?: string;
  // A restored draft GitHub already holds is dropped, not reopened.
  alreadySent?: (text: string) => boolean;
  // The text to start from when no draft is saved (an edit's current body).
  initialText?: string;
  autofocus?: boolean;
  rows?: number;
  // Sends the text; resolves once GitHub took it, with what to apply to the
  // page then (after the draft is gone). A rejection keeps text and draft.
  send: (body: string) => Promise<(() => void) | void>;
  // Called once the composer may close: empty, or the discard was confirmed.
  onCancel?: () => void;
  // Disables submitting, with the reason shown in place of the note.
  blockedReason?: string | null;
};

export type Composer = {
  element: HTMLElement;
  textarea: HTMLTextAreaElement;
  value: () => string;
  focus: () => void;
  setBlocked: (reason: string | null) => void;
  // Asks before dropping unsent text; resolves true when the composer may go.
  requestClose: () => Promise<boolean>;
};

// Where Left / Right (wrapping), Home and End move in a row of `count`
// tabs; null for any other key (or no tab focused).
export function tabKeyIndex(index: number, key: string, count: number): number | null {
  if (index < 0 || count === 0) return null;
  switch (key) {
    case "ArrowRight": return (index + 1) % count;
    case "ArrowLeft": return (index - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

// "⌘↵" on a Mac, "Ctrl+Enter" elsewhere.
export function submitShortcutLabel(isMac = detectIsMac()): string {
  return isMac ? "⌘↵" : "Ctrl+Enter";
}

export function createComposer(options: ComposerOptions): Composer {
  const element = document.createElement("div");
  element.className = "pr-composer-box";
  const hint = `Markdown · ${submitShortcutLabel()} ${options.shortcutAction ?? "to submit"}`;
  element.innerHTML = `
    ${options.heading ? `<div class="pr-composer-heading"><span data-composer-heading></span><span class="pr-composer-hint">${escapeHtml(hint)}</span></div>` : ""}
    ${options.tabs ? `<div class="pr-composer-tabs" role="tablist" aria-label="Write or preview">
      <button type="button" role="tab" aria-selected="true" tabindex="0" data-composer-tab="write">Write</button>
      <button type="button" role="tab" aria-selected="false" tabindex="-1" data-composer-tab="preview">Preview</button>
      <span class="pr-composer-hint">Markdown · ${escapeHtml(submitShortcutLabel())} ${escapeHtml(options.shortcutAction ?? "to submit")}</span>
    </div>` : ""}
    <textarea class="pr-composer-input" rows="${options.rows ?? 3}" aria-label="${escapeHtml(options.label ?? options.placeholder)}" placeholder="${escapeHtml(options.placeholder)}"></textarea>
    <div class="pr-composer-preview markdown-body" hidden></div>
    <div class="pr-composer-footer">
      <span class="pr-composer-note" aria-live="polite"></span>
      <span class="pr-composer-counter" aria-live="polite" hidden></span>
      <span class="pr-composer-actions">
        ${options.onCancel ? `<button type="button" class="gh-button" data-composer-cancel>Cancel</button>` : ""}
        <button type="button" class="gh-button gh-button-primary" data-composer-submit>${escapeHtml(options.submitLabel)}</button>
      </span>
    </div>`;
  const headingSlot = element.querySelector<HTMLElement>("[data-composer-heading]");
  if (headingSlot && options.heading) {
    if (typeof options.heading === "string") headingSlot.textContent = options.heading;
    else headingSlot.append(options.heading);
  }
  const textarea = element.querySelector<HTMLTextAreaElement>("textarea")!;
  const preview = element.querySelector<HTMLElement>(".pr-composer-preview")!;
  const note = element.querySelector<HTMLElement>(".pr-composer-note")!;
  const submit = element.querySelector<HTMLButtonElement>("[data-composer-submit]")!;
  const counter = element.querySelector<HTMLElement>(".pr-composer-counter")!;
  const draft = options.draft;
  const initial = options.initialText ?? "";
  let saved = draft ? prDrafts.text(draft.target, draft.location) : "";
  if (saved && options.alreadySent?.(saved)) {
    if (draft) prDrafts.clear(draft.target, draft.location);
    saved = "";
  }
  textarea.value = saved || initial;
  let busy = false;
  let blocked = options.blockedReason ?? null;
  let error: string | null = null;

  const renderNote = () => {
    const length = bodyLengthCheck(textarea.value.length);
    const text = busy ? "Posting…" : error ?? blocked ?? length.tooLong ?? options.note ?? "";
    note.textContent = text;
    note.classList.toggle("is-error", !busy && (error !== null || blocked !== null || length.tooLong !== null));
    counter.hidden = length.counter === null;
    counter.textContent = length.counter ?? "";
    counter.classList.toggle("is-error", length.tooLong !== null);
  };
  const sync = () => {
    const text = textarea.value;
    submit.disabled = busy || text.trim() === "" || blocked !== null || bodyLengthCheck(text.length).tooLong !== null
      || (options.initialText !== undefined && text === options.initialText);
    renderNote();
  };
  sync();

  textarea.addEventListener("input", () => {
    if (draft) prDrafts.set(draft.target, draft.location, textarea.value);
    error = null;
    sync();
  });
  const run = async () => {
    if (submit.disabled) return;
    busy = true;
    error = null;
    sync();
    const body = textarea.value;
    let sent = false;
    try {
      await sendThenClearDraft(() => options.send(body), () => {
        if (draft) prDrafts.clear(draft.target, draft.location);
        textarea.value = "";
        sent = true;
        // Sent: back to an empty Write tab, so nothing reads as unsent.
        showWrite();
      });
    } catch (failure) {
      error = errorMessage(failure);
    } finally {
      busy = false;
      sync();
    }
    // A composer that stays (the conversation's) keeps focus for the next
    // comment; one the send closed has moved focus on itself.
    if (sent && textarea.isConnected && (document.activeElement === document.body || element.contains(document.activeElement))) textarea.focus();
  };
  // Unsent changes: any text, or for an edit, text other than the original.
  const dirty = () => (options.initialText !== undefined ? textarea.value !== options.initialText : textarea.value.trim() !== "");
  const requestClose = async (): Promise<boolean> => {
    if (dirty() && !(await confirmDiscardDraft(options.draftName))) {
      textarea.focus();
      return false;
    }
    if (draft) prDrafts.clear(draft.target, draft.location);
    return true;
  };
  const cancel = async () => {
    if (options.onCancel && await requestClose()) options.onCancel();
  };
  submit.addEventListener("click", () => void run());
  textarea.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void run();
    }
    if (event.key === "Escape" && options.onCancel) {
      event.preventDefault();
      event.stopPropagation();
      void cancel();
    }
  });
  element.querySelector("[data-composer-cancel]")?.addEventListener("click", () => void cancel());

  const tabs = [...element.querySelectorAll<HTMLButtonElement>("[data-composer-tab]")];
  const selectTab = (tab: HTMLButtonElement) => {
    for (const other of tabs) {
      other.setAttribute("aria-selected", String(other === tab));
      other.tabIndex = other === tab ? 0 : -1;
    }
    const showPreview = tab.dataset.composerTab === "preview";
    textarea.hidden = showPreview;
    preview.hidden = !showPreview;
    if (!showPreview) preview.innerHTML = "";
  };
  function showWrite(): void {
    const write = tabs.find(tab => tab.dataset.composerTab === "write");
    if (write) selectTab(write);
  }
  // The tabs pattern, as the pull request view's own tabs: Left / Right
  // (wrapping), Home and End move to a tab and show it; focus stays on it.
  element.querySelector(".pr-composer-tabs")?.addEventListener("keydown", event => {
    const key = (event as KeyboardEvent).key;
    const next = tabKeyIndex(tabs.indexOf(event.target as HTMLButtonElement), key, tabs.length);
    if (next === null) return;
    event.preventDefault();
    tabs[next]!.focus();
    tabs[next]!.click();
  });
  for (const tab of tabs) {
    tab.addEventListener("click", async event => {
      const showPreview = tab.dataset.composerTab === "preview";
      selectTab(tab);
      if (!showPreview) {
        // A click goes on writing; arrow keys leave focus on the tab.
        if (event.detail > 0) textarea.focus();
        return;
      }
      if (textarea.value.trim() === "") {
        preview.innerHTML = `<p class="pr-muted">Nothing to preview.</p>`;
        return;
      }
      preview.innerHTML = `<p class="pr-muted">Rendering…</p>`;
      try {
        // Sanitized server-side by src/render/markdown.ts.
        preview.innerHTML = (await githubApi.markdown(textarea.value)).html;
      } catch (failure) {
        preview.innerHTML = `<p class="pr-muted">${escapeHtml(errorMessage(failure))}</p>`;
      }
    });
  }
  if (options.autofocus) queueMicrotask(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  return {
    element,
    textarea,
    value: () => textarea.value,
    focus: () => textarea.focus(),
    setBlocked: reason => {
      if (reason === blocked) return;
      blocked = reason;
      sync();
    },
    requestClose,
  };
}
