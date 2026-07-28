// The find engine for the preview: match over the flattened document text,
// paint with the Custom Highlight API, scroll the shell.
//
// Holds no DOM references across a content swap. The preview is replaced
// wholesale on every live reload and view-mode switch, so every run rebuilds
// the index from scratch.

import {
  clearHighlights,
  ensureShadowHighlightStyles,
  paintMatches,
  revealRange,
} from "./highlight";
import type { FindEngine, FindOutcome } from "./engine";
import { findMatches, nearestSpan, stepIndex, type MatchOptions } from "./matcher";
import { buildTextIndex, locateSpan, toRange, type TextSpan } from "./text-index";

export function createPreviewEngine(
  previewElement: HTMLElement,
  shellElement: HTMLElement,
  barSlot: HTMLElement,
): FindEngine {
  let spans: TextSpan[] = [];
  let ranges: Range[] = [];
  let currentIndex = -1;
  let truncated = false;
  let onOutcome: ((outcome: FindOutcome) => void) | null = null;
  let observer: MutationObserver | null = null;

  const emit = (error: string | null): void => {
    onOutcome?.({ total: spans.length, index: currentIndex, truncated, error });
  };

  const paint = (reveal: boolean): void => {
    paintMatches(ranges, currentIndex);
    if (reveal && currentIndex >= 0) {
      revealRange(ranges[currentIndex]!, shellElement);
    }
  };

  const reset = (): void => {
    spans = [];
    ranges = [];
    currentIndex = -1;
    truncated = false;
  };

  return {
    barHost: () => barSlot,
    label: "document",

    run(query, options, opts) {
      // Where the reader currently is, so a re-run after a live reload lands
      // near it rather than snapping to the top of the document.
      const anchor = currentIndex >= 0 ? spans[currentIndex]?.start ?? null : null;
      // Indexing `#preview` covers split layouts for free: both panes are its
      // children, so their text concatenates in document order and matches
      // come out as one ordered sequence across the pair.
      const index = buildTextIndex(previewElement);
      const result = findMatches(index.text, query, options);

      if (!result.ok) {
        reset();
        clearHighlights();
        emit(result.error);
        return;
      }

      reset();
      // Matches inside a shadow tree (the Diff view renders into one) need the
      // highlight rules present in that tree to paint at all.
      ensureShadowHighlightStyles(index.shadowRoots);
      truncated = result.truncated;
      for (const span of result.spans) {
        const located = locateSpan(index, span);
        if (located) {
          spans.push(span);
          ranges.push(toRange(located, previewElement.ownerDocument));
        }
      }
      currentIndex = spans.length === 0 ? -1 : nearestSpan(spans, anchor ?? 0);
      paint(opts.reveal);
      emit(null);
    },

    step(delta) {
      if (spans.length === 0) {
        return;
      }
      currentIndex = stepIndex(currentIndex, spans.length, delta);
      paint(true);
      emit(null);
    },

    clear() {
      reset();
      clearHighlights();
    },

    focusSurface() {
      const landing = currentIndex >= 0 ? ranges[currentIndex] ?? null : null;
      shellElement.focus({ preventScroll: true });
      if (landing) {
        revealRange(landing, shellElement);
      }
    },

    setOnOutcome(listener) {
      onOutcome = listener;
    },

    // Watch for the preview being replaced.
    //
    // The design originally called for hooking the mount lifecycle directly,
    // assuming one mount point. There are eight — the single and split
    // document paths plus diff, image, binary, empty, commit-message, and the
    // review-score explanation — and each would have to import find and
    // remember to call it. One observer cannot be forgotten by a ninth, and it
    // is connected only while the bar is open.
    watch(onChanged) {
      if (observer) {
        return;
      }
      observer = new MutationObserver(() => {
        // `diff.ts` clears then appends: two records, one logical swap.
        queueMicrotask(onChanged);
      });
      // Subtree-wide, and `open` toggles specifically: the index excludes the
      // collapsed body of a closed `<details>` (metadata card), so disclosing
      // one changes what is searchable and the run must repeat. Re-running
      // paints via `CSS.highlights` without touching the DOM, so the observer
      // cannot feed itself.
      observer.observe(previewElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["open"],
      });
    },

    unwatch() {
      observer?.disconnect();
      observer = null;
    },
  };
}

export type { MatchOptions };
