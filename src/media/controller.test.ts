import { describe, expect, test } from "bun:test";
import { createMediaPlayer, mediaSource, type MediaSource } from "./controller";
import type { RootGroup } from "../shared/types";

class NativeMedia extends EventTarget {
  paused = true; ended = false; currentTime = 0; duration = 8; loop = false;
  src = ""; preload = ""; controls = false; plays = 0; loads = 0;
  reject: Error | null = null;
  setAttribute() {} remove() {}
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  load() { this.loads++; }
  play() { this.plays++; if (this.reject) return Promise.reject(this.reject); this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
}
const source = (id: string, revision = 1, epoch = "epoch"): MediaSource => ({ id, name: `${id}.wav`, relativePath: `${id}.wav`, rootId: "root", revision, epoch, kind: "audio" });
const roots = (...sources: MediaSource[]): RootGroup[] => [{ id: "root", path: "root", label: "root", hiddenCount: 0,
  docs: sources.map(s => ({ ...s, kind: "binary", mtimeMs: 1 })) }];
function setup() {
  const elements: NativeMedia[] = [];
  const player = createMediaPlayer(() => { const element = new NativeMedia(); elements.push(element); return element as unknown as HTMLMediaElement; });
  player.setDefaultElementHost({ append() {} } as unknown as HTMLElement);
  return { player, elements };
}
describe("page-local media lifecycle", () => {
  test("identity needs a recognized extension and valid revision/epoch", () => {
    const doc = roots(source("a"))[0]!.docs[0]!;
    expect(mediaSource(doc, "epoch")).toEqual(source("a"));
    for (const revision of [undefined, -1, NaN, Infinity, 1.5]) expect(mediaSource({ ...doc, revision }, "epoch")).toBeNull();
    expect(mediaSource(doc, null)).toBeNull();
    expect(mediaSource({ ...doc, name: "a.txt" }, "epoch")).toBeNull();
  });
  test("navigation prepares paused, different previews cannot replace, current preview preserves time", () => {
    const { player, elements } = setup();
    player.reconcile(roots(source("a"), source("b")), "epoch");
    expect(elements).toHaveLength(0);
    player.present(source("a")); expect(elements[0]!.plays).toBe(0);
    player.play(); elements[0]!.currentTime = 3; elements[0]!.dispatchEvent(new Event("timeupdate"));
    player.present(source("b")); player.present(source("a"));
    expect(elements).toHaveLength(1); expect(player.snapshot().position).toBe(3);
    expect(player.snapshot().playing).toBe(true);
  });
  test("explicit audition calls native play synchronously and releases prior source, stale callbacks cannot mutate new session", async () => {
    const { player, elements } = setup();
    player.audition(source("a"), [source("a"), source("b")]);
    expect(elements[0]!.plays).toBe(1);
    player.next(); expect(elements[0]!.src).toBe(""); expect(elements[0]!.paused).toBe(true);
    elements[0]!.currentTime = 7; elements[0]!.dispatchEvent(new Event("timeupdate")); elements[0]!.dispatchEvent(new Event("error"));
    expect(player.snapshot().source?.id).toBe("b"); expect(player.snapshot().position).toBe(0); expect(player.snapshot().error).toBeNull();
    expect(elements[1]!.plays).toBe(1);
    player.close(); elements[1]!.dispatchEvent(new Event("play"));
    expect(player.snapshot().source).toBeNull(); expect(elements[1]!.src).toBe("");
  });
  test("captured order skips removed entries, resolves latest revision, never wraps or advances at end", () => {
    const { player, elements } = setup();
    const a = source("a"), b = source("b"), c = source("c");
    player.reconcile(roots(a, b, c), "epoch"); player.audition(a, [a, b, c]);
    player.reconcile(roots(source("new"), source("c", 2), a), "epoch");
    player.next(); expect(player.snapshot().source).toEqual(source("c", 2));
    expect(player.snapshot().canNext).toBe(false);
    elements[1]!.ended = true; elements[1]!.dispatchEvent(new Event("ended"));
    expect(player.snapshot().source?.id).toBe("c"); expect(player.snapshot().playing).toBe(false);
    player.next(); expect(elements).toHaveLength(2);
    player.previous(); expect(player.snapshot().source?.id).toBe("a"); expect(player.snapshot().canPrevious).toBe(false);
  });
  test("updates preserve unrelated state, invalidate changed revision and epoch, Reload stays paused at zero", () => {
    const { player, elements } = setup();
    player.reconcile(roots(source("a")), "epoch"); player.audition(source("a"), [source("a")]); player.setLoop(true);
    elements[0]!.currentTime = 4; elements[0]!.dispatchEvent(new Event("timeupdate"));
    player.reconcile(roots(source("a"), source("b")), "epoch");
    expect(player.snapshot().element).toBe(elements[0] as unknown as HTMLMediaElement); expect(player.snapshot().position).toBe(4);
    player.reconcile(roots(source("a", 2)), "epoch");
    expect(player.snapshot().newRenderAvailable).toBe(true); expect(player.snapshot().loop).toBe(false); expect(elements[0]!.src).toBe("");
    player.reload(); expect(player.snapshot().source?.revision).toBe(2); expect(player.snapshot().position).toBe(0); expect(elements[1]!.plays).toBe(0);
    player.reconcile(roots(source("a", 2)), "new-epoch"); expect(player.snapshot().newRenderAvailable).toBe(true);
  });
  test("partial inventory does not remove active source; authoritative removal releases and cannot reload", () => {
    const { player, elements } = setup(); player.present(source("a"));
    player.reconcile([], "epoch", false); expect(player.snapshot().unavailable).toBe(false);
    player.reconcile([], "epoch"); expect(player.snapshot().unavailable).toBe(true); expect(elements[0]!.src).toBe("");
    player.reload(); player.play(); expect(elements).toHaveLength(1); expect(elements[0]!.plays).toBe(0);
  });
  test("rejected Play is actionable, never retries automatically, late rejection ignored", async () => {
    const { player, elements } = setup(); player.present(source("a")); elements[0]!.reject = new Error("NotAllowedError");
    player.play(); await Promise.resolve(); expect(player.snapshot().error).toContain("Press Play to retry"); expect(elements[0]!.plays).toBe(1);
    player.play(); player.audition(source("b"), [source("b")]); await Promise.resolve(); expect(player.snapshot().error).toBeNull();
  });
  test("a recreated file remains stopped and offers an explicit fresh Reload", () => {
    const { player, elements } = setup();
    player.present(source("a")); player.reconcile([], "epoch");
    player.reconcile(roots(source("a", 2)), "epoch");
    expect(player.snapshot().unavailable).toBe(false); expect(player.snapshot().newRenderAvailable).toBe(true);
    expect(elements).toHaveLength(1);
    player.reload(); expect(elements).toHaveLength(2); expect(elements[1]!.plays).toBe(0);
  });
  test("a partial new epoch releases absent active media and cannot revive old inventory or captured sources", () => {
    const { player, elements } = setup();
    const a = source("a"), b = source("b");
    player.reconcile(roots(a, b), "epoch"); player.audition(a, [a, b]); player.setLoop(true);
    player.reconcile(roots(source("other", 1, "new-epoch")), "new-epoch", false);
    expect(player.snapshot().newRenderAvailable).toBe(true);
    expect(player.snapshot().loop).toBe(false); expect(player.snapshot().playing).toBe(false);
    expect(player.snapshot().unavailable).toBe(false); expect(elements[0]!.src).toBe("");
    expect(elements[0]!.loop).toBe(false); expect(player.snapshot().canNext).toBe(false);
    player.reload(); player.next(); player.audition(a, [a, b]); player.play(); player.setLoop(true);
    expect(elements).toHaveLength(1); expect(player.snapshot().loop).toBe(false);
    player.close(); player.present(a); player.audition(b, [a, b]);
    expect(player.snapshot().source).toBeNull(); expect(elements).toHaveLength(1);
    player.reconcile(roots(source("a", 2, "new-epoch"), source("b", 3, "new-epoch")), "new-epoch", false);
    player.audition(a, [a, b]);
    expect(player.snapshot().source).toEqual(source("a", 2, "new-epoch"));
    player.next(); expect(player.snapshot().source).toEqual(source("b", 3, "new-epoch"));
    expect(elements).toHaveLength(3);
  });
  test("parking an element already in its default host is a no-op", () => {
    const { player, elements } = setup();
    let appends = 0;
    const host = { append(element: NativeMedia & { parentElement: unknown }) { appends++; element.parentElement = host; } };
    player.setDefaultElementHost(host as unknown as HTMLElement);
    player.audition(source("a"), [source("a")]);
    elements[0]!.currentTime = 2;
    player.attachDefaultElement(); player.attachDefaultElement();
    player.setDefaultElementHost(host as unknown as HTMLElement);
    expect(appends).toBe(1); expect(elements[0]!.currentTime).toBe(2);
    expect(elements[0]!.paused).toBe(false); expect(elements[0]!.plays).toBe(1);
  });
  test("partial absence without a removal retains buffered playback, Loop and captured neighbors", () => {
    const { player, elements } = setup();
    const a = source("a"), b = source("b");
    player.reconcile(roots(a, b), "epoch"); player.audition(a, [a, b]); player.setLoop(true);
    const element = elements[0]!;
    element.currentTime = 3; element.dispatchEvent(new Event("timeupdate"));
    const url = element.src;
    player.reconcile(roots(source("unrelated")), "epoch", false, []);
    expect(player.snapshot()).toMatchObject({ source: a, element, playing: true, loading: true,
      position: 3, loop: true, unavailable: false, newRenderAvailable: false, canNext: true });
    expect(element.src).toBe(url); expect(element.paused).toBe(false); expect(element.loop).toBe(true);
    expect(element.loads).toBe(0); expect(elements).toHaveLength(1);
  });
  test("explicit removal during partial discovery immediately releases an active looping source", () => {
    const { player, elements } = setup();
    const a = source("a");
    player.reconcile(roots(a), "epoch"); player.audition(a, [a]); player.setLoop(true);
    expect(player.snapshot().playing).toBe(true); expect(player.snapshot().loading).toBe(true);
    player.reconcile([], "epoch", false, [{ rootId: a.rootId, id: a.id }]);
    expect(player.snapshot()).toMatchObject({ source: a, element: null, playing: false, loading: false,
      loop: false, unavailable: true, canPrevious: false, canNext: false });
    expect(elements[0]!.src).toBe(""); expect(elements[0]!.paused).toBe(true);
    expect(elements[0]!.loop).toBe(false); expect(elements[0]!.loads).toBe(1);
    player.reload(); player.play(); player.setLoop(true);
    expect(elements).toHaveLength(1); expect(player.snapshot().loop).toBe(false);
  });
  test("captured navigation skips explicitly removed entries throughout later partial inventories", () => {
    const { player, elements } = setup();
    const a = source("a"), b = source("b"), c = source("c");
    player.reconcile(roots(a, b, c), "epoch"); player.audition(a, [a, b, c]);
    player.reconcile([], "epoch", false, [b]);
    player.reconcile(roots(source("new"), source("c", 2)), "epoch", false);
    player.next(); expect(player.snapshot().source).toEqual(source("c", 2));
    expect(player.snapshot().canNext).toBe(false); expect(elements).toHaveLength(2);
    player.previous(); expect(player.snapshot().source).toEqual(a);
    player.audition(b, [a, b, c]); expect(player.snapshot().source).toEqual(a);
    expect(elements).toHaveLength(3);
  });
  test("authoritatively missing entries stay removed when discovery becomes partial again", () => {
    const { player, elements } = setup();
    const a = source("a"), b = source("b");
    player.reconcile(roots(a, b), "epoch"); player.audition(a, [a, b]);
    player.reconcile(roots(a), "epoch");
    player.reconcile([], "epoch", false);
    expect(player.snapshot().canNext).toBe(false);
    player.next(); expect(player.snapshot().source).toEqual(a); expect(elements).toHaveLength(1);
    player.reconcile([], "epoch");
    player.reconcile([], "epoch", false);
    player.audition(a, [a, b]); player.reload(); player.play();
    expect(player.snapshot()).toMatchObject({ unavailable: true, playing: false, element: null });
    player.close(); player.present(a); player.audition(b, [a, b]);
    expect(player.snapshot().source).toBeNull(); expect(elements).toHaveLength(1);
  });
  test("removal evidence survives Close and partial updates, and late callbacks or Play rejection cannot restore it", async () => {
    const { player, elements } = setup();
    const a = source("a");
    player.reconcile(roots(a), "epoch"); player.present(a);
    const element = elements[0]!;
    element.reject = new Error("Late Play rejection"); player.play();
    player.reconcile([], "epoch", false, [a]);
    const unavailable = player.snapshot();
    await Promise.resolve();
    element.currentTime = 7; element.duration = 99; element.paused = false;
    for (const event of ["play", "timeupdate", "loadedmetadata", "canplay", "error"]) element.dispatchEvent(new Event(event));
    expect(player.snapshot()).toEqual(unavailable);
    player.reconcile([], "epoch", false); player.reload(); player.audition(a, [a]);
    expect(player.snapshot().unavailable).toBe(true); expect(elements).toHaveLength(1);
    player.close(); player.reconcile(roots(source("other")), "epoch", false);
    player.present(a); player.audition(a, [a]); player.reload(); player.next(); player.previous(); player.play();
    expect(player.snapshot().source).toBeNull(); expect(elements).toHaveLength(1);
    expect(element.plays).toBe(1);
  });
  test("removal identities are root-qualified even for identical ids and relative paths", () => {
    const { player, elements } = setup();
    const a = source("same"), other = { ...a, rootId: "other-root" };
    const inventory = [...roots(a), { ...roots(other)[0]!, id: other.rootId, path: other.rootId }];
    player.reconcile(inventory, "epoch"); player.audition(other, [other, a]); player.setLoop(true);
    player.reconcile([], "epoch", false, [{ rootId: a.rootId, id: a.id }]);
    expect(player.snapshot()).toMatchObject({ source: other, playing: true, loop: true, unavailable: false, canNext: false });
    expect(elements[0]!.src).not.toBe("");
    player.close(); player.present(a); expect(player.snapshot().source).toBeNull();
    player.present(other); expect(player.snapshot().source).toEqual(other);
    expect(elements[1]!.plays).toBe(0);
  });
  test("positive indexed reappearance clears removal evidence and permits only explicit fresh paused Reload", () => {
    const { player, elements } = setup();
    const a = source("a"), latest = source("a", 2);
    player.reconcile(roots(a), "epoch"); player.audition(a, [a]); player.setLoop(true);
    player.reconcile([], "epoch", false, [a]);
    player.reconcile(roots(latest), "epoch", false, [a]);
    expect(player.snapshot()).toMatchObject({ source: a, element: null, unavailable: false, newRenderAvailable: true,
      playing: false, loading: false, loop: false });
    expect(elements).toHaveLength(1);
    player.reload();
    expect(player.snapshot()).toMatchObject({ source: latest, position: 0, unavailable: false, newRenderAvailable: false, playing: false });
    expect(elements).toHaveLength(2); expect(elements[1]!.plays).toBe(0); expect(elements[1]!.paused).toBe(true);
  });
  test("an epoch change clears old removal evidence while still rejecting captured old-epoch sources", () => {
    const { player, elements } = setup();
    const a = source("a");
    player.reconcile(roots(a), "epoch"); player.audition(a, [a]);
    player.reconcile([], "epoch", false, [a]); player.close();
    player.reconcile([], "new-epoch", false);
    player.present(a); player.audition(a, [a]); expect(player.snapshot().source).toBeNull();
    const latest = source("a", 1, "new-epoch");
    player.present(latest);
    expect(player.snapshot().source).toEqual(latest);
    expect(elements).toHaveLength(2); expect(elements[1]!.plays).toBe(0);
  });
});
