// Which document render the preview is showing, so a reload of that same
// render that fails transiently can leave it on screen while the retry
// schedule runs (#468) instead of blanking the content, outline and facts
// strip.
//
// The render is identified by document, view and layout, and it counts as
// shown only while the top-level nodes it mounted are still in the preview.
// Every other preview body (the empty state, a diff, a binary or image
// notice, a commit message) replaces those nodes, so none of those writers
// has to report to the tracker. In-place decoration of single nodes (Mermaid
// diagrams) leaves the rest mounted, so the render still counts as shown.

import type { ViewLayout, ViewMode } from "../shared/types";

export type PresentedRenderKey = {
  documentId: string;
  view: ViewMode;
  layout: ViewLayout;
};

export type PresentedRender = {
  // A document render was just mounted into the container.
  note(key: PresentedRenderKey): void;
  // Whether the container still shows the render noted for `key`.
  shows(key: PresentedRenderKey): boolean;
};

export function createPresentedRender(container: HTMLElement): PresentedRender {
  let presented: { key: PresentedRenderKey; nodes: ChildNode[] } | null = null;
  return {
    note(key) {
      presented = { key: { ...key }, nodes: Array.from(container.childNodes) };
    },
    shows(key) {
      if (!presented) return false;
      const { key: shown, nodes } = presented;
      return shown.documentId === key.documentId
        && shown.view === key.view
        && shown.layout === key.layout
        && nodes.some(node => node.parentNode === container);
    },
  };
}

// The header notice for a reload of the render on screen that failed:
// "retrying" while the schedule has another attempt pending, "gave-up" once
// it is used up (with a Retry button; mount.ts wires its click), "hidden"
// otherwise. Looked up per call so importing this module needs no DOM.
// The notice, unlike the tracker, must be taken down by whatever replaces the
// kept render: mount.ts does it for document loads (including the binary,
// image and media bodies they mount, which the same id can turn into),
// empty.ts and commit-message.ts do it
// for the bodies they mount outside a document load, and diff.ts does it as
// soon as a diff is asked for.
export type ReloadNoticeState = "hidden" | "retrying" | "gave-up";

const RELOAD_NOTICE_MESSAGES: Record<Exclude<ReloadNoticeState, "hidden">, string> = {
  retrying: "This file couldn't be reloaded. Retrying…",
  "gave-up": "This file couldn't be reloaded.",
};

export function setReloadNotice(state: ReloadNoticeState): void {
  const notice = document.querySelector<HTMLElement>("#preview-reload-notice");
  if (!notice) return;
  const message = notice.querySelector<HTMLElement>(".preview-reload-message");
  const retry = notice.querySelector<HTMLButtonElement>(".preview-reload-retry");
  // A keyboard user on Retry would otherwise lose focus to the page when the
  // button disappears; hand it to the preview they were reading.
  if (retry && state !== "gave-up" && document.activeElement === retry) {
    document.querySelector<HTMLElement>(".preview-shell")?.focus({ preventScroll: true });
  }
  notice.hidden = state === "hidden";
  if (message && state !== "hidden") message.textContent = RELOAD_NOTICE_MESSAGES[state];
  // Screen readers hear the notice through a status region that is always
  // exposed: one revealed and filled in the same step can go unannounced.
  const status = document.querySelector<HTMLElement>("#preview-reload-status");
  if (status) status.textContent = state === "hidden" ? "" : RELOAD_NOTICE_MESSAGES[state];
  if (retry) retry.hidden = state !== "gave-up";
}

// Whether the notice is up, i.e. the render on screen is one a failed reload
// kept.
export function reloadNoticeShown(): boolean {
  const notice = document.querySelector<HTMLElement>("#preview-reload-notice");
  return notice !== null && !notice.hidden;
}

// What the index says about a file, to tell whether a load that lands after
// a failed reload brings an on-disk change (and so pulses Updated).
export type FileStamp = { epoch: string | null; revision: number | undefined; mtimeMs: number };

// Within one session the index revision advances with every change, even one
// that kept the modification time. A restarted session starts its revision
// counter over, so across sessions only the modification time can tell.
export function fileChanged(shown: FileStamp | null, now: FileStamp | null): boolean {
  if (!shown || !now) return shown !== now;
  if (shown.epoch === now.epoch) return shown.revision !== now.revision;
  return shown.mtimeMs !== now.mtimeMs;
}
