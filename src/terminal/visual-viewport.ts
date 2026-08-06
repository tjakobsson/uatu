// Visible-viewport sizing for the phone-fullscreen terminal. iOS overlays
// the software keyboard on the layout viewport, so a 100dvh panel keeps its
// bottom half — including the prompt line — hidden behind the keyboard.
// `window.visualViewport` is the only cross-WebKit signal for the actually
// visible region; while phone-fullscreen the panel is sized from it and
// xterm refits on every change.
//
// Kept as a factory over a `VisualViewportLike` so the attach/detach
// lifecycle and height propagation are unit-testable without a browser.

export type VisualViewportLike = {
  readonly height: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
};

export type VisualViewportSizer = {
  // Idempotent. Emits the current height immediately on first attach so the
  // panel is correct before any event fires.
  attach(): void;
  // Idempotent. Emits null so the consumer clears its override and falls
  // back to the CSS (dvh) height.
  detach(): void;
  isAttached(): boolean;
};

export function createVisualViewportSizer(options: {
  viewport: VisualViewportLike | null;
  // height in CSS pixels while attached; null on detach (clear override).
  onHeight(height: number | null): void;
}): VisualViewportSizer {
  const { viewport, onHeight } = options;
  let attached = false;

  const emit = () => {
    if (!viewport) return;
    onHeight(viewport.height);
  };

  return {
    attach() {
      if (attached || !viewport) return;
      attached = true;
      // Both events matter: iOS fires `resize` for keyboard show/hide and
      // `scroll` when the visual viewport pans while zoomed or while the
      // keyboard animates.
      viewport.addEventListener("resize", emit);
      viewport.addEventListener("scroll", emit);
      emit();
    },
    detach() {
      if (!attached || !viewport) return;
      attached = false;
      viewport.removeEventListener("resize", emit);
      viewport.removeEventListener("scroll", emit);
      onHeight(null);
    },
    isAttached: () => attached,
  };
}
