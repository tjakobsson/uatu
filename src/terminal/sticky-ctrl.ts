// Sticky Ctrl for the touch keybar: software keyboards have no Ctrl key, so
// the keybar's `ctrl` button arms a single-shot latch and the next printable
// character typed is composed to its control byte before reaching the PTY.
//
// The latch is a tiny observable controller (the keybar button renders its
// armed state); the composition itself is a pure function wired into the
// client's input path. When unarmed it MUST be an identity pass-through —
// it sits on the path every keystroke travels.

export type StickyCtrlController = {
  isArmed(): boolean;
  // Tap semantics: arm when idle, cancel when armed.
  toggle(): void;
  disarm(): void;
  onChange(listener: (armed: boolean) => void): void;
};

export function createStickyCtrl(): StickyCtrlController {
  let armed = false;
  let listener: ((armed: boolean) => void) | null = null;

  function set(next: boolean): void {
    if (armed === next) return;
    armed = next;
    listener?.(armed);
  }

  return {
    isArmed: () => armed,
    toggle: () => set(!armed),
    disarm: () => set(false),
    onChange(next) {
      listener = next;
    },
  };
}

export type StickyCtrlResult = {
  output: string;
  // True when the latch fired and should be released by the caller.
  composed: boolean;
};

// Compose one onData chunk against the latch. Only a single printable ASCII
// letter/char composes (the normal software-keyboard keystroke shape);
// multi-character chunks (paste, IME commits, escape sequences) pass through
// untouched so the latch can never corrupt them — it stays armed for the
// next real keystroke.
export function composeStickyCtrl(armed: boolean, data: string): StickyCtrlResult {
  if (!armed) return { output: data, composed: false };
  if (data.length !== 1) return { output: data, composed: false };
  const code = data.toUpperCase().charCodeAt(0);
  // `@` through `_` map to 0x00–0x1f; letters are the useful subset but the
  // full C0 range matches how real Ctrl chords behave.
  if (code < 0x40 || code > 0x5f) return { output: data, composed: false };
  return { output: String.fromCharCode(code & 0x1f), composed: true };
}
