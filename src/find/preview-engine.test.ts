import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createPreviewEngine } from "./preview-engine";
import { DEFAULT_MATCH_OPTIONS } from "./matcher";
import type { FindOutcome } from "./engine";

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
