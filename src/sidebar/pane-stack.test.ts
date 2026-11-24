import { describe, expect, test } from "bun:test";

import { allocatePaneHeights, paneParticipatesInStack, wholeRowTrim } from "./pane-stack";

describe("paneParticipatesInStack", () => {
  test("visible expanded panes participate", () => {
    expect(paneParticipatesInStack({ visible: true, collapsed: false })).toBe(true);
  });

  test("hidden and collapsed panes do not", () => {
    expect(paneParticipatesInStack({ visible: false, collapsed: false })).toBe(false);
    expect(paneParticipatesInStack({ visible: true, collapsed: true })).toBe(false);
  });
});

describe("allocatePaneHeights", () => {
  const sum = (heights: Map<string, number>) => Array.from(heights.values()).reduce((a, b) => a + b, 0);

  test("requests that fit are kept and the grow pane takes the spare height", () => {
    const heights = allocatePaneHeights([
      { id: "overview", requested: 200, minimum: 150 },
      { id: "files", requested: 100, minimum: 180 },
    ], 600, "files");
    expect(heights.get("overview")).toBe(200);
    expect(heights.get("files")).toBe(400);
  });

  test("oversized requests shrink toward the minimums and never below them", () => {
    // The phone Files tab: Pull request and Change Overview keep their
    // desktop-sized requests, and Files must still keep its minimum.
    const heights = allocatePaneHeights([
      { id: "pull-request", requested: 340, minimum: 160 },
      { id: "overview", requested: 210, minimum: 160 },
      { id: "files", requested: 72, minimum: 200 },
    ], 560, "files");
    expect(sum(heights)).toBe(560);
    expect(heights.get("files")).toBeGreaterThanOrEqual(200);
    expect(heights.get("pull-request")).toBeGreaterThanOrEqual(160);
    expect(heights.get("overview")).toBeGreaterThanOrEqual(160);
    expect(heights.get("pull-request")!).toBeGreaterThan(heights.get("overview")!);
  });

  test("when even the minimums do not fit, panes split in proportion to them", () => {
    const heights = allocatePaneHeights([
      { id: "a", requested: 300, minimum: 150 },
      { id: "b", requested: 300, minimum: 150 },
      { id: "files", requested: 300, minimum: 300 },
    ], 300, "files");
    expect(sum(heights)).toBe(300);
    expect(heights.get("a")).toBe(75);
    expect(heights.get("files")).toBe(150);
  });

  test("without a grow pane the last pane absorbs the remainder", () => {
    const heights = allocatePaneHeights([
      { id: "a", requested: 100, minimum: 100 },
      { id: "b", requested: 100, minimum: 100 },
    ], 301, null);
    expect(heights.get("b")).toBe(201);
  });

  test("a required pane keeps its minimum when the minimums do not fit", () => {
    // The phone Files tab with a pending review: the Pull request pane's
    // summary and actions stay whole; the others share the rest.
    const heights = allocatePaneHeights([
      { id: "pull-request", requested: 200, minimum: 280, required: true },
      { id: "overview", requested: 210, minimum: 160 },
      { id: "files", requested: 72, minimum: 200 },
    ], 574, "files");
    expect(sum(heights)).toBe(574);
    expect(heights.get("pull-request")).toBe(280);
    expect(heights.get("overview")).toBe(Math.floor(294 * 160 / 360));
  });

  test("a required minimum that alone overflows leaves the others their floor", () => {
    const heights = allocatePaneHeights([
      { id: "pull-request", requested: 200, minimum: 400, required: true },
      { id: "files", requested: 72, minimum: 200 },
    ], 300, "files", 72);
    expect(sum(heights)).toBe(300);
    expect(heights.get("pull-request")).toBe(228);
    expect(heights.get("files")).toBe(72);
  });

  test("a required pane gives way only as far as keeps the others at the floor", () => {
    // Six panes in a 634px desktop stack with a pending review.
    const heights = allocatePaneHeights([
      { id: "pull-request", requested: 200, minimum: 300, required: true },
      ...["overview", "search", "files", "git-log", "usage"].map(id => ({ id, requested: 150, minimum: 160 })),
    ], 634, "files", 72);
    expect(sum(heights)).toBe(634);
    expect(heights.get("pull-request")).toBe(274);
    for (const id of ["overview", "search", "git-log", "usage"]) expect(heights.get(id)).toBe(72);
  });
});

describe("wholeRowTrim", () => {
  const rows = [{ top: 0, bottom: 22 }, { top: 26, bottom: 64 }, { top: 68, bottom: 88 }, { top: 92, bottom: 130 }, { top: 140, bottom: 214 }];
  test("hides a row the visible bottom cuts through", () => {
    expect(wholeRowTrim(rows, 196)).toBe(56);
  });
  test("leaves a bottom that falls between rows alone", () => {
    expect(wholeRowTrim(rows, 135)).toBe(0);
    expect(wholeRowTrim(rows, 300)).toBe(0);
  });
  test("never trims into the essential content", () => {
    expect(wholeRowTrim(rows, 196, 160)).toBe(0);
    expect(wholeRowTrim(rows, 110, 92)).toBe(18);
    expect(wholeRowTrim(rows, 110, 100)).toBe(0);
  });
});
