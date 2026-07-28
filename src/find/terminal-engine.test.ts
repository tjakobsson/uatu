import { describe, expect, test } from "bun:test";

import { DEFAULT_MATCH_OPTIONS } from "./matcher";
import { createTerminalEngine, type TerminalSearchTarget } from "./terminal-engine";
import type { FindOutcome } from "./engine";

type Call = { kind: string; query?: string };

function fakePane(label: string) {
  const calls: Call[] = [];
  let listener: ((r: { index: number; total: number }) => void) | null = null;
  const target: TerminalSearchTarget = {
    findNext: query => calls.push({ kind: "findNext", query }),
    findPrevious: query => calls.push({ kind: "findPrevious", query }),
    clear: () => calls.push({ kind: "clear" }),
    focus: () => calls.push({ kind: "focus" }),
    onResults: next => {
      listener = next;
      calls.push({ kind: next ? "subscribe" : "unsubscribe" });
    },
  };
  return {
    label,
    target,
    calls,
    emit(index: number, total: number) {
      listener?.({ index, total });
    },
  };
}

describe("terminal find engine", () => {
  test("searches the pane resolved at call time, not one captured up front", () => {
    // Splitting or closing panes mid-search must not leave the engine pointed
    // at a pane that is gone.
    const first = fakePane("first");
    const second = fakePane("second");
    let focused = first;
    const engine = createTerminalEngine(() => focused.target, () => null);

    engine.run("hello", DEFAULT_MATCH_OPTIONS, { reveal: true });
    focused = second;
    engine.run("hello", DEFAULT_MATCH_OPTIONS, { reveal: true });

    expect(first.calls.filter(c => c.kind === "findNext")).toHaveLength(1);
    expect(second.calls.filter(c => c.kind === "findNext")).toHaveLength(1);
  });

  test("the unfocused pane of a split is never searched", () => {
    const focused = fakePane("focused");
    const other = fakePane("other");
    const engine = createTerminalEngine(() => focused.target, () => null);

    engine.run("query", DEFAULT_MATCH_OPTIONS, { reveal: true });
    engine.step(1, "query", DEFAULT_MATCH_OPTIONS);
    engine.step(-1, "query", DEFAULT_MATCH_OPTIONS);

    expect(other.calls).toEqual([]);
  });

  test("only ever reads the buffer — no write path exists", () => {
    // The guarantee that searching cannot disturb a running program is
    // structural: the target exposes no method that reaches the PTY.
    const pane = fakePane("only");
    const engine = createTerminalEngine(() => pane.target, () => null);
    engine.run("x", DEFAULT_MATCH_OPTIONS, { reveal: true });
    engine.step(1, "x", DEFAULT_MATCH_OPTIONS);
    engine.clear();

    const kinds = new Set(pane.calls.map(c => c.kind));
    expect([...kinds].sort()).toEqual(["clear", "findNext", "subscribe", "unsubscribe"].sort());
  });

  test("an empty query clears rather than searching for nothing", () => {
    const pane = fakePane("only");
    const engine = createTerminalEngine(() => pane.target, () => null);
    engine.run("", DEFAULT_MATCH_OPTIONS, { reveal: true });
    expect(pane.calls.some(c => c.kind === "clear")).toBe(true);
    expect(pane.calls.some(c => c.kind === "findNext")).toBe(false);
  });

  test("step direction maps to forward and backward search", () => {
    const pane = fakePane("only");
    const engine = createTerminalEngine(() => pane.target, () => null);
    engine.step(1, "q", DEFAULT_MATCH_OPTIONS);
    engine.step(-1, "q", DEFAULT_MATCH_OPTIONS);
    expect(pane.calls.map(c => c.kind).filter(k => k.startsWith("find"))).toEqual([
      "findNext",
      "findPrevious",
    ]);
  });

  test("result counts reach the bar", () => {
    const pane = fakePane("only");
    const engine = createTerminalEngine(() => pane.target, () => null);
    const seen: FindOutcome[] = [];
    engine.setOnOutcome(outcome => seen.push(outcome));

    engine.run("q", DEFAULT_MATCH_OPTIONS, { reveal: true });
    pane.emit(2, 9);

    expect(seen.at(-1)).toEqual({ total: 9, index: 2, truncated: false, error: null });
  });

  test("the addon's highlight-threshold signal reads as truncation, not an error", () => {
    // The addon reports index -1 with a positive total when it stops
    // highlighting. That is the same situation the preview calls truncation.
    const pane = fakePane("only");
    const engine = createTerminalEngine(() => pane.target, () => null);
    const seen: FindOutcome[] = [];
    engine.setOnOutcome(outcome => seen.push(outcome));

    engine.run("q", DEFAULT_MATCH_OPTIONS, { reveal: true });
    pane.emit(-1, 5000);

    expect(seen.at(-1)).toEqual({ total: 5000, index: -1, truncated: true, error: null });
  });

  test("with no focused pane there is nothing to search", () => {
    const engine = createTerminalEngine(() => null, () => null);
    const seen: FindOutcome[] = [];
    engine.setOnOutcome(outcome => seen.push(outcome));
    engine.run("q", DEFAULT_MATCH_OPTIONS, { reveal: true });
    expect(seen.at(-1)).toEqual({ total: 0, index: -1, truncated: false, error: null });
  });

  test("switching panes unsubscribes the previous one", () => {
    const first = fakePane("first");
    const second = fakePane("second");
    let focused = first;
    const engine = createTerminalEngine(() => focused.target, () => null);

    engine.run("q", DEFAULT_MATCH_OPTIONS, { reveal: true });
    focused = second;
    engine.run("q", DEFAULT_MATCH_OPTIONS, { reveal: true });

    expect(first.calls.filter(c => c.kind === "unsubscribe")).toHaveLength(1);
  });
});

describe("moving between panes", () => {
  test("the pane being left is cleared, not just unsubscribed", () => {
    // Otherwise a split keeps both panes highlighted, and closing the bar
    // tidies only the one it happens to be pointed at.
    const first = fakePane("first");
    const second = fakePane("second");
    let focused = first;
    const engine = createTerminalEngine(() => focused.target, () => null);

    engine.run("q", DEFAULT_MATCH_OPTIONS, { reveal: true });
    focused = second;
    engine.run("q", DEFAULT_MATCH_OPTIONS, { reveal: true });

    expect(first.calls.some(c => c.kind === "clear")).toBe(true);
  });

  test("staying on one pane does not clear it between runs", () => {
    const pane = fakePane("only");
    const engine = createTerminalEngine(() => pane.target, () => null);
    engine.run("q", DEFAULT_MATCH_OPTIONS, { reveal: true });
    engine.run("qq", DEFAULT_MATCH_OPTIONS, { reveal: true });
    expect(pane.calls.filter(c => c.kind === "clear")).toHaveLength(0);
  });
});
