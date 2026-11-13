/** The dock reports one measured border-box height. Surface owners keep their
 * own viewport/scroll/PTY lifecycle and reserve this scalar in their geometry. */
export const MEDIA_LAYOUT_EVENT = "uatu:media-layout";

export function mediaDockHeight(): number {
  if (typeof document === "undefined") return 0;
  return Number.parseFloat(document.documentElement.style.getPropertyValue("--media-dock-height")) || 0;
}

export function mediaLayoutGeometry(layoutHeight: number, visualHeight: number, visualTop: number, tabHeight: number, dockHeight: number) {
  const occluded = Math.max(0, layoutHeight - visualTop - visualHeight);
  const tabInset = Math.max(0, tabHeight - occluded);
  return {
    occluded, tabInset,
    dockBottom: occluded + tabInset,
    bottomInset: occluded + tabInset + dockHeight,
    usableHeight: Math.max(0, visualHeight - tabInset - dockHeight),
  };
}
