// Explicit synchronization points for e2e tests, so a test waits for the
// event it depends on instead of a wall-clock guess that holds on an idle
// laptop and fails on a loaded CI runner.

import { expect, type Page } from "@playwright/test";

/**
 * Resolves after `count` animation frames in the page. Every rAF callback
 * the app registered before this call has run by then (callbacks run in
 * registration order), which is how a test waits out a "defer to the next
 * frame" in the app — the Mermaid viewer's fit, a deferred re-observation —
 * without guessing how long a frame takes.
 */
export async function afterAnimationFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(frames => new Promise<void>(resolve => {
    const step = (left: number): void => {
      if (left === 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(frames);
  }), count);
}

/**
 * Resolves once every request the page started before this call has been
 * reported to Playwright's `request` event. The page issues a sentinel fetch
 * and the barrier waits for Playwright to see it; request events reach the
 * test in the order the page issued them. Use it before asserting that
 * something did NOT fetch — after first awaiting whatever would have issued
 * the fetch.
 */
export async function flushPageRequests(page: Page): Promise<void> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sentinel = page.waitForRequest(request => request.url().includes(`e2eBarrier=${token}`));
  await page.evaluate(value => {
    void fetch(`/api/personal-state?e2eBarrier=${value}`).catch(() => undefined);
  }, token);
  await sentinel;
}

export type RecordedDocumentFrame = {
  generatedAt: number;
  changed: string | null;
  defaultPath: string | null;
  paths: string[];
};

/**
 * Records every `document` topic frame the page's live stream delivers, as
 * `window.__e2eDocumentFrames`. Observes the real transport (it only adds a
 * listener); install it BEFORE the page loads — it is an init script.
 */
export async function recordDocumentFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as { __e2eDocumentFrames?: unknown[] };
    if (scope.__e2eDocumentFrames) return;
    const frames: unknown[] = [];
    scope.__e2eDocumentFrames = frames;
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("live", event => {
          const frame = JSON.parse((event as MessageEvent).data);
          if (frame.topic !== "document" || frame.event?.kind !== "data") return;
          const state = frame.event.data as {
            generatedAt: number;
            changedId: string | null;
            defaultDocumentId: string | null;
            roots: { docs: { id: string; relativePath: string }[] }[];
          };
          const docs = state.roots.flatMap(root => root.docs);
          const pathOf = (id: string | null) => docs.find(doc => doc.id === id)?.relativePath ?? null;
          frames.push({
            generatedAt: state.generatedAt,
            changed: pathOf(state.changedId),
            defaultPath: pathOf(state.defaultDocumentId),
            paths: docs.map(doc => doc.relativePath),
          });
          if (frames.length > 100) frames.shift();
        });
      }
    };
  });
}

/**
 * Waits until the page has APPLIED a delivered document frame that matches:
 * one recorded by `recordDocumentFrames` whose generation the shell has
 * reached (`body[data-state-generated-at]`, stamped when a frame's state is
 * applied — a newer applied state counts too). Every field given must match.
 */
export async function waitForAppliedDocumentFrame(
  page: Page,
  match: { changed?: string; defaultPath?: string; includes?: string },
): Promise<void> {
  await expect.poll(() => page.evaluate(wanted => {
    const frames = (window as unknown as { __e2eDocumentFrames?: RecordedDocumentFrame[] }).__e2eDocumentFrames;
    if (!frames) return "frames are not being recorded (call recordDocumentFrames before the page loads)";
    const applied = Number(document.body.dataset.stateGeneratedAt ?? 0);
    const hit = frames.some(frame =>
      frame.generatedAt <= applied
      && (wanted.changed === undefined || frame.changed === wanted.changed)
      && (wanted.defaultPath === undefined || frame.defaultPath === wanted.defaultPath)
      && (wanted.includes === undefined || frame.paths.includes(wanted.includes)));
    return hit ? "applied" : `waiting (applied generation ${applied}, ${frames.length} frames seen)`;
  }, match), { message: `document frame ${JSON.stringify(match)} applied` }).toBe("applied");
}
