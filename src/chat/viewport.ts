import type { TimelineAnchorController } from "./anchor";
import { tabBarBottomInset } from "../shell/tab-bar";

export class ChatViewportController {
  private readonly resize = () => this.apply();
  private observer: ResizeObserver | null = null;

  constructor(
    private readonly surface: HTMLElement,
    private readonly composer: HTMLElement,
    private readonly timeline: HTMLElement,
    private readonly anchor: TimelineAnchorController,
  ) {}

  start(): void {
    window.visualViewport?.addEventListener("resize", this.resize);
    window.visualViewport?.addEventListener("scroll", this.resize);
    window.addEventListener("resize", this.resize);
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(this.resize);
      this.observer.observe(this.composer);
    }
    this.apply();
  }

  stop(): void {
    window.visualViewport?.removeEventListener("resize", this.resize);
    window.visualViewport?.removeEventListener("scroll", this.resize);
    window.removeEventListener("resize", this.resize);
    this.observer?.disconnect();
  }

  apply(): void {
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    const top = viewport?.offsetTop ?? 0;
    const metrics = chatViewportMetrics(height, top, window.innerHeight, tabBarBottomInset());
    document.documentElement.toggleAttribute("data-chat-keyboard", metrics.keyboardVisible);
    this.surface.style.setProperty("--chat-visual-top", `${top}px`);
    this.surface.style.setProperty("--chat-visual-height", `${metrics.height}px`);
    this.surface.style.setProperty("--chat-composer-height", `${this.composer.offsetHeight}px`);
    if (this.anchor.isPinned()) this.timeline.scrollTop = Math.max(0, this.timeline.scrollHeight - this.timeline.clientHeight);
  }
}

export function chatViewportMetrics(visualHeight: number, visualTop: number, layoutHeight: number, tabBarInset: number): { height: number; tabInset: number; keyboardVisible: boolean } {
  const occluded = Math.max(0, layoutHeight - visualTop - visualHeight);
  const tabInset = Math.max(0, tabBarInset - occluded);
  return { height: Math.max(0, visualHeight - tabInset), tabInset, keyboardVisible: occluded > Math.max(80, tabBarInset) };
}
