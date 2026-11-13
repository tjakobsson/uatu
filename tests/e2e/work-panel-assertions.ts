import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

/** Wait for the viewport controller's applied measurement, not an assumed
 * number of animation frames (which can stop in a stalled WebKit process). */
export async function expectWorkLayoutReady(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>("#chat-surface")!;
    const touch = document.documentElement.dataset.uiMode === "touch";
    const visual = window.visualViewport?.height ?? innerHeight;
    const top = window.visualViewport?.offsetTop ?? 0;
    const tab = document.querySelector<HTMLElement>("#touch-tab-bar")?.offsetHeight ?? 0;
    const covered = Math.max(0, innerHeight - top - visual);
    const expected = touch ? Math.max(0, visual - Math.max(0, tab - covered)) : surface.clientHeight;
    const actual = parseFloat(surface.style.getPropertyValue(touch ? "--chat-visual-height" : "--chat-panel-height"));
    return Math.abs(expected - actual) <= 1 ? true : { expected, actual: Number.isFinite(actual) ? actual : null, visibility: document.visibilityState };
  })).toBe(true);
}

/** Visibility alone admits controls clipped by a pane or covered by chrome. */
export async function expectWorkControlVisible(control: Locator) {
  await expect.poll(() => control.evaluate(node => {
    const box = node.getBoundingClientRect();
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
      const clip = parent.getBoundingClientRect();
      if (box.top < clip.top + parent.clientTop - 1 || box.bottom > clip.top + parent.clientTop + parent.clientHeight + 1) {
        return { clippedBy: parent.id || parent.className, box: box.toJSON(), clip: clip.toJSON() };
      }
    }
    const covered = [box.top + 1, box.bottom - 1].map(y => document.elementFromPoint(box.x + box.width / 2, y)).filter(hit => !node.contains(hit));
    return covered.length ? { coveredBy: covered.map(hit => hit ? `${hit.tagName}#${hit.id}.${hit.className}` : null), box: box.toJSON() } : true;
  })).toBe(true);
}

/** The reading floor yields only to measured, irreducible short-screen chrome,
 * not to the dock's current (potentially oversized) rendered height. */
export async function expectWorkTranscriptBudget(page: Page, visualHeight: number) {
  await expect.poll(() => page.evaluate(visualHeight => {
    const surface = document.querySelector<HTMLElement>("#chat-surface")!;
    const dock = document.querySelector<HTMLElement>("#chat-work-dock")!;
    const transcript = document.querySelector<HTMLElement>(".chat-transcript-area")!;
    const timeline = document.querySelector<HTMLElement>("#chat-timeline")!;
    const px = (value: string) => parseFloat(value) || 0;
    const surfaceCss = getComputedStyle(surface);
    const fixed = [...surface.children].reduce((total, node) => {
      const css = getComputedStyle(node);
      if (node === dock || node === transcript || css.display === "none" || ["absolute", "fixed"].includes(css.position)) return total;
      return total + node.getBoundingClientRect().height + px(css.marginTop) + px(css.marginBottom);
    }, px(surfaceCss.paddingTop) + px(surfaceCss.paddingBottom));
    const panels = [...dock.children].filter(node => {
      const css = getComputedStyle(node);
      return !(node as HTMLElement).hidden && css.display !== "none" && !["absolute", "fixed"].includes(css.position);
    });
    const css = getComputedStyle(dock);
    const minimumWork = panels.reduce((total, node) => {
      const panelCss = getComputedStyle(node);
      return total + px(panelCss.minHeight) + px(panelCss.marginTop) + px(panelCss.marginBottom);
    }, Math.max(0, panels.length - 1) * px(css.rowGap) + px(css.paddingTop) + px(css.paddingBottom));
    const normal = visualHeight * 0.4;
    const short = visualHeight <= 450 && document.documentElement.hasAttribute("data-chat-short");
    const physical = Math.max(0, surface.clientHeight - fixed - minimumWork);
    const remaining = Math.max(0, surface.clientHeight - fixed);
    const expanded = !!dock.querySelector("#chat-compact-workers[open], #chat-queue[data-expanded='true']");
    const preferredStrip = Math.min(remaining, 96, Math.max(32, remaining * .2));
    const expandedStrip = Math.min(preferredStrip, Math.max(Math.min(16, remaining * .1), physical));
    const expected = expanded ? expandedStrip : short ? Math.min(normal, physical) : normal;
    const visible = Math.min(transcript.clientHeight, timeline.clientHeight);
    return visible >= expected - 1 ? true : { visible, expected, normal, fixed, minimumWork, physical };
  }, visualHeight)).toBe(true);
}
