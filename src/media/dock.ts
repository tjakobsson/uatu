import { mediaPlayer, type MediaSnapshot } from "./controller";
import { MEDIA_LAYOUT_EVENT, mediaLayoutGeometry } from "./layout";
import { onUiModeChange } from "../shell/ui-mode";
import { onActiveTabChange, tabBarBottomInset } from "../shell/tab-bar";

export function mediaTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const value = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(value % 60).padStart(2, "0")}`;
}

/** Mounted once before boot. No source ownership or navigation lives here. */
export function initMediaDock(player = mediaPlayer): () => void {
  const root = document.documentElement;
  const dock = document.createElement("section");
  dock.id = "media-dock";
  dock.className = "media-dock";
  dock.setAttribute("aria-label", "Media player");
  dock.hidden = true;
  const host = document.createElement("div");
  host.className = "media-dock-element";
  const identity = document.createElement("div");
  identity.className = "media-dock-identity";
  const name = document.createElement("strong");
  const path = document.createElement("span");
  identity.append(name, path);
  const controls = document.createElement("div");
  controls.className = "media-dock-controls";
  function button(label: string, action: () => void) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.setAttribute("aria-label", label);
    element.addEventListener("click", action);
    controls.append(element);
    return element;
  }
  const previous = button("Previous clip", () => { void player.previous(); });
  previous.textContent = "Prev";
  const play = button("Play", () => { if (player.snapshot().playing) player.pause(); else void player.play(); });
  const next = button("Next clip", () => { void player.next(); });
  next.textContent = "Next";
  const loop = button("Loop current clip", () => player.setLoop(!player.snapshot().loop));
  loop.textContent = "Loop";
  let expanded = false;
  let state: MediaSnapshot = player.snapshot();
  const expand = button("Expand video", () => {
    expanded = !expanded;
    if (state.element && state.element.parentElement !== host) player.attachElement(host);
    render(state);
  });
  expand.textContent = "Expand";
  const fullscreen = button("Fullscreen video", () => {
    const element = state.element as HTMLVideoElement & { webkitEnterFullscreen?: () => void } | null;
    if (!element) return;
    if (element.requestFullscreen) {
      void element.requestFullscreen().catch(() => { notice.textContent = "Fullscreen unavailable. Use Expand video."; });
    } else element.webkitEnterFullscreen?.();
  });
  fullscreen.textContent = "Fullscreen";
  const close = button("Close player", () => player.close());
  close.textContent = "Close";
  const timeline = document.createElement("div");
  timeline.className = "media-dock-timeline";
  const elapsed = document.createElement("span");
  const seek = document.createElement("input");
  seek.type = "range";
  seek.min = "0";
  seek.step = "0.1";
  seek.setAttribute("aria-label", "Playback position");
  let draggingSeek = false;
  seek.addEventListener("pointerdown", () => { draggingSeek = true; });
  const endSeek = () => { draggingSeek = false; };
  window.addEventListener("pointerup", endSeek);
  window.addEventListener("pointercancel", endSeek);
  const duration = document.createElement("span");
  seek.addEventListener("input", () => player.seek(Number(seek.value)));
  timeline.append(elapsed, seek, duration);
  const status = document.createElement("div");
  status.className = "media-dock-status";
  const notice = document.createElement("span");
  notice.setAttribute("role", "status");
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => player.reload());
  status.append(notice, reload);
  dock.append(host, identity, controls, timeline, status);
  document.body.append(dock);
  player.setDefaultElementHost(host);

  let frame: number | null = null;
  let lastHeight = -1;
  let lastInset = -1;
  const measure = () => {
    frame = null;
    const viewport = window.visualViewport;
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const visualHeight = viewport?.height ?? window.innerHeight;
    const visualTop = viewport?.offsetTop ?? 0;
    if (state.element && (expanded || (root.getAttribute("data-ui-mode") === "touch" && root.getAttribute("data-active-tab") !== "preview"))
      && state.element.parentElement !== host) park();
    const geometry = mediaLayoutGeometry(window.innerHeight, visualHeight, visualTop, tabBarBottomInset(), 0);
    dock.style.bottom = `${geometry.dockBottom}px`;
    dock.style.setProperty("--media-available-height", `${visualHeight}px`);
    dock.toggleAttribute("data-safe-bottom", geometry.tabInset === 0 && geometry.occluded < 1);
    const height = dock.hidden ? 0 : dock.getBoundingClientRect().height;
    const inset = geometry.dockBottom + height;
    root.style.setProperty("--media-bottom-inset", `${inset}px`);
    root.style.setProperty("--media-visual-top", `${visualTop}px`);
    root.style.setProperty("--media-dock-height", `${height}px`);
    if (height !== lastHeight || inset !== lastInset) {
      lastHeight = height; lastInset = inset;
      document.dispatchEvent(new Event(MEDIA_LAYOUT_EVENT));
    }
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure); };
  function park() {
    if (state.element && state.element.parentElement !== host) player.attachDefaultElement();
  }
  function render(snapshot: MediaSnapshot) {
    state = snapshot;
    dock.hidden = !snapshot.source;
    root.toggleAttribute("data-media-player", !!snapshot.source);
    if (!snapshot.source) expanded = false;
    dock.toggleAttribute("data-expanded", expanded && snapshot.source?.kind === "video");
    dock.toggleAttribute("data-video", snapshot.source?.kind === "video");
    name.textContent = snapshot.source?.name ?? "";
    path.textContent = snapshot.source ? `${snapshot.source.rootId}/${snapshot.source.relativePath}` : "";
    path.title = path.textContent;
    play.textContent = snapshot.playing ? "Pause" : "Play";
    play.setAttribute("aria-label", play.textContent);
    play.disabled = snapshot.unavailable || snapshot.newRenderAvailable;
    previous.disabled = !snapshot.canPrevious;
    next.disabled = !snapshot.canNext;
    loop.setAttribute("aria-pressed", String(snapshot.loop));
    loop.disabled = snapshot.unavailable || snapshot.newRenderAvailable;
    expand.hidden = snapshot.source?.kind !== "video";
    expand.textContent = expanded ? "Compact" : "Expand";
    expand.setAttribute("aria-label", expanded ? "Compact video" : "Expand video");
    expand.setAttribute("aria-expanded", String(expanded));
    fullscreen.hidden = snapshot.source?.kind !== "video" || !snapshot.element ||
      !(snapshot.element.requestFullscreen || (snapshot.element as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen);
    elapsed.textContent = mediaTime(snapshot.position);
    duration.textContent = mediaTime(snapshot.duration);
    seek.disabled = snapshot.duration === null || snapshot.unavailable || snapshot.newRenderAvailable;
    seek.max = String(snapshot.duration ?? 0);
    // Keep the native range node and its focus through every timeupdate.
    if (!draggingSeek) seek.value = String(snapshot.position);
    seek.setAttribute("aria-valuetext", `${mediaTime(snapshot.position)} of ${mediaTime(snapshot.duration)}`);
    notice.textContent = snapshot.unavailable ? "This clip is no longer available." : snapshot.newRenderAvailable
      ? "New render available" : snapshot.error ?? (snapshot.loading ? "Loading media…" : "");
    reload.hidden = snapshot.unavailable || !(snapshot.newRenderAvailable || snapshot.error);
    status.hidden = !notice.textContent;
    if (snapshot.element && expanded && snapshot.element.parentElement !== host) player.attachElement(host);
    schedule();
  }
  const stopPlayer = player.subscribe(render);
  const stopMode = onUiModeChange(() => { park(); schedule(); });
  const stopTab = onActiveTabChange(() => { schedule(); });
  // Park BEFORE the Preview ancestor is hidden. WebKit may pause an offscreen
  // video even though the page-local controller still owns it.
  document.addEventListener("uatu:before-surface-change", park);
  const observer = new ResizeObserver(schedule);
  observer.observe(dock);
  const bar = document.getElementById("touch-tab-bar");
  if (bar) observer.observe(bar);
  const attributes = new MutationObserver(schedule);
  attributes.observe(root, { attributes: true, attributeFilter: ["data-ui-mode", "data-active-tab", "data-chat-keyboard", "data-chat-input-focused", "data-chat-editing"] });
  const placement = new MutationObserver(schedule);
  placement.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  if (frame !== null) cancelAnimationFrame(frame);
  measure();
  return () => {
    stopPlayer(); stopMode(); stopTab(); observer.disconnect(); attributes.disconnect(); placement.disconnect();
    document.removeEventListener("uatu:before-surface-change", park);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("pointerup", endSeek);
    window.removeEventListener("pointercancel", endSeek);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
    if (frame !== null) cancelAnimationFrame(frame);
    player.close();
    dock.remove();
    root.removeAttribute("data-media-player");
    root.style.removeProperty("--media-dock-height");
    root.style.removeProperty("--media-bottom-inset");
    root.style.removeProperty("--media-visual-top");
    document.dispatchEvent(new Event(MEDIA_LAYOUT_EVENT));
  };
}
