// Chat's way into the shared fullscreen media viewer (src/zoom/viewer.ts), for
// attachment thumbnails and assistant visuals alike.
//
// A source arrives through the DOM (an attribute or an image's `src`), so it
// is re-validated against the only two shapes chat ever writes there: a staged
// `blob:` preview and the workspace's own serve routes. Anything else never
// reaches the viewer.

import { viewerFocusReturn } from "../zoom/inline";
import type { Size } from "../zoom/transform";
import { openMediaViewer } from "../zoom/viewer";

export function chatMediaSource(source: string, pageUrl: string): string | null {
  let resolved: URL;
  try {
    resolved = new URL(source, pageUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "blob:" && resolved.origin !== new URL(pageUrl).origin) return null;
  return resolved.href;
}

export type ChatMedia = {
  source: string;
  // The attachment's file name or the visual's alt text: the image's text
  // alternative, and the viewer's visible caption, as chat has always shown.
  name: string;
  kind: "raster" | "svg-image";
  // The control that opened the viewer: focus returns to it, or for a visual
  // to its media and then its expand control (`viewerFocusReturn`).
  opener: HTMLElement;
  // The laid-out size, for an SVG that reports no intrinsic size.
  fallbackSize?: Size;
};

// Opens nothing for a source that fails the check.
export function openChatMedia(media: ChatMedia): void {
  const src = chatMediaSource(media.source, window.location.href);
  if (!src) return;
  const focus = viewerFocusReturn(media.opener);
  openMediaViewer(
    { kind: media.kind, src, alt: media.name, caption: media.name, fallbackSize: media.fallbackSize },
    {
      returnFocusTo: focus.returnFocusTo,
      afterClose: () => {
        focus.afterReturn();
        blurRestoredTimeline();
      },
    },
  );
}

// The dialog's own focus restoration targets whatever held focus before it
// opened. A pointer flow in Safari focuses the tabindex="0" log, not the
// thumbnail, and a focus restored there paints a ring around the whole
// conversation. Blurring only the container is safe: a keyboard flow returns
// to the opener itself, which keeps its own focus ring.
function blurRestoredTimeline(): void {
  const restored = document.activeElement;
  if (restored instanceof HTMLElement && restored.classList.contains("chat-timeline")) restored.blur();
}
