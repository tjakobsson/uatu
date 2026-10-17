import { tabBarBottomInset } from "../shell/tab-bar";
import { onUiModeChange } from "../shell/ui-mode";

/** A restored page reports its final metrics a moment after the transition. */
const RESYNC_SETTLE_MS = 250;

export class ChatViewportController {
  private frame: number | null = null;
  private resyncFrame: number | null = null;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: ResizeObserver | null = null;
  private unsubscribeMode: (() => void) | null = null;
  private correctionPending = false;
  private lastTop: number | null = null;
  private lastHeight: number | null = null;
  private lastVisualHeight: number | null = null;
  private lastCovered: number | null = null;

  /** Every listener shares one frame: a pan must cost one write, not one per event. */
  private readonly schedule = () => {
    if (this.frame !== null) return;
    if (typeof requestAnimationFrame !== "function") { this.apply(); return; }
    this.frame = requestAnimationFrame(() => { this.frame = null; this.apply(); });
  };

  // A page can be restored with the keyboard already dismissed and no viewport
  // event at all, and the metrics reported at the transition are not yet the
  // ones the platform settles on — hence three passes rather than one.
  private readonly resync = () => {
    this.cancelResync();
    this.apply();
    if (typeof requestAnimationFrame === "function") {
      this.resyncFrame = requestAnimationFrame(() => { this.resyncFrame = null; this.apply(); });
    }
    this.resyncTimer = setTimeout(() => { this.resyncTimer = null; this.apply(); }, RESYNC_SETTLE_MS);
  };

  constructor(
    private readonly surface: HTMLElement,
    private readonly composer: HTMLElement,
    private readonly requestCorrection: () => void,
  ) {}

  start(): void {
    this.unsubscribeMode ??= onUiModeChange(this.schedule);
    window.visualViewport?.addEventListener("resize", this.schedule);
    window.visualViewport?.addEventListener("scroll", this.schedule);
    window.addEventListener("resize", this.schedule);
    document.addEventListener("visibilitychange", this.resync);
    window.addEventListener("pageshow", this.resync);
    window.addEventListener("focus", this.resync);
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(this.schedule);
      this.observer.observe(this.composer);
      this.observer.observe(this.surface);
    }
    this.apply();
  }

  stop(): void {
    this.unsubscribeMode?.();
    this.unsubscribeMode = null;
    window.visualViewport?.removeEventListener("resize", this.schedule);
    window.visualViewport?.removeEventListener("scroll", this.schedule);
    window.removeEventListener("resize", this.schedule);
    document.removeEventListener("visibilitychange", this.resync);
    window.removeEventListener("pageshow", this.resync);
    window.removeEventListener("focus", this.resync);
    this.observer?.disconnect();
    if (this.frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    this.frame = null;
    this.cancelResync();
  }

  apply(): void {
    const viewport = window.visualViewport;
    // Pinch zoom is browser-owned, as in the desktop viewport controller.
    // Retain normal-scale geometry/state instead of mistaking magnification
    // for a software keyboard or fighting its pan with a scroll correction.
    if (viewport && Math.abs((viewport.scale ?? 1) - 1) > 0.01) return;
    const height = viewport?.height ?? window.innerHeight;
    const top = viewport?.offsetTop ?? 0;
    const metrics = chatViewportMetrics(height, top, window.innerHeight, tabBarBottomInset());
    const root = document.documentElement;
    root.toggleAttribute("data-chat-keyboard", metrics.keyboardVisible);
    const touch = root.getAttribute("data-ui-mode") === "touch";
    root.toggleAttribute("data-chat-compact", touch && metrics.keyboardVisible && height <= 450);
    root.toggleAttribute("data-chat-short", touch && height <= 450);
    root.toggleAttribute("data-chat-wide-short", touch && height <= 390 && window.innerWidth >= 600);
    // While a request is being answered the keyboard covers the chrome rather
    // than removing it: the surface keeps its LAYOUT height, so the composer
    // and the pinned tracks slide down underneath the keyboard, still there
    // and back the moment it is dismissed. No tab-bar inset is netted off —
    // the bar is already hidden while a text control has focus.
    const answering = touch && root.hasAttribute("data-chat-answering");
    const surfaceHeight = answering ? window.innerHeight : metrics.height;
    // What the keyboard covers, so the transcript can reserve it: the part of
    // the surface that lies below the visible band. Independent of the pan,
    // because the surface's top tracks it.
    const covered = answering ? Math.max(0, window.innerHeight - height) : 0;
    // The answering surface keeps its layout height even when the visible
    // band shrinks. Only suppress a pan if that band is unchanged too.
    const pannedOnly = touch && this.lastTop !== null && this.lastTop !== top
      && this.lastHeight === surfaceHeight && this.lastVisualHeight === height;
    if (touch) {
      this.surface.style.removeProperty("--chat-panel-height");
      // Only transcript/dock containers own scrolling. Browser caret reveal
      // must not pan the surface's header or composer outside its hard band.
      this.surface.scrollTop = 0;
      // Rewriting a value the surface already carries re-enters through our own
      // ResizeObserver, so each write has to be a real change.
      if (this.lastTop !== top) this.surface.style.setProperty("--chat-visual-top", `${top}px`);
      if (this.lastHeight !== surfaceHeight) this.surface.style.setProperty("--chat-visual-height", `${surfaceHeight}px`);
      if (this.lastCovered !== covered) this.surface.style.setProperty("--chat-keyboard-inset", `${covered}px`);
      this.lastTop = top;
      this.lastHeight = surfaceHeight;
      this.lastVisualHeight = height;
      this.lastCovered = covered;
    } else {
      // Desktop's available band is the panel, not a guessed rem fallback
      // or the window: other shell surfaces can consume part of that height.
      const panelHeight = `${this.surface.clientHeight}px`;
      if (this.surface.style.getPropertyValue("--chat-panel-height") !== panelHeight) this.surface.style.setProperty("--chat-panel-height", panelHeight);
      // The desktop shell owns this rectangle, including its safe areas.
      this.surface.style.removeProperty("--chat-visual-top");
      this.surface.style.removeProperty("--chat-visual-height");
      this.surface.style.removeProperty("--chat-keyboard-inset");
      this.lastTop = null;
      this.lastHeight = null;
      this.lastVisualHeight = null;
      this.lastCovered = null;
    }
    const visible = document.visibilityState !== "hidden" && (touch
      ? root.getAttribute("data-active-tab") === "chat" : root.getAttribute("data-chat-panel") === "open" || root.hasAttribute("data-notification-chat"));
    if (!visible) {
      // Corrections are idempotent requests, so one replay owes for all of them.
      this.correctionPending = true;
      return;
    }
    // A caret-tracking pan moves the window over an unchanged document; the
    // reader did not ask for a new position. Height changes still correct.
    if (pannedOnly && root.hasAttribute("data-chat-editing") && !this.correctionPending) return;
    this.correctionPending = false;
    this.requestCorrection();
  }

  private cancelResync(): void {
    if (this.resyncFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.resyncFrame);
    this.resyncFrame = null;
    if (this.resyncTimer !== null) clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
  }
}

export function chatViewportMetrics(visualHeight: number, visualTop: number, layoutHeight: number, tabBarInset: number): { height: number; tabInset: number; keyboardVisible: boolean } {
  const occluded = Math.max(0, layoutHeight - visualTop - visualHeight);
  const tabInset = Math.max(0, tabBarInset - occluded);
  // A platform that pans the page under the keyboard occludes less than the
  // keyboard takes; the layout/visual height difference sees it either way.
  return { height: Math.max(0, visualHeight - tabInset), tabInset, keyboardVisible: layoutHeight - visualHeight > Math.max(80, tabBarInset) };
}
