// File facts strip — the one-line repo-derived summary framing Source and
// Diff views (never Rendered, where the frontmatter metadata card serves the
// reading posture). Also owns the on-disk-change signal: a pulse on the
// strip's freshness segment in Source/Diff, a transient "Updated" chip in
// the preview header in Rendered.
//
// Pure HTML builders and formatters are exported for unit tests; DOM lookups
// happen lazily inside the sync functions so importing this module doesn't
// require the full page skeleton.

import { escapeHtml } from "../shared/html";
import type { FileFacts } from "../shared/types";
import { appState } from "../shell/state";

export type FactsStripState =
  | { kind: "hidden" }
  // Source view — facts may be missing if server-side collection failed.
  | { kind: "source"; facts: FileFacts | undefined }
  // Diff view — counts are null for unchanged/binary/no-git diff payloads.
  | {
      kind: "diff";
      facts: FileFacts | undefined;
      baseRef: string | null;
      added: number | null;
      deleted: number | null;
    };

// --- formatting -------------------------------------------------------------

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${unit}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Relative time for the freshness segment ("modified 2m ago"). Beyond a week
// it degrades to the absolute date — "modified 94d ago" reads worse than the
// date itself.
export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "";
  }
  const delta = Math.max(0, nowMs - then);
  if (delta < MINUTE_MS) {
    return "just now";
  }
  if (delta < HOUR_MS) {
    return `${Math.floor(delta / MINUTE_MS)}m ago`;
  }
  if (delta < DAY_MS) {
    return `${Math.floor(delta / HOUR_MS)}h ago`;
  }
  if (delta < 7 * DAY_MS) {
    return `${Math.floor(delta / DAY_MS)}d ago`;
  }
  return formatAbsoluteDate(iso);
}

export function formatAbsoluteDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// --- pure HTML builder ------------------------------------------------------

function segment(html: string, extraClass = ""): string {
  const classAttr = extraClass ? ` class="${extraClass}"` : "";
  return `<span${classAttr}>${html}</span>`;
}

function joinSegments(segments: string[]): string {
  return segments.filter(Boolean).join(`<span class="file-facts-sep">·</span>`);
}

// The freshness segment: last-commit date when clean, "modified <rel> ·
// uncommitted" when the working tree differs from HEAD (or the file was
// never committed). Wrapped in a stable class so the update signal can
// target it.
function freshnessSegment(facts: FileFacts, nowMs: number): string {
  const git = facts.git;
  if (git && !git.dirty && git.authoredAt) {
    return segment(formatAbsoluteDate(git.authoredAt), "file-facts-freshness");
  }
  const relative = formatRelativeTime(facts.mtime, nowMs);
  const marker = git ? ` <span class="file-facts-uncommitted">uncommitted</span>` : "";
  return segment(
    `modified ${relative}${marker}`,
    "file-facts-freshness",
  );
}

// Server-side facts strings (author, sha) arrive pre-escaped; everything
// composed client-side (baseRef, numbers, formatted dates) is escaped or
// numeric here.
export function renderFileFactsStripHtml(state: FactsStripState, nowMs: number): string {
  if (state.kind === "hidden") {
    return "";
  }

  if (state.kind === "source") {
    const facts = state.facts;
    if (!facts) {
      return "";
    }
    const git = facts.git;
    const lines = `${facts.lines} ${facts.lines === 1 ? "line" : "lines"}`;
    const size = formatByteSize(facts.bytes);
    return joinSegments([
      git?.author ? segment(git.author, "file-facts-author") : "",
      freshnessSegment(facts, nowMs),
      git?.shortSha ? segment(git.shortSha, "file-facts-sha") : "",
      segment(lines),
      segment(size),
    ]);
  }

  const facts = state.facts;
  const counts =
    state.added !== null && state.deleted !== null
      ? `<span class="file-facts-added">+${state.added}</span> <span class="file-facts-removed">−${state.deleted}</span>`
      : "";
  return joinSegments([
    state.baseRef ? segment(`vs ${escapeHtml(state.baseRef)}`) : "",
    counts ? segment(counts) : "",
    facts?.git?.author ? segment(facts.git.author, "file-facts-author") : "",
    facts?.git?.shortSha ? segment(facts.git.shortSha, "file-facts-sha") : "",
  ]);
}

// --- DOM sync ---------------------------------------------------------------

function stripElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#file-facts-strip");
}

function updatedChipElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#preview-updated");
}

export function syncFileFactsStrip(state: FactsStripState): void {
  const strip = stripElement();
  if (!strip) {
    return;
  }
  const html = renderFileFactsStripHtml(state, Date.now());
  if (!html) {
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }
  strip.innerHTML = html;
  strip.hidden = false;
}

export function hideFileFactsStrip(): void {
  const strip = stripElement();
  if (strip) {
    strip.hidden = true;
    strip.innerHTML = "";
  }
  clearUpdateSignal();
}

// --- on-disk-change signal --------------------------------------------------

// How long the signal stays lit after the LAST file event. Trailing-edge:
// every event resets the timer, so rapid successive writes keep the signal
// continuously lit (no strobing) and it settles once events stop.
export const UPDATE_SIGNAL_MS = 3000;

export type TrailingSignal = {
  fire(): void;
  clear(): void;
};

// Small trailing-edge latch, extracted for unit testing. `onChange(true)`
// fires on the first event of a burst; `onChange(false)` fires once the
// burst has been quiet for `durationMs` (or on clear()).
export function createTrailingSignal(
  durationMs: number,
  onChange: (active: boolean) => void,
  // Arrow wrappers, not bare references: browsers require setTimeout to be
  // invoked with `this === window`, and `schedule.set(...)` would otherwise
  // call it with `this === schedule` — an Illegal invocation TypeError.
  schedule: { set: typeof setTimeout; clear: typeof clearTimeout } = {
    set: ((callback: () => void, ms: number) => setTimeout(callback, ms)) as typeof setTimeout,
    clear: (id => clearTimeout(id)) as typeof clearTimeout,
  },
): TrailingSignal {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  return {
    fire() {
      if (timer !== null) {
        schedule.clear(timer);
      }
      if (!active) {
        active = true;
        onChange(true);
      }
      timer = schedule.set(() => {
        timer = null;
        active = false;
        onChange(false);
      }, durationMs);
    },
    clear() {
      if (timer !== null) {
        schedule.clear(timer);
        timer = null;
      }
      if (active) {
        active = false;
        onChange(false);
      }
    },
  };
}

const updateSignal = createTrailingSignal(UPDATE_SIGNAL_MS, active => {
  const strip = stripElement();
  if (strip) {
    strip.classList.toggle("is-updated", active);
  }
  const chip = updatedChipElement();
  if (chip) {
    // The chip is a Rendered-view affordance; Source/Diff get the strip
    // pulse instead. Evaluated per transition so a view flip mid-burst
    // doesn't leave the wrong indicator lit.
    chip.hidden = !(active && appState.viewMode === "rendered");
  }
});

// Called from the SSE file-event path after the active document reloaded in
// place. The class lands on the strip container (not its innerHTML), so the
// re-render that accompanies the reload doesn't wipe an in-flight signal.
export function signalActiveDocumentUpdated(): void {
  updateSignal.fire();
}

export function clearUpdateSignal(): void {
  updateSignal.clear();
}
