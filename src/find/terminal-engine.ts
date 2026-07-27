// The find engine for the embedded terminal.
//
// xterm owns its buffer — it is a canvas, not DOM, so the text index and the
// Custom Highlight API cannot reach it. The search addon is the only route in,
// and it happens to speak the same language as the preview matcher: the same
// three options, and an index/total pair for the counter.
//
// Scoped to the focused pane. The panel supports splits, and searching the
// pane you are not looking at would be a strange thing to offer.

import type { FindEngine, FindOutcome } from "./engine";
import type { MatchOptions } from "./matcher";

// What a terminal pane must provide to be searchable. Kept structural so this
// module does not depend on the terminal's own types, and so the panel can
// hand over whichever pane currently has focus.
export type TerminalSearchTarget = {
  findNext(query: string, options: MatchOptions): void;
  findPrevious(query: string, options: MatchOptions): void;
  clear(): void;
  focus(): void;
  onResults(listener: ((outcome: { index: number; total: number }) => void) | null): void;
};

export function createTerminalEngine(
  resolveTarget: () => TerminalSearchTarget | null,
  resolveBarSlot: () => HTMLElement | null,
): FindEngine {
  let onOutcome: ((outcome: FindOutcome) => void) | null = null;
  let subscribed: TerminalSearchTarget | null = null;

  // Re-point the result subscription at whichever pane is being searched now.
  const bind = (target: TerminalSearchTarget | null): TerminalSearchTarget | null => {
    if (subscribed === target) {
      return target;
    }
    subscribed?.onResults(null);
    subscribed = target;
    subscribed?.onResults(({ index, total }) => {
      // The addon reports index -1 when its highlight threshold is exceeded;
      // that is the same situation the preview calls truncation, so it is
      // surfaced the same way rather than as an error.
      onOutcome?.({
        total,
        index,
        truncated: total > 0 && index === -1,
        error: null,
      });
    });
    return subscribed;
  };

  return {
    barHost: resolveBarSlot,
    label: "terminal",

    run(query, options) {
      const target = bind(resolveTarget());
      if (!target) {
        onOutcome?.({ total: 0, index: -1, truncated: false, error: null });
        return;
      }
      if (query.length === 0) {
        target.clear();
        onOutcome?.({ total: 0, index: -1, truncated: false, error: null });
        return;
      }
      // Searching must never reach the PTY: this only reads the buffer and
      // moves xterm's own selection. No input is written, so a running
      // program is unaffected.
      target.findNext(query, options);
    },

    step(delta, query, options) {
      const target = bind(resolveTarget());
      if (!target || query.length === 0) {
        return;
      }
      if (delta < 0) {
        target.findPrevious(query, options);
      } else {
        target.findNext(query, options);
      }
    },

    clear() {
      subscribed?.clear();
      subscribed?.onResults(null);
      subscribed = null;
    },

    focusSurface() {
      resolveTarget()?.focus();
    },

    setOnOutcome(listener) {
      onOutcome = listener;
    },
  };
}
