// Alternate-screen touch scrolling. xterm's viewport touch-scrolls the
// normal buffer's scrollback natively, but full-screen TUIs run on the
// alternate buffer — no scrollback, so swipes hit nothing. This is the
// touch analogue of wheel alternate-scroll (DECSET 1007): vertical swipe
// distance, quantized by cell height, becomes repeated arrow-key sequences.
//
// Pure function + carry accumulator so sub-cell finger movement between
// touchmove events is never lost and the translation is fully unit-testable.

// A gesture only becomes a scroll once it moves far enough to have a clear
// orientation. Before the threshold it is "pending" (leave the event alone);
// a horizontal-dominant move is "ignore" for the rest of the gesture, so
// selection-handle drags and horizontal swipes keep their native behavior
// and small jitter never sends arrow spam.
export type SwipeGestureMode = "pending" | "scroll" | "ignore";

export const SWIPE_GESTURE_THRESHOLD_PX = 8;

export function classifySwipeGesture(
  totalDeltaX: number,
  totalDeltaY: number,
  threshold: number = SWIPE_GESTURE_THRESHOLD_PX,
): SwipeGestureMode {
  if (Math.hypot(totalDeltaX, totalDeltaY) < threshold) return "pending";
  return Math.abs(totalDeltaY) > Math.abs(totalDeltaX) ? "scroll" : "ignore";
}

// Normalize a WheelEvent's deltaY to CSS pixels so it can feed the same
// cell-quantized translation as touch. deltaMode: 0 = pixels, 1 = lines
// (multiply by cell height), 2 = pages (multiply by the viewport height).
export function wheelDeltaToPixels(
  deltaY: number,
  deltaMode: number,
  cellHeight: number,
  pageHeight: number,
): number {
  if (deltaMode === 1) return deltaY * cellHeight;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}

// Matches wheel semantics: finger moving UP (negative deltaY) pulls content
// up — the same direction wheel-down scrolls — so it emits arrow-DOWN.
export type SwipeTranslation = {
  sequences: string;
  // Remaining sub-cell distance to feed into the next call.
  carry: number;
};

export function swipeToArrowSequences(options: {
  // Finger movement since the last event, in CSS pixels (current - previous).
  deltaY: number;
  cellHeight: number;
  // DECCKM: application cursor keys use SS3 (\x1bO_), normal mode CSI (\x1b[_).
  applicationCursor: boolean;
  carry: number;
}): SwipeTranslation {
  const { deltaY, cellHeight, applicationCursor, carry } = options;
  if (!(cellHeight > 0)) return { sequences: "", carry: 0 };
  const total = carry + deltaY;
  const cells = Math.trunc(total / cellHeight);
  const nextCarry = total - cells * cellHeight;
  if (cells === 0) return { sequences: "", carry: nextCarry };
  const prefix = applicationCursor ? "\x1bO" : "\x1b[";
  // Finger down (positive delta) = wheel up = arrow up (A); finger up = B.
  const letter = cells > 0 ? "A" : "B";
  const sequence = prefix + letter;
  return { sequences: sequence.repeat(Math.abs(cells)), carry: nextCarry };
}
