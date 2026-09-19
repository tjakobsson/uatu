import { tabBarBottomInset } from "../shell/tab-bar";
import { onUiModeChange } from "../shell/ui-mode";

export class ChatViewportController {
  private readonly resize = () => this.apply();
  private observer: ResizeObserver | null = null;
  private unsubscribeMode: (() => void) | null = null;

  constructor(
    private readonly surface: HTMLElement,
    private readonly composer: HTMLElement,
    private readonly requestCorrection: () => void,
  ) {}

  start(): void {
    this.unsubscribeMode ??= onUiModeChange(this.resize);
    window.visualViewport?.addEventListener("resize", this.resize);
    window.visualViewport?.addEventListener("scroll", this.resize);
    window.addEventListener("resize", this.resize);
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(this.resize);
      this.observer.observe(this.composer);
      this.observer.observe(this.surface);
    }
    this.apply();
  }

  stop(): void {
    this.unsubscribeMode?.();
    this.unsubscribeMode = null;
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
    const root = document.documentElement;
    const touch = root.getAttribute("data-ui-mode") === "touch";
    if (touch) {
      this.surface.style.setProperty("--chat-visual-top", `${top}px`);
      this.surface.style.setProperty("--chat-visual-height", `${metrics.height}px`);
    } else {
      // The desktop shell owns this rectangle, including its safe areas.
      this.surface.style.removeProperty("--chat-visual-top");
      this.surface.style.removeProperty("--chat-visual-height");
    }
    const visible = document.visibilityState !== "hidden" && (touch
      ? root.getAttribute("data-active-tab") === "chat" : root.getAttribute("data-chat-panel") === "open" || root.hasAttribute("data-notification-chat"));
    if (visible) this.requestCorrection();
  }
}

export function chatViewportMetrics(visualHeight: number, visualTop: number, layoutHeight: number, tabBarInset: number): { height: number; tabInset: number; keyboardVisible: boolean } {
  const occluded = Math.max(0, layoutHeight - visualTop - visualHeight);
  const tabInset = Math.max(0, tabBarInset - occluded);
  return { height: Math.max(0, visualHeight - tabInset), tabInset, keyboardVisible: occluded > Math.max(80, tabBarInset) };
}
