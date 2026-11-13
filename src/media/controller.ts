import type { DocumentMeta, RootGroup } from "../shared/types";
import type { DocumentReference } from "../shared/document-updates";
import { mediaKind, mediaUrl } from "../shared/media";

export type MediaSource = {
  id: string; rootId: string; relativePath: string; name: string;
  epoch: string; revision: number; kind: "audio" | "video";
};
export type MediaSnapshot = {
  source: MediaSource | null; element: HTMLMediaElement | null;
  playing: boolean; loading: boolean; position: number; duration: number | null;
  loop: boolean; newRenderAvailable: boolean; unavailable: boolean; error: string | null;
  canPrevious: boolean; canNext: boolean;
};
export function mediaSource(doc: DocumentMeta, epoch: string | null): MediaSource | null {
  const kind = mediaKind(doc.name);
  if (!kind || !epoch || !Number.isSafeInteger(doc.revision) || doc.revision! < 0) return null;
  return { id: doc.id, rootId: doc.rootId, relativePath: doc.relativePath, name: doc.name,
    epoch, revision: doc.revision!, kind };
}
const key = (source: DocumentReference) => JSON.stringify([source.rootId, source.id]);
const empty = (): MediaSnapshot => ({ source: null, element: null, playing: false, loading: false,
  position: 0, duration: null, loop: false, newRenderAvailable: false, unavailable: false,
  error: null, canPrevious: false, canNext: false });

// The factory makes lifecycle tests independent of the page-local singleton.
export function createMediaPlayer(createElement = (kind: "audio" | "video"): HTMLMediaElement => document.createElement(kind)) {
  let state = empty();
  let generation = 0;
  let playRequest = 0;
  let inventory = new Map<string, MediaSource>();
  let inventoryEpoch: string | null | undefined;
  const removed = new Set<string>();
  let authoritative = false;
  let order: MediaSource[] = [];
  let defaultHost: HTMLElement | null = null;
  let parking: HTMLElement | null = null;
  const listeners = new Set<(snapshot: MediaSnapshot) => void>();
  function resolveSource(source: MediaSource): MediaSource | null {
    if (removed.has(key(source))) return null;
    return inventory.get(key(source)) ?? (!authoritative &&
      (inventoryEpoch === undefined || source.epoch === inventoryEpoch) ? source : null);
  }
  function neighbor(direction: number) {
    if (!state.source) return null;
    const index = order.findIndex(item => key(item) === key(state.source!));
    if (index < 0) return null;
    for (let i = index + direction; i >= 0 && i < order.length; i += direction) {
      const candidate = resolveSource(order[i]!);
      if (candidate) return candidate;
    }
    return null;
  }
  function snapshot(): MediaSnapshot {
    return { ...state, canPrevious: !!neighbor(-1), canNext: !!neighbor(1) };
  }
  function emit() { const value = snapshot(); for (const listener of listeners) listener(value); }
  function release() {
    generation++; playRequest++;
    const element = state.element;
    state.element = null;
    if (element) { element.loop = false; element.pause(); element.removeAttribute("src"); element.load(); element.remove(); }
  }
  function attachDefaultElement() {
    if (!state.element) return;
    if (!defaultHost && !parking) {
      parking = document.createElement("div");
      parking.hidden = true;
      document.body.append(parking);
    }
    const host = defaultHost ?? parking;
    if (host && state.element.parentElement !== host) host.append(state.element);
  }
  function select(source: MediaSource) {
    release();
    state = { ...empty(), source, loading: true };
    const element = createElement(source.kind);
    state.element = element;
    element.preload = "metadata";
    element.controls = true;
    element.setAttribute("playsinline", "");
    const ownGeneration = generation;
    const current = () => ownGeneration === generation && state.element === element;
    const update = () => {
      if (!current()) return;
      state.playing = !element.paused && !element.ended;
      state.position = Number.isFinite(element.currentTime) ? element.currentTime : 0;
      state.duration = Number.isFinite(element.duration) ? element.duration : null;
      emit();
    };
    for (const event of ["timeupdate", "durationchange", "play", "pause", "ended", "seeked"]) element.addEventListener(event, update);
    for (const event of ["loadedmetadata", "canplay"]) element.addEventListener(event, () => {
      if (!current()) return;
      state.loading = false; update();
    });
    element.addEventListener("error", () => {
      if (!current()) return;
      state.loading = false; state.playing = false;
      state.error = state.newRenderAvailable ? "New render available. Reload to use it." :
        "Playback unavailable. The file may be incomplete or its codec unsupported. Retry or download the file.";
      emit();
    });
    element.src = mediaUrl(source, source.epoch);
    attachDefaultElement();
    emit();
  }
  function play() {
    const element = state.element;
    if (!element || state.unavailable || state.newRenderAvailable) return;
    const ownGeneration = generation;
    const request = ++playRequest;
    state.error = null;
    // Do not put an await, fetch, or subscriber callback before native play.
    try {
      const result = element.play();
      void result?.catch(error => {
        if (generation !== ownGeneration || request !== playRequest) return;
        state.playing = false; state.loading = false;
        state.error = `Could not play. Press Play to retry. ${error instanceof Error ? error.message : String(error)}`;
        emit();
      });
    } catch (error) {
      state.error = `Could not play. Press Play to retry. ${String(error)}`;
    }
    emit();
  }
  return {
    snapshot,
    subscribe(listener: (snapshot: MediaSnapshot) => void) { listeners.add(listener); listener(snapshot()); return () => { listeners.delete(listener); }; },
    reconcile(roots: RootGroup[], epoch: string | null, complete = true, removals: readonly DocumentReference[] = []) {
      const next = complete || epoch !== inventoryEpoch ? new Map<string, MediaSource>() : new Map(inventory);
      if (epoch !== inventoryEpoch) removed.clear();
      for (const reference of removals) {
        const identity = key(reference);
        removed.add(identity); next.delete(identity);
      }
      for (const root of roots) for (const doc of root.docs) {
        const source = mediaSource(doc, epoch);
        if (source) {
          removed.delete(key(source)); next.set(key(source), source);
        }
      }
      // A complete inventory is also positive removal evidence. Do not forget
      // that evidence if a later update returns to partial discovery.
      if (complete) {
        if (epoch === inventoryEpoch) for (const identity of inventory.keys()) {
          if (!next.has(identity)) removed.add(identity);
        }
        for (const source of order) if (source.epoch === epoch && !next.has(key(source))) removed.add(key(source));
      }
      inventory = next; inventoryEpoch = epoch; authoritative = complete;
      if (state.source) {
        const latest = inventory.get(key(state.source));
        if (!latest && (complete || removed.has(key(state.source)))) {
          release(); state.playing = false; state.loading = false; state.loop = false; state.unavailable = true;
          state.error = "File unavailable. It may have been removed or excluded.";
        } else if (epoch !== state.source.epoch || latest && (state.unavailable || latest.revision !== state.source.revision)) {
          state.unavailable = false; state.error = null;
          state.newRenderAvailable = true; state.loop = false;
          // Stop old requests as soon as their revision is known to be stale.
          release(); state.playing = false; state.loading = false;
        }
      }
      emit();
    },
    present(source: MediaSource) {
      const current = resolveSource(source);
      if (!state.source && current) { order = [current]; select(current); }
    },
    audition(source: MediaSource, capturedOrder: readonly MediaSource[]) {
      const current = resolveSource(source);
      if (!current) return;
      source = current;
      order = [...capturedOrder];
      if (!state.source || key(state.source) !== key(source) || state.source.epoch !== source.epoch || state.source.revision !== source.revision || !state.element) select(source);
      play();
    },
    play,
    pause() { playRequest++; state.element?.pause(); state.playing = false; emit(); },
    seek(seconds: number) {
      if (!state.element || !Number.isFinite(seconds)) return;
      try { state.element.currentTime = Math.max(0, Math.min(seconds, state.duration ?? Infinity)); } catch { /* Metadata not loaded yet. */ }
    },
    setLoop(loop: boolean) { state.loop = loop && !state.newRenderAvailable && !state.unavailable; if (state.element) state.element.loop = state.loop; emit(); },
    previous() { const source = neighbor(-1); if (source) { select(source); play(); } },
    next() { const source = neighbor(1); if (source) { select(source); play(); } },
    reload() {
      if (!state.source || state.unavailable) return;
      const source = resolveSource(state.source);
      if (source) select(source);
    },
    close() { release(); order = []; state = empty(); emit(); },
    attachElement(host: HTMLElement) { if (state.element && state.element.parentElement !== host) host.append(state.element); },
    setDefaultElementHost(host: HTMLElement) { defaultHost = host; attachDefaultElement(); },
    attachDefaultElement,
  };
}
export const mediaPlayer = createMediaPlayer();
