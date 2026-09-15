import type { ShellOutputController } from "./shell-output";
import { setChatInert } from "./inert";

export type ShellWindowGeometry = { x: number; y: number; width: number; height: number };
export type ShellWindowOptions = {
  workArea?: () => ShellWindowGeometry;
  touch?: () => boolean;
  /** Roots covered in full-area mode. The body-mounted output is never inert. */
  coveredRoots?: () => HTMLElement[];
};

export function clampShellWindow(rect: ShellWindowGeometry, area: ShellWindowGeometry): ShellWindowGeometry {
  const width = Math.max(Math.min(300, area.width), Math.min(rect.width, area.width));
  const height = Math.max(Math.min(180, area.height), Math.min(rect.height, area.height));
  return { width, height, x: Math.max(area.x, Math.min(rect.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(rect.y, area.y + area.height - height)) };
}

function defaultWorkArea(): ShellWindowGeometry {
  const viewport = window.visualViewport;
  let x = viewport?.offsetLeft ?? 0;
  let y = viewport?.offsetTop ?? 0;
  let right = x + (viewport?.width ?? window.innerWidth);
  let bottom = y + (viewport?.height ?? window.innerHeight);
  // Persistent navigation remains available, including the touch tab bar.
  for (const node of document.querySelectorAll<HTMLElement>("#touch-tab-bar, .sidebar-rail")) {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (rect.width > rect.height && rect.bottom >= bottom - 1) bottom = Math.min(bottom, rect.top);
    else if (rect.height > rect.width && rect.left <= x + 1) x = Math.max(x, rect.right);
  }
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** Single app-level owner; controllers retain their own desktop rectangles. */
export class ShellOutputWindow {
  owner: ShellOutputController | null = null;
  private host?: HTMLElement;
  private title?: HTMLElement;
  private metadata?: HTMLElement;
  private content?: HTMLElement;
  private returnButton?: HTMLButtonElement;
  private maximizeButton?: HTMLButtonElement;
  private move?: HTMLElement;
  private resize?: HTMLElement;
  private maximized = false;
  private hidden = false;
  private options: ShellWindowOptions;
  private inert = new Set<HTMLElement>();
  private cleanup: (() => void)[] = [];
  private drag?: { target: HTMLElement; id: number; x: number; y: number; rect: ShellWindowGeometry; resize: boolean };
  private frame?: number;
  private pending?: ShellWindowGeometry;
  private modeObserver?: MutationObserver;
  private placeholder?: HTMLButtonElement;

  constructor(options: ShellWindowOptions = {}) { this.options = options; }
  configure(options: ShellWindowOptions): void { this.options = options; if (this.owner) this.layout(); }
  get viewport(): HTMLElement | null { return this.owner && !this.hidden ? this.owner.viewport : null; }
  get element(): HTMLElement | undefined { return this.host; }
  private area(): ShellWindowGeometry { return (this.options.workArea ?? defaultWorkArea)(); }
  private touch(): boolean { return this.options.touch?.() ?? document.documentElement.dataset.uiMode === "touch"; }
  private full(): boolean { return this.maximized || this.touch(); }

  open(owner: ShellOutputController): void {
    if (this.owner === owner) { this.returnButton?.focus({ preventScroll: true }); return; }
    this.close(false);
    this.owner = owner; this.hidden = false; this.maximized = false;
    owner.inspect();
    this.createHost();
    const area = this.area();
    owner.floatingGeometry ??= clampShellWindow({ x: area.x + 32, y: area.y + 32, width: Math.min(900, area.width * 0.8), height: Math.min(560, area.height * 0.75) }, area);
    owner.mutate(() => {
      owner.slot.style.minHeight = `${owner.slot.getBoundingClientRect().height || owner.inlineHeight + 80}px`;
      owner.slot.classList.add("is-popped-out");
      this.placeholder = document.createElement("button");
      this.placeholder.type = "button";
      this.placeholder.textContent = "Output is in floating window · Focus output";
      this.placeholder.addEventListener("click", () => this.returnButton?.focus({ preventScroll: true }));
      owner.slot.append(this.placeholder);
      // Find indexes semantic visibility, not computed styles. These inline
      // controls are absent from the floating output, including its index.
      owner.command.hidden = owner.popout.hidden = owner.resize.hidden = true;
      this.content!.append(owner.element);
      this.layout();
    });
    this.refresh(owner);
    this.returnButton!.focus({ preventScroll: true });
  }

  private createHost(): void {
    const host = this.host = document.createElement("section");
    host.className = "chat-shell-window";
    host.setAttribute("role", "region");
    host.setAttribute("aria-label", "Shell output window");
    const header = document.createElement("header");
    header.className = "chat-shell-window-header";
    this.title = document.createElement("div");
    this.title.className = "chat-shell-window-title";
    this.metadata = document.createElement("div");
    this.metadata.className = "chat-shell-window-metadata";
    this.move = document.createElement("div");
    this.move.className = "chat-shell-window-move";
    this.move.tabIndex = 0;
    this.move.setAttribute("role", "group");
    this.move.setAttribute("aria-label", "Move output window. Use arrow keys");
    this.move.append(this.title, this.metadata);
    this.returnButton = document.createElement("button");
    this.returnButton.type = "button"; this.returnButton.textContent = "Return to chat";
    this.returnButton.addEventListener("click", () => this.close());
    this.maximizeButton = document.createElement("button");
    this.maximizeButton.type = "button"; this.maximizeButton.textContent = "Maximize";
    this.maximizeButton.addEventListener("click", () => this.toggleMaximize());
    header.append(this.move, this.maximizeButton, this.returnButton);
    this.content = document.createElement("div"); this.content.className = "chat-shell-window-content";
    this.resize = document.createElement("div"); this.resize.className = "chat-shell-window-resize";
    this.resize.tabIndex = 0; this.resize.setAttribute("role", "group");
    this.resize.setAttribute("aria-label", "Resize output window. Left and Right change width; Up and Down change height");
    this.resize.textContent = "Resize";
    this.bindGeometryControl(this.move, false); this.bindGeometryControl(this.resize, true);
    host.append(header, this.content, this.resize);
    // Outside every renderer ancestor: inerting covered Chat cannot inert the
    // moved viewport, and neither transcript padding nor overflow clips it.
    document.body.append(host);
    host.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented || (event.target as Element).closest('[role="dialog"], [role="listbox"], [data-shell-escape-priority]')) return;
      event.preventDefault(); event.stopImmediatePropagation(); this.close();
    }, true);
    const layout = () => this.layout();
    window.addEventListener("resize", layout);
    window.visualViewport?.addEventListener("resize", layout);
    window.visualViewport?.addEventListener("scroll", layout);
    this.cleanup.push(() => {
      window.removeEventListener("resize", layout);
      window.visualViewport?.removeEventListener("resize", layout);
      window.visualViewport?.removeEventListener("scroll", layout);
    });
    if (typeof MutationObserver !== "undefined") {
      this.modeObserver = new MutationObserver(layout);
      this.modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-mode"] });
    }
  }

  private bindGeometryControl(control: HTMLElement, resize: boolean): void {
    control.addEventListener("keydown", event => {
      if (this.full() || !this.owner) return;
      const step = event.shiftKey ? 40 : 10;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      if (!dx && !dy) return;
      event.preventDefault(); event.stopPropagation();
      const rect = clampShellWindow(this.owner.floatingGeometry!, this.area());
      this.setGeometry(resize ? { ...rect, width: rect.width + dx, height: rect.height + dy } : { ...rect, x: rect.x + dx, y: rect.y + dy });
    });
    control.addEventListener("pointerdown", event => {
      if (this.full() || !this.owner || event.button !== 0) return;
      event.preventDefault(); control.focus({ preventScroll: true });
      this.drag = { target: control, id: event.pointerId, x: event.clientX, y: event.clientY, rect: clampShellWindow(this.owner.floatingGeometry!, this.area()), resize };
      control.setPointerCapture(event.pointerId);
    });
    control.addEventListener("pointermove", event => {
      const drag = this.drag;
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      this.pending = drag.resize ? { ...drag.rect, width: drag.rect.width + dx, height: drag.rect.height + dy } : { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy };
      if (this.frame !== undefined) return;
      this.frame = requestAnimationFrame(() => { this.frame = undefined; if (this.pending) this.setGeometry(this.pending); this.pending = undefined; });
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) control.addEventListener(event, () => this.releasePointer(true));
  }

  setGeometry(rect: ShellWindowGeometry): void {
    if (!this.owner || this.full() || !Object.values(rect).every(Number.isFinite)) return;
    this.owner.floatingGeometry = clampShellWindow(rect, this.area());
    this.owner.mutate(() => this.layout());
  }

  toggleMaximize(): void {
    if (!this.owner || this.touch()) return;
    this.releasePointer(true);
    this.owner.mutate(() => { this.maximized = !this.maximized; this.layout(); });
  }

  layout(): void {
    if (!this.owner || !this.host) return;
    const area = this.area();
    const full = this.full();
    if (full) this.releasePointer(false);
    const rect = full ? area : clampShellWindow(this.owner.floatingGeometry!, area);
    this.host.style.left = `${rect.x}px`; this.host.style.top = `${rect.y}px`;
    this.host.style.width = `${rect.width}px`; this.host.style.height = `${rect.height}px`;
    this.host.classList.toggle("is-full-area", full);
    this.host.hidden = this.hidden;
    this.maximizeButton!.textContent = this.maximized ? "Restore size" : "Maximize";
    this.maximizeButton!.hidden = this.touch();
    this.move!.tabIndex = full ? -1 : 0;
    this.resize!.hidden = full;
    if (full && (document.activeElement === this.move || document.activeElement === this.resize
      || (this.maximizeButton!.hidden && document.activeElement === this.maximizeButton))) this.returnButton?.focus({ preventScroll: true });
    this.move!.setAttribute("aria-label", `Move output window. Use arrow keys. X ${Math.round(rect.x)}, Y ${Math.round(rect.y)}. X bounds ${area.x} to ${Math.round(area.x + area.width - rect.width)}; Y bounds ${area.y} to ${Math.round(area.y + area.height - rect.height)}`);
    this.resize!.setAttribute("aria-label", `Resize output window. Left and Right change width; Up and Down change height. Width ${Math.round(rect.width)}, height ${Math.round(rect.height)}. Width bounds ${Math.min(300, area.width)} to ${Math.round(area.width)}; height bounds ${Math.min(180, area.height)} to ${Math.round(area.height)}`);
    this.restoreInert();
    if (full && !this.hidden) {
      const roots = this.options.coveredRoots?.() ?? this.defaultCoveredRoots(area);
      for (const root of roots) {
        if (root === this.host || root.contains(this.host) || root.matches('[role="dialog"], dialog, #touch-tab-bar, .sidebar-rail')) continue;
        this.inert.add(root); setChatInert(root, this, true);
      }
      if (!this.host.contains(document.activeElement) && [...this.inert.keys()].some(root => root.contains(document.activeElement))) this.returnButton?.focus({ preventScroll: true });
    }
    if (!this.hidden) this.owner.scroll.request();
  }

  private defaultCoveredRoots(area: ShellWindowGeometry): HTMLElement[] {
    const roots: HTMLElement[] = [];
    const accessible = 'dialog, [role="dialog"], [popover], #touch-tab-bar, .sidebar-rail';
    const walk = (parent: HTMLElement) => {
      for (const node of Array.from(parent.children) as HTMLElement[]) {
        if (node === this.host || node.matches(accessible)) continue;
        // Touch hides Preview entirely, so its shared Find bar has no bounds.
        // Keep it inert until Find reparents it into the active window.
        if (this.touch() && node.id === "find-bar") { roots.push(node); continue; }
        const rect = node.getBoundingClientRect();
        if (!node.querySelector(accessible) && rect.width && rect.height && rect.left >= area.x && rect.top >= area.y && rect.right <= area.x + area.width && rect.bottom <= area.y + area.height) roots.push(node);
        else walk(node);
      }
    };
    walk(document.body);
    return roots;
  }

  refresh(owner: ShellOutputController): void {
    if (this.owner !== owner || !this.title || this.hidden) return;
    this.title.textContent = owner.metadata.command;
    const data = owner.metadata;
    const outcome = data.status[0]!.toUpperCase() + data.status.slice(1);
    const time = data.completedAt !== undefined && Number.isFinite(data.completedAt) && data.status !== "running" && data.status !== "pending" ? ` · ${new Date(data.completedAt).toLocaleString()}` : "";
    this.metadata!.textContent = `${data.conversation} · ${outcome}${data.exitCode === undefined ? "" : ` · exit ${data.exitCode}`}${time}`;
    this.host!.dataset.status = data.status;
    this.host!.dataset.shellConversationId = owner.conversationId;
    this.host!.dataset.shellItemId = owner.itemId;
  }

  setOwnerHidden(owner: ShellOutputController, hidden: boolean): void {
    if (this.owner !== owner) return;
    this.hidden = hidden;
    if (hidden) this.releasePointer(false);
    this.layout();
    if (!hidden) this.refresh(owner);
  }

  closeOwner(owner: ShellOutputController): void { if (this.owner === owner) this.close(false); }

  close(restoreFocus = true): void {
    const owner = this.owner;
    if (!owner) return;
    this.releasePointer(false); this.restoreInert();
    this.modeObserver?.disconnect(); this.modeObserver = undefined;
    this.cleanup.forEach(fn => fn()); this.cleanup = [];
    owner.mutate(() => {
      this.placeholder?.remove(); this.placeholder = undefined;
      owner.slot.classList.remove("is-popped-out"); owner.slot.style.minHeight = "";
      owner.command.hidden = owner.popout.hidden = owner.resize.hidden = false;
      owner.slot.append(owner.element);
      this.host?.remove();
    });
    this.owner = null; this.host = undefined; this.hidden = false;
    if (restoreFocus && owner.popout.isConnected) owner.popout.focus({ preventScroll: true });
  }

  private restoreInert(): void { for (const node of this.inert) setChatInert(node, this, false); this.inert.clear(); }
  private releasePointer(apply: boolean): void {
    const drag = this.drag; this.drag = undefined;
    if (drag?.target.hasPointerCapture?.(drag.id)) drag.target.releasePointerCapture(drag.id);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    if (apply && this.pending) this.setGeometry(this.pending);
    this.pending = undefined;
  }
}

let singleton: ShellOutputWindow | undefined;
export function shellOutputWindow(): ShellOutputWindow { return singleton ??= new ShellOutputWindow(); }
export function currentFloatingShellOutput(): { viewport: HTMLElement; owner: ShellOutputController } | null {
  const window = shellOutputWindow();
  return window.viewport && window.owner ? { viewport: window.viewport, owner: window.owner } : null;
}

/** Find moves only this shell's reading anchor; it never invokes scrollIntoView. */
export function revealShellOutputMatch(range: Range): boolean {
  const floating = currentFloatingShellOutput();
  if (!floating || !floating.owner.element.contains(range.startContainer)) {
    const viewport = range.startContainer.parentElement?.closest<HTMLElement>(".chat-shell-viewport");
    if (viewport) {
      viewport.dispatchEvent(new CustomEvent("chat-shell-reveal", { detail: { range }, bubbles: true, cancelable: true }));
    } else {
      const error = range.startContainer.parentElement?.closest<HTMLElement>(".chat-shell-output .chat-tool-error");
      if (error) {
        const rect = range.getBoundingClientRect(), view = error.getBoundingClientRect();
        error.scrollTop += rect.top - view.top - 10;
        error.scrollLeft += rect.left - view.left - 10;
      }
    }
    // Inline matches still need the outer timeline brought into view.
    return false;
  }
  const rect = range.getBoundingClientRect();
  if (floating.viewport.contains(range.startContainer)) {
    const viewport = floating.viewport.getBoundingClientRect();
    floating.owner.scroll.reveal(floating.viewport.scrollTop + rect.top - viewport.top - 10, floating.viewport.scrollLeft + rect.left - viewport.left - 10);
  } else {
    // Error output and command metadata belong to the same searchable owner,
    // but live outside stdout's coordinated viewport.
    const container = floating.owner.element.closest<HTMLElement>(".chat-shell-window-content")!;
    const view = container.getBoundingClientRect();
    container.scrollTop += rect.top - view.top;
    const error = range.startContainer.parentElement?.closest<HTMLElement>(".chat-tool-error");
    if (error) {
      const view = error.getBoundingClientRect();
      error.scrollTop += rect.top - view.top;
      error.scrollLeft += rect.left - view.left;
    }
  }
  return true;
}
