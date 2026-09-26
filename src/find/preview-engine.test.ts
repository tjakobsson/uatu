import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createPreviewEngine, insideSkipped } from "./preview-engine";
import { DEFAULT_MATCH_OPTIONS } from "./matcher";
import type { FindOutcome } from "./engine";

test("revealing controls before unchanged output preserves the selected match", () => {
  const { document } = parseHTML('<html><body><article><button hidden>Latest output</button><pre>needle needle</pre></article><aside></aside></body></html>');
  document.createRange = () => {
    const range = {
      startContainer: null as unknown as Node, startOffset: 0,
      endContainer: null as unknown as Node, endOffset: 0,
      setStart(node: Node, offset: number) { range.startContainer = node; range.startOffset = offset; },
      setEnd(node: Node, offset: number) { range.endContainer = node; range.endOffset = offset; },
    };
    return range as unknown as Range;
  };
  const root = document.querySelector("article") as unknown as HTMLElement;
  const slot = document.querySelector("aside") as unknown as HTMLElement;
  const engine = createPreviewEngine(root, root, slot, { revealMatch: () => true });
  let outcome: FindOutcome | undefined;
  engine.setOnOutcome(value => { outcome = value; });
  engine.run("needle", DEFAULT_MATCH_OPTIONS, { reveal: false });
  engine.step(1, "needle", DEFAULT_MATCH_OPTIONS);
  expect(outcome).toMatchObject({ total: 2, index: 1 });
  document.querySelector("button")!.removeAttribute("hidden");
  engine.run("needle", DEFAULT_MATCH_OPTIONS, { reveal: false });
  expect(outcome).toMatchObject({ total: 2, index: 1 });
});

test("dynamic targets reset match position and own bar, focus, and range reveal", () => {
  const { document } = parseHTML('<html><body><article>needle needle</article><section>needle</section><aside></aside><nav></nav></body></html>');
  const roots = Array.from(document.body.children) as unknown as HTMLElement[];
  const [first, second, firstSlot, secondSlot] = roots as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
  let target = first;
  let slot = firstSlot;
  let focused: HTMLElement | undefined;
  let revealed = 0;
  let outcome: FindOutcome | undefined;
  first.focus = () => { focused = first; };
  second.focus = () => { focused = second; };
  // Linkedom does not implement text offsets on its Range. Geometry must never
  // be read here: the supplied reveal handler owns that operation completely.
  document.createRange = () => ({ setStart() {}, setEnd() {} }) as unknown as Range;
  const engine = createPreviewEngine(first, first, firstSlot, {
    target: () => target,
    barHost: () => slot,
    focusTarget: () => target,
    revealMatch: () => { revealed++; return true; },
    scrollRoot: () => { throw new Error("outer scroll must not run"); },
  });
  engine.setOnOutcome(value => { outcome = value; });
  engine.run("needle", DEFAULT_MATCH_OPTIONS, { reveal: true });
  engine.step(1, "needle", DEFAULT_MATCH_OPTIONS);
  expect(outcome).toMatchObject({ total: 2, index: 1 });
  expect(engine.barHost()).toBe(firstSlot);
  target = second; slot = secondSlot;
  engine.run("needle", DEFAULT_MATCH_OPTIONS, { reveal: true });
  expect(outcome).toMatchObject({ total: 1, index: 0 });
  expect(engine.barHost()).toBe(secondSlot);
  engine.focusSurface();
  expect(focused).toBe(second);
  expect(revealed).toBe(4);
});

test("a mutation inside skipped chrome is recognised as not changing the matches", () => {
  const { document } = parseHTML('<html><body><div data-find-skip><time>Today</time></div><p>Today</p></body></html>');
  const time = document.querySelector("time")!;
  expect(insideSkipped(time as unknown as Node)).toBe(true);
  expect(insideSkipped(time.firstChild as unknown as Node)).toBe(true);
  expect(insideSkipped(document.querySelector("p")!.firstChild as unknown as Node)).toBe(false);
});
