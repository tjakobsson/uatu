// Commit ages in the Git Log and the commit preview. Each age is a <time>
// element carrying its commit time, so one ticker can keep every visible age
// current by rewriting text in place: no rebuilt rows, no server request.
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import { commitAgeRefreshMs, formatCommitAge } from "../shared/relative-time";
import type { CommitLogEntry } from "../shared/types";

const AGE_SELECTOR = "time.commit-age[data-committed-at]";

function ageHtml(commit: CommitLogEntry, nowMs: number): string {
  if (commit.committedAtMs === null || !Number.isFinite(commit.committedAtMs)) {
    // An older workspace build sends only Git's text.
    return commit.relativeTime ? escapeHtml(commit.relativeTime) : "";
  }
  const iso = new Date(commit.committedAtMs).toISOString();
  return `<time class="commit-age" datetime="${escapeHtmlAttribute(iso)}" data-committed-at="${commit.committedAtMs}">${escapeHtml(formatCommitAge(commit.committedAtMs, nowMs))}</time>`;
}

// "author · age", either part optional.
export function commitBylineHtml(commit: CommitLogEntry, nowMs = Date.now()): string {
  return [commit.author ? escapeHtml(commit.author) : "", ageHtml(commit, nowMs)].filter(Boolean).join(" · ");
}

// Rewrites every rendered age whose text has moved on. Returns the delay
// until the next redraw is due, or null when no age is on the page.
export function refreshCommitAges(root: ParentNode = document, nowMs = Date.now()): number | null {
  let next: number | null = null;
  for (const element of root.querySelectorAll<HTMLTimeElement>(AGE_SELECTOR)) {
    const committedAt = Number(element.dataset.committedAt);
    if (!Number.isFinite(committedAt)) continue;
    const text = formatCommitAge(committedAt, nowMs);
    if (element.textContent !== text) element.textContent = text;
    const delay = commitAgeRefreshMs(committedAt, nowMs);
    next = next === null ? delay : Math.min(next, delay);
  }
  return next;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function schedule(delay: number | null) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (document.hidden) return;
  // With nothing on the page yet, look again at the slow cadence; renders in
  // between call commitAgesRendered() to pull the next tick in.
  timer = setTimeout(tick, delay ?? commitAgeRefreshMs(0, Date.now()));
}

// Runs from the timer and directly (a render, the page becoming visible);
// schedule() clears whichever timer is pending, so none is ever orphaned.
function tick() {
  schedule(refreshCommitAges());
}

// One ticker for the page. Paused while the document is hidden; catching up
// on return is a single pass.
export function startCommitAgeTicker(): void {
  if (started) return;
  started = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) schedule(null);
    else tick();
  });
  tick();
}

// Called after a render adds ages, so a young commit's age starts moving on
// the fast cadence even if the ticker was sleeping on the slow one.
export function commitAgesRendered(): void {
  if (started) tick();
}
