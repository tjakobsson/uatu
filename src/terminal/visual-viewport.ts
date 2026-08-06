// Visible-viewport sizing for the phone-fullscreen terminal. iOS overlays
// the software keyboard on the layout viewport, so a 100dvh panel keeps its
// bottom half — including the prompt line — hidden behind the keyboard.
// `window.visualViewport` is the only cross-WebKit signal for the actually
// visible region; while phone-fullscreen the panel is sized from it and
// xterm refits on every change.
//
// Both height AND offsetTop matter: when iOS pans the visual viewport while
// the keyboard is open (e.g. scrolling a bottom-anchored input into view),
// offsetTop goes nonzero and a fixed panel pinned to top: 0 would extend
// below the visible region by exactly that offset — resized but still
// keyboard-obscured. The consumer must position the panel at offsetTop as
// well as sizing it to height.
//
// Kept as a factory over a `VisualViewportLike` so the attach/detach
// lifecycle and metric propagation are unit-testable without a browser.

export type VisualViewportLike = {
  readonly height: number;
  readonly offsetTop: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
};

export type VisualViewportMetrics = {
  height: number;
  offsetTop: number;
};

export type VisualViewportSizer = {
  // Idempotent. Emits the current metrics immediately on first attach so the
  // panel is correct before any event fires.
  attach(): void;
  // Idempotent. Emits null so the consumer clears its overrides and falls
  // back to the CSS (dvh, top: 0) geometry.
  detach(): void;
  isAttached(): boolean;
};

export function createVisualViewportSizer(options: {
  viewport: VisualViewportLike | null;
  // Metrics in CSS pixels while attached; null on detach (clear overrides).
  onMetrics(metrics: VisualViewportMetrics | null): void;
}): VisualViewportSizer {
  const { viewport, onMetrics } = options;
  let attached = false;

  const emit = () => {
    if (!viewport) return;
    onMetrics({ height: viewport.height, offsetTop: viewport.offsetTop });
  };

  return {
    attach() {
      if (attached || !viewport) return;
      attached = true;
      // Both events matter: iOS fires `resize` for keyboard show/hide and
      // `scroll` when the visual viewport pans while zoomed or while the
      // keyboard animates — the pan is exactly what moves offsetTop.
      viewport.addEventListener("resize", emit);
      viewport.addEventListener("scroll", emit);
      emit();
    },
    detach() {
      if (!attached || !viewport) return;
      attached = false;
      viewport.removeEventListener("resize", emit);
      viewport.removeEventListener("scroll", emit);
      onMetrics(null);
    },
    isAttached: () => attached,
  };
}
