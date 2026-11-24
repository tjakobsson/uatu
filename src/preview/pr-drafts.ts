// Unsent pull request text, kept per pull request and location in this tab's
// session storage (scoped to the workspace by presentationSessionStorage), so
// a re-render, an Escape, a second line click or a reload never loses it.
// Nothing here reaches the server: GitHub's pending review stays the only
// server-side draft (design D9); these are the words not yet sent at all.

import type { DiffSide, PullRequestDetail } from "../shared/github-contract";
import { presentationSessionStorage } from "../shell/presentation-storage";

export type DraftLocation =
  | { kind: "conversation" }
  | { kind: "inline"; path: string; side: DiffSide; line: number }
  | { kind: "reply"; threadId: string }
  // Finish review: the summary. The verdict is chosen afresh each time.
  | { kind: "review" }
  // An open edit of one of the viewer's pending comments.
  | { kind: "edit"; commentId: string };

// `sending`: the ids of the comments at this place with this text that
// already existed when a send of it began (see markSending). A draft
// without it was never sent, so it is never taken for sent text.
export type Draft = { text: string; at: number; sending?: string[] };

type DraftTarget = { repositoryId: string; number: number };
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "pr-draft:";

function locationParts(location: DraftLocation): (string | number)[] {
  switch (location.kind) {
    case "conversation":
    case "review":
      return [location.kind];
    case "inline":
      return [location.kind, location.path, location.side, location.line];
    case "reply":
      return [location.kind, location.threadId];
    case "edit":
      return [location.kind, location.commentId];
  }
}

export function draftKey(target: DraftTarget, location: DraftLocation): string {
  return `${PREFIX}${JSON.stringify([target.repositoryId, target.number, ...locationParts(location)])}`;
}

function parseLocation(parts: unknown[]): DraftLocation | null {
  const [kind, ...rest] = parts;
  if (kind === "conversation" || kind === "review") return { kind };
  if (kind === "reply" && typeof rest[0] === "string") return { kind, threadId: rest[0] };
  if (kind === "edit" && typeof rest[0] === "string") return { kind, commentId: rest[0] };
  if (kind === "inline" && typeof rest[0] === "string" && (rest[1] === "LEFT" || rest[1] === "RIGHT") && typeof rest[2] === "number") {
    return { kind, path: rest[0], side: rest[1], line: rest[2] };
  }
  return null;
}

export function createDraftStore(storage: () => DraftStorage | null, now: () => number = Date.now) {
  const read = (key: string): Draft | null => {
    try {
      const raw = storage()?.getItem(key);
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<Draft>;
      if (typeof value.text !== "string") return null;
      const draft: Draft = { text: value.text, at: Number(value.at) || 0 };
      if (Array.isArray(value.sending)) draft.sending = value.sending.filter((id): id is string => typeof id === "string");
      return draft;
    } catch {
      return null;
    }
  };
  return {
    get(target: DraftTarget, location: DraftLocation): Draft | null {
      return read(draftKey(target, location));
    },
    text(target: DraftTarget, location: DraftLocation): string {
      return read(draftKey(target, location))?.text ?? "";
    },
    // Empty or whitespace-only text removes the draft. Typing starts over:
    // any send-attempt mark goes with the old text.
    set(target: DraftTarget, location: DraftLocation, text: string): void {
      const key = draftKey(target, location);
      try {
        if (text.trim() === "") storage()?.removeItem(key);
        else storage()?.setItem(key, JSON.stringify({ text, at: now() }));
      } catch {
        // Storage full or unavailable: the draft lives only in the page.
      }
    },
    // A send of the draft's text is starting: `known` are the matching
    // comments already there (matchingComments), which the send can't have
    // made. A failed send calls set() again, which drops the mark.
    markSending(target: DraftTarget, location: DraftLocation, text: string, known: readonly string[]): void {
      if (text.trim() === "") return;
      try {
        storage()?.setItem(draftKey(target, location), JSON.stringify({ text, at: now(), sending: [...known] }));
      } catch {
        // Unavailable: without the mark the draft is kept, never lost.
      }
    },
    clear(target: DraftTarget, location: DraftLocation): void {
      try { storage()?.removeItem(draftKey(target, location)); } catch { /* unavailable */ }
    },
    // The pull request's saved drafts of one kind, newest first.
    list(target: DraftTarget, kind: DraftLocation["kind"]): { location: DraftLocation; draft: Draft }[] {
      const store = storage();
      if (!store) return [];
      const prefix = draftKey(target, { kind: "conversation" }).replace(/,"conversation"\]$/, ",");
      const found: { location: DraftLocation; draft: Draft }[] = [];
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (!key?.startsWith(prefix)) continue;
        let parts: unknown[];
        try { parts = (JSON.parse(key.slice(PREFIX.length)) as unknown[]).slice(2); } catch { continue; }
        const location = parseLocation(parts);
        const draft = location?.kind === kind ? read(key) : null;
        if (location && draft) found.push({ location, draft });
      }
      return found.sort((a, b) => b.draft.at - a.draft.at);
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

export const prDrafts = createDraftStore(() => presentationSessionStorage());

// Sends a composer's text, then drops its draft before anything else runs:
// the draft goes exactly when GitHub has taken the text, so a reload or a
// failing re-render after that can never bring it back as unsent. A failed
// send keeps the draft (and rethrows); `send` answers what to apply to the
// page once the draft is gone.
export async function sendThenClearDraft(send: () => Promise<(() => void) | void>, clear: () => void): Promise<void> {
  const apply = await send();
  clear();
  try {
    apply?.();
  } catch (error) {
    // Sent and cleared: a page update failing must not read as a failed send.
    console.error(error);
  }
}

// The viewer's comments at a draft's place whose text is the draft's: new
// line comments on its line, replies in its thread, conversation comments.
export function matchingComments(location: DraftLocation, text: string, detail: Pick<PullRequestDetail, "viewer" | "pendingReview" | "timeline">): string[] {
  const body = text.trim();
  if (body === "") return [];
  const pending = detail.pendingReview?.comments ?? [];
  switch (location.kind) {
    case "inline":
      return pending.filter(comment => !comment.threadId && comment.path === location.path && comment.side === location.side
        && comment.line === location.line && comment.body.trim() === body).map(comment => comment.id);
    case "reply":
      return pending.filter(comment => comment.threadId === location.threadId && comment.body.trim() === body).map(comment => comment.id);
    case "conversation":
      return detail.timeline.flatMap(item => item.kind === "comment" && item.comment.author === detail.viewer && item.comment.body.trim() === body ? [item.comment.id] : []);
    case "edit":
    case "review":
      return [];
  }
}

// A saved draft GitHub already holds: the page went away (a reload, a
// crash) after the send went through but before the draft was dropped. Only
// a draft whose send began (markSending) counts, and only a matching comment
// that wasn't there when it began: the same words posted earlier on purpose
// and typed again are unsent text.
export function draftAlreadySent(location: DraftLocation, draft: Pick<Draft, "text" | "sending">, detail: Pick<PullRequestDetail, "viewer" | "pendingReview" | "timeline">): boolean {
  if (draft.text.trim() === "") return false;
  if (location.kind === "edit") {
    const comment = detail.pendingReview?.comments.find(candidate => candidate.id === location.commentId);
    return !comment || comment.body.trim() === draft.text.trim();
  }
  const known = draft.sending;
  if (!known) return false;
  return matchingComments(location, draft.text, detail).some(id => !known.includes(id));
}
