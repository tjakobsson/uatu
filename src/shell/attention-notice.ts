// The in-app "an agent needs your answer" notice for OTHER workspaces.
//
// While a user is looking at Uatu the hub holds their Web Push notifications
// (src/hub/presence.ts); the switcher badge carries every other workspace's
// state, but a question is the one thing that blocks an agent, so a session
// page also raises a notice when a workspace it is not serving starts waiting
// for the user. Fed by hub-nav's activity listener: the brokered `activity`
// topic says only that a workspace awaits, never which conversation, so the
// notice's Open link asks the destination workspace to pick (`?awaiting=1`,
// src/chat/notification-navigation.ts).
//
// Triggers, per workspace, against the state this page last knew:
//   first report since the page loaded  baseline, never a notice
//   not awaiting -> awaiting            notice (newest first, one per workspace)
//   awaiting -> not awaiting / stopped  the notice clears itself
// A reconnect does not reset what the page knew, so a question raised while
// the page was hidden is announced when it comes back.
//
// "Not awaiting" must have held for QUIET_BEFORE_NOTICE_MS first. The broker
// reports a running workspace whose activity it has not read yet as idle and
// corrects itself a moment later (right after the hub or a session starts);
// read literally, that correction would announce a question that was already
// waiting when the page loaded. A second question within that time of an
// answer is left to the switcher badge.

import type { WorkspaceActivity } from "../shared/live-protocol";

export type AttentionNotice = { workspaceId: string };

export const QUIET_BEFORE_NOTICE_MS = 1_500;

export class AttentionNotices {
  private readonly known = new Map<string, boolean>();
  // When each workspace was last seen going quiet (or first seen quiet).
  private readonly quietSince = new Map<string, number>();
  private shown: AttentionNotice[] = [];

  constructor(
    private readonly currentId: string,
    private readonly render: (notices: readonly AttentionNotice[]) => void,
    private readonly now: () => number = Date.now,
  ) {}

  report(workspaceId: string, facts: WorkspaceActivity): void {
    const awaiting = facts.running && facts.awaiting;
    const before = this.known.get(workspaceId);
    this.known.set(workspaceId, awaiting);
    if (!awaiting && before !== false) this.quietSince.set(workspaceId, this.now());
    if (workspaceId === this.currentId) return;
    if (!awaiting) {
      this.remove(workspaceId);
      return;
    }
    if (before !== false) return;
    if (this.now() - (this.quietSince.get(workspaceId) ?? this.now()) < QUIET_BEFORE_NOTICE_MS) return;
    this.shown = [{ workspaceId }, ...this.shown.filter(notice => notice.workspaceId !== workspaceId)];
    this.render(this.shown);
  }

  /** Dismiss or Open: the notice goes; the workspace is announced again only after it stops waiting and waits anew. */
  dismiss(workspaceId: string): void {
    this.remove(workspaceId);
  }

  /** A workspace that left the hub's list. */
  forget(workspaceId: string): void {
    this.known.delete(workspaceId);
    this.quietSince.delete(workspaceId);
    this.remove(workspaceId);
  }

  notices(): readonly AttentionNotice[] {
    return this.shown;
  }

  private remove(workspaceId: string): void {
    const next = this.shown.filter(notice => notice.workspaceId !== workspaceId);
    if (next.length === this.shown.length) return;
    this.shown = next;
    this.render(this.shown);
  }
}

/** Where a notice's Open goes: the workspace's session page, told to select whichever conversation waits there. */
export function attentionNoticeHref(workspaceId: string): string {
  return `/s/${encodeURIComponent(workspaceId)}/?awaiting=1`;
}

/**
 * Renders the stack into `host` (created on first use, appended to <body>). Rebuilt on every change: at most one entry
 * per workspace, so the stack is small. `label` names a workspace as the switcher does; `open` navigates.
 */
export function renderAttentionNotices(
  doc: Document,
  notices: readonly AttentionNotice[],
  options: { label: (workspaceId: string) => string; open: (workspaceId: string) => void; dismiss: (workspaceId: string) => void },
): void {
  let host = doc.getElementById("attention-notices");
  if (!host) {
    host = doc.createElement("section");
    host.id = "attention-notices";
    host.className = "attention-notices";
    host.setAttribute("aria-label", "Agents waiting in other workspaces");
    // Polite: a question elsewhere must not interrupt what the user is reading or typing here.
    host.setAttribute("aria-live", "polite");
    doc.body.appendChild(host);
  }
  host.replaceChildren(...notices.map(notice => {
    const item = doc.createElement("div");
    item.className = "attention-notice";
    item.dataset.workspaceId = notice.workspaceId;
    item.setAttribute("role", "status");
    const text = doc.createElement("div");
    text.className = "attention-notice-text";
    const name = doc.createElement("strong");
    name.className = "attention-notice-workspace";
    name.textContent = options.label(notice.workspaceId);
    const detail = doc.createElement("span");
    detail.className = "attention-notice-detail";
    detail.textContent = "An agent needs your answer";
    text.append(name, detail);
    const open = doc.createElement("a");
    open.className = "attention-notice-open";
    open.href = attentionNoticeHref(notice.workspaceId);
    open.textContent = "Open";
    open.addEventListener("click", event => {
      // Modified clicks keep the anchor's open-elsewhere behaviour.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      options.open(notice.workspaceId);
    });
    const dismiss = doc.createElement("button");
    dismiss.type = "button";
    dismiss.className = "attention-notice-dismiss";
    dismiss.setAttribute("aria-label", `Dismiss: ${name.textContent}`);
    dismiss.textContent = "✕";
    dismiss.addEventListener("click", () => options.dismiss(notice.workspaceId));
    item.append(text, open, dismiss);
    return item;
  }));
  host.hidden = notices.length === 0;
}
