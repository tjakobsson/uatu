import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createMediaPlayer, type MediaSource } from "./controller";
import { initMediaDock, mediaTime } from "./dock";

function harness() {
  const { window, document } = parseHTML('<html data-ui-mode="touch" data-active-tab="files"><body><div id="preview"></div></body></html>');
  const globals = ["window", "document", "Event", "innerHeight", "ResizeObserver", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"];
  const saved = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let id = 0;
  const frames = new Map<number, () => void>();
  const values = { window, document, Event: window.Event, innerHeight: 844, ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn: () => void) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (key: number) => frames.delete(key) };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let rejectPlay = false;
  const player = createMediaPlayer(kind => {
    const media = document.createElement(kind) as unknown as HTMLMediaElement;
    Object.assign(media, { currentTime: 0, duration: 30, paused: true, ended: false,
      load() {}, pause() { this.paused = true; }, play() {
        if (rejectPlay) return Promise.reject(new Error("Gesture required"));
        this.paused = false; media.dispatchEvent(new window.Event("play")); return Promise.resolve();
      } });
    return media;
  });
  const source: MediaSource = { id: "clip", rootId: "root", relativePath: "renders/clip.mp4", name: "clip.mp4", epoch: "epoch", revision: 1, kind: "video" };
  const dispose = initMediaDock(player);
  return { player, source, document, window, reject: () => { rejectPlay = true; },
    click: (label: string) => (document.querySelector(`[aria-label="${label}"]`) as unknown as HTMLElement).click(),
    restore() { dispose(); for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } },
  };
}

describe("persistent media dock", () => {
  test("time labels handle pending metadata and long clips", () => {
    expect(mediaTime(null)).toBe("--:--"); expect(mediaTime(125.9)).toBe("2:05"); expect(mediaTime(-2)).toBe("0:00");
  });
  test("expand, compact and leaving Preview reparent the same native element without seeking", () => {
    const f = harness();
    try {
      f.player.present(f.source);
      const element = f.player.snapshot().element!;
      element.currentTime = 12;
      f.player.attachElement(f.document.getElementById("preview")! as unknown as HTMLElement);
      f.click("Expand video");
      expect(element.parentElement?.className).toBe("media-dock-element");
      expect(f.document.querySelectorAll("video").length).toBe(1);
      expect(element.currentTime).toBe(12);
      f.click("Compact video");
      f.player.attachElement(f.document.getElementById("preview")! as unknown as HTMLElement);
      f.document.dispatchEvent(new f.window.Event("uatu:before-surface-change"));
      expect(element.parentElement?.className).toBe("media-dock-element");
      expect(element.currentTime).toBe(12);
      f.click("Close player");
      expect(f.player.snapshot().source).toBeNull();
      expect(f.document.getElementById("media-dock")!.hasAttribute("hidden")).toBe(true);
      expect(f.document.querySelectorAll("video").length).toBe(0);
    } finally { f.restore(); }
  });
  test("timeupdate retains the range and control nodes, and rejected Play stays actionable", async () => {
    const f = harness();
    try {
      f.reject(); f.player.present(f.source);
      const range = f.document.querySelector('input[type="range"]');
      const play = f.document.querySelector('[aria-label="Play"]');
      const element = f.player.snapshot().element!;
      for (let time = 1; time < 10; time++) {
        element.currentTime = time; element.dispatchEvent(new f.window.Event("timeupdate"));
      }
      expect(f.document.querySelector('input[type="range"]')).toBe(range);
      expect(f.document.querySelector('[aria-label="Play"]')).toBe(play);
      f.click("Play"); await Promise.resolve(); await Promise.resolve();
      expect(f.document.querySelector('[role="status"]')!.textContent).toContain("Play");
      expect(play!.hasAttribute("disabled")).toBe(false);
      expect(f.document.querySelector(".media-dock-status button")!.hasAttribute("hidden")).toBe(false);
    } finally { f.restore(); }
  });
});
