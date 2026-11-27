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
// image and media bodies they mount), empty.ts and commit-message.ts do it
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
  if (retry) retry.hidden = state !== "gave-up";
}
