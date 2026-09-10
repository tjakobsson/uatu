import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createFlowEnvironment, showContextualError } from "./flow-ui";
import type { MobileHubBackend, OperationResult } from "./backend";

for (const kind of ["flow", "sheet"]) test(`${kind} action error reveals only its scroll owner without focusing or replacing the draft`, () => {
  const { document } = parseHTML(`<html><body><section><div class="mh-${kind === "flow" ? "flow-content" : "sheet-body"}"><input value="draft"><p class="mh-${kind}-error" role="alert"></p></div></section></body></html>`);
  const region = document.querySelector("section")! as unknown as HTMLElement;
  const pane = region.firstElementChild as HTMLElement;
  const input = region.querySelector("input")!;
  const alert = region.querySelector<HTMLElement>("[role=alert]")!;
  let focused = false; input.focus = () => { focused = true; };
  pane.scrollTop = 0;
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 300 }) as DOMRect;
  alert.getBoundingClientRect = () => ({ top: 1000, bottom: 1040 }) as DOMRect;
  showContextualError(region, "Invalid input");
  expect(pane.scrollTop).toBe(0);
  showContextualError(region, "Invalid input", { reveal: true });
  expect(pane.scrollTop).toBe(740);
  expect(region.querySelector("input")).toBe(input);
  expect(input.value).toBe("draft");
  expect(focused).toBe(false);
  expect(region.querySelectorAll("[role=alert]").length).toBe(1);
  region.remove(); showContextualError(region, "stale", { reveal: true });
  expect(alert.textContent).toBe("Invalid input");
});

test("a replaced mutation context does not reveal an old failure in the next form", async () => {
  const { document } = parseHTML('<html><body><section><p class="mh-flow-error" role="alert"></p></section></body></html>');
  const root = document.querySelector("section")! as unknown as HTMLElement;
  const owner = createFlowEnvironment(root, {} as MobileHubBackend, { open: () => root, close() {}, busy() {}, error() {} }, {
    user: () => "owner", home() {}, navigate() {}, changed() {}, authLost() {}, openWorkspace() {},
  });
  let resolve!: (result: OperationResult<never>) => void;
  const pending = owner.env.mutate(() => new Promise<OperationResult<never>>(done => { resolve = done; }), () => { throw new Error("unexpected success"); });
  root.innerHTML = '<p class="mh-flow-error" role="alert">Next form</p>';
  resolve({ status: "rejected", problem: { kind: "unavailable", message: "Old failure" } });
  await pending;
  expect(root.textContent).toBe("Next form");
});
