// Delay-gated loading signal for slow diff preparation (issue #104). Two
// layers: the triggering segment button goes busy immediately (an honest
// "the click registered"), and an indeterminate bar overlays the top of
// the preview shell only when the wait exceeds a show delay — so fast
// diffs stay flash-free and the "no empty-state flash" rule survives.
// Once shown, the bar stays for a minimum visible window to avoid a
// blink on borderline-fast responses.
//
// The bar is injected as a zero-height sticky wrapper so it never shifts
// layout and never hides the previous view's content underneath.

export const LOADING_SHOW_DELAY_MS = 200;
export const LOADING_MIN_VISIBLE_MS = 300;

export type LoadingSignalOptions = {
  // The segment button that triggered the work (e.g. the Diff chooser
  // segment). Null-safe so callers don't have to guard missing chrome.
  segment: HTMLElement | null;
  // Container the indicator bar is prepended to (the preview shell).
  barHost: HTMLElement;
  showDelayMs?: number;
  minVisibleMs?: number;
};

export type LoadingSignal = {
  // Mark work as started: segment goes busy now, bar appears after the
  // show delay if the work hasn't settled by then. Re-entrant — a second
  // start() while active keeps the existing timers/bar.
  start(): void;
  // Mark work as finished (success or failure): segment un-busies now,
  // the bar honors its minimum visible window before disappearing.
  settle(): void;
};

export function createLoadingSignal(options: LoadingSignalOptions): LoadingSignal {
  const showDelayMs = options.showDelayMs ?? LOADING_SHOW_DELAY_MS;
  const minVisibleMs = options.minVisibleMs ?? LOADING_MIN_VISIBLE_MS;

  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let bar: HTMLElement | null = null;
  let shownAtMs = 0;
  let active = false;

  const showBar = (): void => {
    if (bar) return;
    const wrapper = document.createElement("div");
    wrapper.className = "uatu-loading-bar";
    wrapper.setAttribute("role", "progressbar");
    wrapper.setAttribute("aria-label", "Loading diff");
    const fill = document.createElement("div");
    fill.className = "uatu-loading-bar-fill";
    wrapper.appendChild(fill);
    options.barHost.insertBefore(wrapper, options.barHost.firstChild);
    bar = wrapper;
    shownAtMs = Date.now();
  };

  const removeBar = (): void => {
    bar?.remove();
    bar = null;
  };

  return {
    start(): void {
      active = true;
      if (hideTimer !== null) {
        // New work started while the previous bar was in its minimum
        // window: keep the bar up as one continuous indication.
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      options.segment?.setAttribute("aria-busy", "true");
      options.segment?.classList.add("is-loading");
      if (bar === null && showTimer === null) {
        showTimer = setTimeout(() => {
          showTimer = null;
          if (active) showBar();
        }, showDelayMs);
      }
    },

    settle(): void {
      active = false;
      if (showTimer !== null) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      options.segment?.removeAttribute("aria-busy");
      options.segment?.classList.remove("is-loading");
      if (bar !== null && hideTimer === null) {
        const remainingMs = Math.max(0, minVisibleMs - (Date.now() - shownAtMs));
        if (remainingMs === 0) {
          removeBar();
        } else {
          hideTimer = setTimeout(() => {
            hideTimer = null;
            if (!active) removeBar();
          }, remainingMs);
        }
      }
    },
  };
}
