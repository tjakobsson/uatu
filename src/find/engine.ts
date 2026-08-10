// The contract between the find bar and whatever is being searched.
//
// One bar serves both surfaces. That was an open question in the design —
// whether the terminal needed its own control — and it resolved in favour of
// reuse once the xterm search addon turned out to take the same three options
// (case, whole-word, regex) and report the same two numbers (index, total)
// that the preview matcher does. Two bars would have been two vocabularies for
// one idea.
//
// Outcomes arrive by callback rather than return value because the two
// engines differ in timing: the preview matches synchronously, while xterm
// reports counts through an event after the search runs.

import type { MatchOptions } from "./matcher";

export type FindOutcome = {
  total: number;
  // Zero-based index of the current match, or -1 when there is none.
  index: number;
  truncated: boolean;
  // Non-null when the query itself is unusable (invalid regular expression).
  error: string | null;
};

export const NO_MATCHES: FindOutcome = { total: 0, index: -1, truncated: false, error: null };

export type FindEngine = {
  // Where the bar belongs while this engine is active, and what the query box
  // says it is searching. A control that searches the terminal while floating
  // over the document reads as searching the document — the bar has to sit on
  // the surface it acts on, and say which one that is.
  barHost(): HTMLElement | null;
  readonly label: string;

  // Run `query`, optionally scrolling the first match into view. Called on
  // every keystroke (debounced) and whenever the searched content changes.
  run(query: string, options: MatchOptions, opts: { reveal: boolean }): void;
  // Move by `delta` matches, wrapping at both ends.
  step(delta: number, query: string, options: MatchOptions): void;
  // Drop all highlighting. Must leave the surface exactly as it was found.
  clear(): void;
  // Hand keyboard focus back to the surface when the bar closes, so the
  // reader can keep scrolling without clicking first.
  focusSurface(): void;
  // Whether this engine can act right now. A surface can be the last one the
  // user touched and still have nothing to search — the terminal panel can be
  // hidden or closed with its panes detached — in which case find must fall
  // through rather than open a bar over nothing.
  isAvailable?(): boolean;
  // Bring this engine's surface forward, if it is not already showing.
  //
  // A surface can be the right target and still be invisible: touch mode
  // renders only the active tab, so `⌘F` from the Files tab routes to the
  // preview (correctly — directing the sidebar is an act about the document it
  // directs), suppresses the host's native find, and then mounts the bar
  // inside a `display: none` shell. The user is left with neither.
  //
  // It lives on the engine rather than at the shortcut because the shortcut is
  // not the only way in — the host bridge opens the bar too, and so would the
  // next entry point. The engine that owns a surface owns making it visible.
  revealSurface?(): void;
  // Called when this engine becomes / stops being the active one.
  setOnOutcome(listener: ((outcome: FindOutcome) => void) | null): void;
  // Start / stop watching for the searched content being replaced underneath
  // an open bar. Only the preview needs this; the terminal buffer is appended
  // to rather than swapped.
  watch?(onChanged: () => void): void;
  unwatch?(): void;
};
