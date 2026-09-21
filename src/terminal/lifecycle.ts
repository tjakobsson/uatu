// Page-lifecycle coalescing for the terminal panel: when the document is
// being hidden for good or frozen (`pagehide`), every pane releases its
// transport; when the document runs again (`pageshow`, or a return to the
// foreground on platforms that resume without one), every released pane
// resumes exactly once. Presentation — visibility, pane records, layout —
// is untouched: a release is not a hide, and a resume is not a show.
//
// Both `persisted` values of `pagehide` are treated as resumable. The
// browser may keep the document alive without promising a history-cache
// restore (iOS standalone pages do this), and a document that really unloads
// takes its listeners with it, so nothing is lost by staying armed.
//
// An ordinary background tab — `visibilitychange` to hidden without a
// `pagehide` — does not release anything: a healthy terminal in a tab the
// user glanced away from keeps its shell attached, exactly as before.
// Only a document that was suspended resumes on the way back, so a
// `pageshow` + `visibilitychange` burst on wake-up performs one resume.

export type LifecycleEventTarget = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
};

export type PanelLifecycle = {
  // Whether the document is currently suspended.
  suspended(): boolean;
  dispose(): void;
};

export function createPanelLifecycle(options: {
  win: LifecycleEventTarget;
  doc: LifecycleEventTarget & { visibilityState?: string };
  release(): void;
  resume(): void;
}): PanelLifecycle {
  let suspended = false;

  const suspend = () => {
    if (suspended) return;
    suspended = true;
    options.release();
  };
  const wake = () => {
    if (!suspended) return;
    suspended = false;
    options.resume();
  };

  const onPageHide = () => suspend();
  const onPageShow = () => wake();
  const onVisibility = () => {
    if (options.doc.visibilityState === "visible") wake();
  };

  options.win.addEventListener("pagehide", onPageHide);
  options.win.addEventListener("pageshow", onPageShow);
  options.doc.addEventListener("visibilitychange", onVisibility);

  return {
    suspended: () => suspended,
    dispose() {
      options.win.removeEventListener("pagehide", onPageHide);
      options.win.removeEventListener("pageshow", onPageShow);
      options.doc.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
