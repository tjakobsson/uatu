// Preview text-size stepper (touch devices). Pinch zoom scales the whole
// layout; this is a text-size change — the scale lands on .markdown-body's
// absolute 16px base (styles.css) so the document reflows to the viewport.
// Steps are a bounded ladder persisted per device; chrome is untouched.
//
// The step math is pure so bounds/persistence are unit-testable; the init
// half wires the two action-bar buttons (CSS-shown on coarse pointers only).

import { presentationLocalStorage } from "../shell/presentation-storage";

export const PREVIEW_TEXT_SIZE_KEY = "uatu:preview-text-step";

// ~85% to ~150% in seven steps; index 2 (1.0) is the default.
export const PREVIEW_TEXT_SCALES: readonly number[] = [0.85, 0.92, 1, 1.1, 1.2, 1.35, 1.5];
export const PREVIEW_TEXT_DEFAULT_STEP = PREVIEW_TEXT_SCALES.indexOf(1);

export function clampPreviewTextStep(step: number): number {
  if (!Number.isFinite(step)) return PREVIEW_TEXT_DEFAULT_STEP;
  return Math.max(0, Math.min(PREVIEW_TEXT_SCALES.length - 1, Math.round(step)));
}

export function readPreviewTextStep(storage: {
  getItem(key: string): string | null;
} | null): number {
  try {
    const raw = storage?.getItem(PREVIEW_TEXT_SIZE_KEY);
    if (raw === null || raw === undefined) return PREVIEW_TEXT_DEFAULT_STEP;
    return clampPreviewTextStep(Number(raw));
  } catch {
    return PREVIEW_TEXT_DEFAULT_STEP;
  }
}

export function initPreviewTextSize(): void {
  const preview = document.getElementById("preview");
  const decrease = document.getElementById("preview-text-decrease") as HTMLButtonElement | null;
  const increase = document.getElementById("preview-text-increase") as HTMLButtonElement | null;
  if (!preview || !decrease || !increase) return;

  let step = readPreviewTextStep(presentationLocalStorage());

  function apply(): void {
    const scale = PREVIEW_TEXT_SCALES[step]!;
    if (scale === 1) {
      preview!.style.removeProperty("--preview-text-scale");
    } else {
      preview!.style.setProperty("--preview-text-scale", String(scale));
    }
    // At-limit state: disabled communicates it to both pointer and AT users.
    decrease!.disabled = step === 0;
    increase!.disabled = step === PREVIEW_TEXT_SCALES.length - 1;
  }

  function stepBy(delta: number): void {
    const next = clampPreviewTextStep(step + delta);
    if (next === step) return;
    step = next;
    apply();
    try {
      presentationLocalStorage()?.setItem(PREVIEW_TEXT_SIZE_KEY, String(step));
    } catch {
      // Ignore storage failures (private mode, quota, etc.).
    }
  }

  decrease.addEventListener("click", () => stepBy(-1));
  increase.addEventListener("click", () => stepBy(1));
  apply();
}
