import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { createLoadingSignal } from "./loading-signal";

let host: HTMLElement;
let segment: HTMLElement;
let cleanup: () => void;

beforeEach(() => {
  const { document, window } = parseHTML(
    "<!doctype html><html><body><main id='shell'><header>h</header><article>old content</article></main><button id='seg'></button></body></html>",
  );
  const previousDocument = (globalThis as { document?: unknown }).document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as unknown as { document: unknown }).document = document;
  (globalThis as unknown as { window: unknown }).window = window;
  host = document.getElementById("shell") as unknown as HTMLElement;
  segment = document.getElementById("seg") as unknown as HTMLElement;
  cleanup = () => {
    (globalThis as unknown as { document: unknown }).document = previousDocument as unknown;
    (globalThis as unknown as { window: unknown }).window = previousWindow as unknown;
  };
});

afterEach(() => {
  cleanup();
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const barVisible = () => host.querySelector(".uatu-loading-bar") !== null;

describe("createLoadingSignal", () => {
  test("segment goes busy immediately on start and un-busies on settle", () => {
    const signal = createLoadingSignal({ segment, barHost: host, showDelayMs: 50, minVisibleMs: 50 });

    signal.start();
    expect(segment.getAttribute("aria-busy")).toBe("true");
    expect(segment.classList.contains("is-loading")).toBe(true);

    signal.settle();
    expect(segment.getAttribute("aria-busy")).toBeNull();
    expect(segment.classList.contains("is-loading")).toBe(false);
  });

  test("no bar appears when work settles under the show delay", async () => {
    const signal = createLoadingSignal({ segment, barHost: host, showDelayMs: 40, minVisibleMs: 40 });

    signal.start();
    await sleep(10);
    signal.settle();
    await sleep(60);

    expect(barVisible()).toBe(false);
  });

  test("bar appears after the show delay and does not hide previous content", async () => {
    const signal = createLoadingSignal({ segment, barHost: host, showDelayMs: 20, minVisibleMs: 20 });

    signal.start();
    expect(barVisible()).toBe(false);
    await sleep(40);

    expect(barVisible()).toBe(true);
    // The previous content is untouched — the bar is an overlay sibling.
    expect(host.querySelector("article")?.textContent).toBe("old content");

    signal.settle();
    await sleep(40);
    expect(barVisible()).toBe(false);
  });

  test("bar honors the minimum visible window once shown", async () => {
    const signal = createLoadingSignal({ segment, barHost: host, showDelayMs: 10, minVisibleMs: 80 });

    signal.start();
    await sleep(30);
    expect(barVisible()).toBe(true);

    signal.settle();
    // Still inside the minimum window: bar must remain.
    expect(barVisible()).toBe(true);
    await sleep(120);
    expect(barVisible()).toBe(false);
  });

  test("a restart during the minimum window keeps one continuous bar", async () => {
    const signal = createLoadingSignal({ segment, barHost: host, showDelayMs: 10, minVisibleMs: 50 });

    signal.start();
    await sleep(30);
    signal.settle();
    signal.start();
    await sleep(80);

    // Second run is still active — the bar stayed up through the restart.
    expect(barVisible()).toBe(true);
    expect(host.querySelectorAll(".uatu-loading-bar").length).toBe(1);

    signal.settle();
    await sleep(80);
    expect(barVisible()).toBe(false);
  });
});
