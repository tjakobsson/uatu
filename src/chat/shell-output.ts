import { TerminalOutputBuffer, terminalLinesToHtml, terminalTextToHtml } from "./ansi";
import { CoordinatedScrollOwner, type CoordinatedScrollAnchor } from "./coordinated-scroll";
import type { AnchorGeometry } from "./anchor";
import { shellOutputWindow, type ShellWindowGeometry } from "./shell-output-window";
import type { ActivityStatus } from "./types";

export type ShellOutputMetadata = {
  command: string;
  conversation: string;
  status: ActivityStatus;
  description?: string;
  completedAt?: number;
  exitCode?: number;
};

/** Hooks capture the CURRENT outer anchor for each mutation, including return. */
export type ShellMutationHooks = { beforeMutation?: () => void; afterMutation?: () => void; inspected?: (preserveClosed?: boolean) => void };
export type ShellPresentation = {
  inlineHeight: number;
  floatingGeometry?: ShellWindowGeometry;
  readerOpened: boolean;
  scroll: { top: number; left: number; following: boolean; unseen: boolean };
  anchorHtml?: string;
  /** Exact last-painted raw output, shared as an immutable string, without a lossy hash or cap. */
  outputSnapshot: string;
};

/** Reparenting can clear a browser selection even when its text nodes survive. */
export function retainShellSelection(root: HTMLElement): () => void {
  const selection = document.getSelection?.();
  const anchor = selection?.anchorNode, focus = selection?.focusNode;
  if (!selection || !anchor || !focus || !root.contains(anchor) || !root.contains(focus)
    || !anchor.parentElement?.closest(".chat-shell-output")) return () => {};
  const anchorOffset = selection.anchorOffset, focusOffset = selection.focusOffset;
  return () => {
    if (!anchor.isConnected || !focus.isConnected) return;
    if (selection.anchorNode === anchor && selection.anchorOffset === anchorOffset && selection.focusNode === focus && selection.focusOffset === focusOffset) return;
    if (anchorOffset > (anchor.nodeType === 3 ? anchor.textContent!.length : anchor.childNodes.length)
      || focusOffset > (focus.nodeType === 3 ? focus.textContent!.length : focus.childNodes.length)) return;
    selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
  };
}

/** Shell-specific anchors; the shared owner owns all input and frame scheduling. */
export class ShellScrollOwner {
  following = true;
  unseen = false;
  private top = 0;
  private left = 0;
  private observedLeft = 0;
  private horizontalMaximum = 0;
  private clampReplacement = false;
  private readonly owner: CoordinatedScrollOwner;
  get readingTop(): number { return this.top; }
  snapshot(): ShellPresentation["scroll"] { return { top: this.top, left: this.left, following: this.following, unseen: this.unseen }; }
  restore(state: ShellPresentation["scroll"]): void {
    this.owner.cancel(); this.top = state.top; this.left = state.left; this.following = state.following; this.unseen = state.unseen;
    this.request(); this.changed();
  }

  constructor(readonly viewport: HTMLElement, private readonly changed: () => void = () => {}, active: () => boolean = () => true, private readonly inspected: () => void = () => {}) {
    this.left = this.observedLeft = viewport.scrollLeft || 0;
    this.horizontalMaximum = this.maximumLeft();
    const maximum = (geometry: AnchorGeometry) => Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    const anchor: CoordinatedScrollAnchor = {
      isPinned: () => this.following,
      // Fixed-height unwrapped lines retain an index plus pixel offset. Scroll
      // observations own this position; recapturing after a clamp would lose it.
      beforeMutation: () => this.captureHorizontal(),
      afterMutation: (geometry, newContent) => {
        if (newContent && !this.following) this.unseen = true;
        if (this.clampReplacement) { this.top = Math.min(this.top, maximum(geometry)); this.clampReplacement = false; }
        // The generic geometry model is vertical. Restore the horizontal anchor
        // in its SAME correction callback, with no second scheduler or listener.
        this.horizontalMaximum = this.maximumLeft();
        const left = Math.min(this.left, this.horizontalMaximum);
        if (viewport.scrollLeft !== left) viewport.scrollLeft = left;
        this.observedLeft = viewport.scrollLeft || 0;
        return this.following ? maximum(geometry) : Math.min(this.top, maximum(geometry));
      },
      jumpToLatest: geometry => {
        this.captureHorizontal();
        this.following = true; this.unseen = false;
        return maximum(geometry);
      },
      pause: geometry => {
        this.following = false; this.top = geometry.scrollTop;
        this.captureHorizontal();
        this.inspected();
      },
      observe: (geometry, movement) => {
        // The shared owner filters extent clamps and records each applied top.
        // An echo has no movement and must not replace the desired line anchor.
        if (movement === "up") { this.following = false; this.inspected(); }
        else if (movement === "down" && maximum(geometry) - geometry.scrollTop <= 1) { this.following = true; this.unseen = false; }
        if (movement !== "none") this.top = geometry.scrollTop;
        this.captureHorizontal();
      },
    };
    this.owner = new CoordinatedScrollOwner(viewport, {
      anchor,
      measure: () => ({ scrollTop: viewport.scrollTop || 0, scrollHeight: viewport.scrollHeight || 0, clientHeight: viewport.clientHeight || 0, items: [] }),
      active: () => active() && typeof requestAnimationFrame === "function",
      onChange: changed,
    });
  }

  private captureHorizontal(): void {
    const left = this.viewport.scrollLeft || 0;
    const maximum = this.maximumLeft();
    const clamped = maximum < this.horizontalMaximum && this.left > maximum && Math.abs(left - maximum) <= 1;
    // Neither a native width clamp nor a delayed echo of our own write changes
    // the desired offset. A real reader move, including back to zero, does.
    if (left !== this.observedLeft && !clamped) this.left = left;
    this.observedLeft = left;
    this.horizontalMaximum = maximum;
  }

  private maximumLeft(): number { return Math.max(0, (this.viewport.scrollWidth || 0) - (this.viewport.clientWidth || 0)); }

  readerInput(direction: "up" | "down"): void { if (direction === "up") this.owner.pause(); }
  capture(): void { this.owner.beforeMutation(); this.captureHorizontal(); }
  /** Compatibility entry point; observation still runs through the sole listener. */
  observe(): void { this.viewport.dispatchEvent(new (this.viewport.ownerDocument.defaultView?.Event ?? Event)("scroll")); }
  latest(): void { this.owner.latest(); }
  updated(): void { if (!this.following) this.unseen = true; this.owner.request(true); this.changed(); }
  request(): void { this.owner.request(); }
  correct(): void { this.owner.flush(performance.now()); }

  reveal(top: number, left?: number): void {
    this.inspected();
    this.owner.cancel();
    this.following = false;
    this.top = Math.max(0, top);
    if (left !== undefined) this.left = Math.max(0, left);
    this.request();
    this.changed();
  }

  replaced(lineDelta: number | undefined): void {
    if (this.following) return;
    if (lineDelta !== undefined) this.top = Math.max(0, this.top + lineDelta * 20);
    else this.clampReplacement = true;
  }

  cancel(): void { this.owner.cancel(); }
  dispose(): void { this.owner.dispose(); }
}

export class ShellOutputController {
  readonly element = document.createElement("section");
  readonly viewport = document.createElement("pre");
  readonly lines = document.createElement("code");
  readonly slot = document.createElement("div");
  readonly popout = document.createElement("button");
  readonly latest = document.createElement("button");
  readonly resize = document.createElement("div");
  readonly error = document.createElement("pre");
  readonly scroll: ShellScrollOwner;
  readonly buffer = new TerminalOutputBuffer();
  readonly command = document.createElement("pre");
  readonly description = document.createElement("p");
  metadata: ShellOutputMetadata;
  floatingGeometry?: ShellWindowGeometry;
  inlineHeight = 240;
  readerOpened = false;
  private hidden = false;
  private snapshot = "";
  private paintedOutput = "";
  private errorSnapshot = "";
  private paintedError = "";
  private painted = false;
  private paintedMetadata?: ShellOutputMetadata;
  private readonly html: string[] = [];
  private observer?: ResizeObserver;
  private observedContainer?: HTMLElement;
  private drag?: { id: number; y: number; height: number };
  private resizeFrame?: number;
  private pendingHeight?: number;
  private disposed = false;
  private restored?: ShellPresentation;
  private selectionRestore?: () => void;
  private readonly selectionChanged = () => {
    const selection = document.getSelection?.();
    if (selection && !selection.isCollapsed && this.viewport.contains(selection.anchorNode) && this.viewport.contains(selection.focusNode)) {
      this.selectionRestore = retainShellSelection(this.element);
    } else if (document.activeElement !== this.popout) this.selectionRestore = undefined;
  };

  constructor(readonly conversationId: string, readonly itemId: string, metadata: ShellOutputMetadata, readonly hooks: ShellMutationHooks = {}) {
    this.metadata = metadata;
    this.element.className = "chat-shell-output";
    this.element.dataset.shellConversationId = conversationId;
    this.element.dataset.shellItemId = itemId;
    this.slot.className = "chat-shell-slot";
    this.command.className = "chat-tool-command";
    this.description.className = "chat-tool-meta";
    this.viewport.className = "chat-tool-output chat-tool-terminal chat-shell-viewport";
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute("aria-label", "Shell output");
    this.lines.className = "chat-shell-lines";
    this.viewport.append(this.lines);
    this.latest.type = this.popout.type = "button";
    this.latest.textContent = "Latest output";
    this.latest.hidden = true;
    this.popout.textContent = "Pop out";
    this.popout.className = "chat-shell-popout";
    this.latest.addEventListener("click", () => this.scroll.latest());
    this.popout.addEventListener("click", event => {
      const restore = event.detail === 0 ? this.selectionRestore : undefined;
      shellOutputWindow().open(this);
      restore?.(); this.selectionRestore = undefined;
    });
    document.addEventListener("selectionchange", this.selectionChanged);
    const actions = document.createElement("div");
    actions.className = "chat-shell-actions";
    actions.append(this.popout, this.latest);
    this.error.className = "chat-tool-error chat-tool-terminal";
    this.error.setAttribute("aria-label", "Error output");
    this.error.hidden = true;
    this.resize.className = "chat-shell-inline-resize";
    this.resize.tabIndex = 0;
    this.resize.setAttribute("role", "separator");
    this.resize.setAttribute("aria-orientation", "horizontal");
    this.resize.setAttribute("aria-label", "Output height. Use Up and Down arrows to resize");
    this.resize.addEventListener("keydown", event => {
      const delta = event.key === "ArrowUp" ? -20 : event.key === "ArrowDown" ? 20 : 0;
      if (!delta && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault(); event.stopPropagation();
      const bounds = this.heightBounds();
      this.setInlineHeight(event.key === "Home" ? bounds.min : event.key === "End" ? bounds.max : this.appliedHeight() + delta);
    });
    this.resize.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); this.inspect();
      this.drag = { id: event.pointerId, y: event.clientY, height: this.appliedHeight() };
      this.resize.setPointerCapture(event.pointerId);
    });
    this.resize.addEventListener("pointermove", event => {
      if (this.drag?.id !== event.pointerId) return;
      this.pendingHeight = this.drag.height + event.clientY - this.drag.y;
      if (this.resizeFrame !== undefined) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = undefined;
        if (this.pendingHeight !== undefined) this.setInlineHeight(this.pendingHeight);
        this.pendingHeight = undefined;
      });
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) this.resize.addEventListener(type, () => this.releasePointer());
    this.element.append(this.command, this.description, actions, this.viewport, this.error, this.resize);
    this.slot.append(this.element);
    this.scroll = new ShellScrollOwner(this.viewport, () => {
      this.latest.hidden = this.scroll.following;
      this.latest.textContent = this.scroll.unseen ? "New output · Latest output" : "Latest output";
    }, () => !this.hidden && !this.disposed, () => { if (!this.readerOpened) this.inspect(true); });
    this.viewport.addEventListener("chat-shell-reveal", event => {
      if (this.hidden || this.disposed) return;
      const range = (event as CustomEvent<{ range: Range }>).detail?.range;
      if (!range || !this.viewport.contains(range.startContainer) || !this.viewport.contains(range.endContainer)) return;
      const rect = range.getBoundingClientRect(), view = this.viewport.getBoundingClientRect();
      this.scroll.reveal(this.viewport.scrollTop + rect.top - view.top - 10, this.viewport.scrollLeft + rect.left - view.left - 10);
      event.preventDefault();
    });
    this.viewport.addEventListener("keydown", event => {
      if (this.hidden || this.disposed) return;
      if (!["Home", "End", "PageUp", "PageDown"].includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
      // WebKit's native Home on a focused pre can target the page instead of
      // this scroller. Page keys also animate against a moving viewport height.
      // Resolve these keys against the retained anchor, through the same owner.
      event.preventDefault(); event.stopPropagation();
      if (event.key === "End") { this.scroll.latest(); return; }
      const current = this.scroll.following ? this.viewport.scrollTop : this.scroll.readingTop;
      const target = event.key === "Home" ? 0 : Math.max(0, current + (event.key === "PageUp" ? -1 : 1) * Math.max(20, this.viewport.clientHeight - 20));
      if (target >= this.viewport.scrollHeight - this.viewport.clientHeight && event.key === "PageDown") this.scroll.latest();
      else this.scroll.reveal(target);
    });
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => {
        if (this.hidden || this.disposed) return;
        if (this.resize.getAttribute("aria-valuenow") !== String(this.appliedHeight())) this.mutate(() => this.applyHeight());
        this.scroll.request();
      });
      this.observer.observe(this.viewport);
    }
    this.applyHeight();
  }

  attach(row: HTMLElement): void {
    if (this.slot.parentElement !== row) row.append(this.slot);
    const container = row.closest<HTMLElement>(".chat-timeline");
    if (container && container !== this.observedContainer) {
      if (this.observedContainer) this.observer?.unobserve(this.observedContainer);
      this.observedContainer = container; this.observer?.observe(container);
    }
    if (!this.hidden) this.scroll.request();
  }

  inspect(preserveClosed = false): void {
    this.mutate(() => { this.readerOpened = true; this.hooks.inspected?.(preserveClosed); });
  }

  mutate(fn: () => void): void {
    const selection = retainShellSelection(this.element);
    this.scroll.capture(); this.hooks.beforeMutation?.();
    try { fn(); } finally { selection(); if (!this.hidden) this.scroll.request(); this.hooks.afterMutation?.(); }
  }

  update(output: string | undefined, metadata: ShellOutputMetadata, error = ""): void {
    this.snapshot = output ?? ""; this.metadata = metadata; this.errorSnapshot = error;
    if (!this.hidden) this.paint();
  }

  presentation(): ShellPresentation {
    const scroll = this.scroll.snapshot();
    return { inlineHeight: this.inlineHeight, floatingGeometry: this.floatingGeometry && { ...this.floatingGeometry }, readerOpened: this.readerOpened,
      scroll, anchorHtml: this.html[Math.floor(Math.max(0, scroll.top - 10) / 20)], outputSnapshot: this.restored?.outputSnapshot ?? this.paintedOutput };
  }

  restorePresentation(state: ShellPresentation): void {
    this.inlineHeight = state.inlineHeight; this.floatingGeometry = state.floatingGeometry && { ...state.floatingGeometry }; this.readerOpened = state.readerOpened;
    this.restored = state; this.applyHeight(); this.scroll.restore(state.scroll);
  }

  private paint(): void {
    if (this.disposed) return;
    const metadata = this.metadata, previous = this.paintedMetadata;
    if (previous?.command !== metadata.command) this.command.textContent = metadata.command;
    if ((previous?.description ?? "") !== (metadata.description ?? "")) this.description.textContent = metadata.description ?? "";
    if (!previous || !!previous.description !== !!metadata.description) this.description.hidden = !metadata.description;
    const update = this.buffer.update(this.snapshot);
    const anchorIndex = Math.floor(Math.max(0, this.scroll.readingTop - 10) / 20);
    const anchorHtml = update.reset && !this.scroll.following ? this.restored?.anchorHtml ?? this.html[anchorIndex] : undefined;
    let replacementAnchor: number | undefined;
    if (!this.painted || update.dirtyFrom < update.lines.length || this.html.length !== update.lines.length) {
      for (let index = update.dirtyFrom; index < update.lines.length; index += 1) {
        const html = terminalLinesToHtml([update.lines[index]!]);
        if (anchorHtml !== undefined && html === anchorHtml
          && (replacementAnchor === undefined || Math.abs(index - anchorIndex) < Math.abs(replacementAnchor - anchorIndex))) replacementAnchor = index;
        let line = this.lines.children[index] as HTMLElement | undefined;
        if (!line) { line = document.createElement("span"); line.className = "chat-shell-line"; this.lines.append(line); }
        if (this.html[index] !== html) { line.innerHTML = `${html}\n`; this.html[index] = html; }
      }
      while (this.lines.children.length > update.lines.length) this.lines.lastElementChild!.remove();
      this.html.length = update.lines.length;
      if (update.reset) this.scroll.replaced(replacementAnchor === undefined ? undefined : replacementAnchor - anchorIndex);
      this.scroll.request();
    }
    // Reconstructing DOM is not incoming output. Compare the retained raw value
    // even when ANSI controls change without producing different rendered lines.
    if (this.snapshot !== (this.restored?.outputSnapshot ?? this.paintedOutput)) this.scroll.updated();
    this.paintedOutput = this.snapshot;
    this.restored = undefined;
    if (this.paintedError !== this.errorSnapshot) {
      this.error.innerHTML = terminalTextToHtml(this.errorSnapshot);
      this.error.hidden = !this.errorSnapshot;
      this.paintedError = this.errorSnapshot;
    }
    this.painted = true;
    if (previous?.status !== metadata.status) this.element.dataset.status = metadata.status;
    if (!previous || previous.command !== metadata.command || previous.conversation !== metadata.conversation || previous.status !== metadata.status
      || previous.completedAt !== metadata.completedAt || previous.exitCode !== metadata.exitCode) shellOutputWindow().refresh(this);
    this.paintedMetadata = { ...metadata };
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) { this.scroll.cancel(); this.releasePointer(); }
    else { this.paint(); this.scroll.request(); }
    shellOutputWindow().setOwnerHidden(this, hidden);
  }

  heightBounds(): { min: number; max: number } {
    const timeline = this.slot.closest<HTMLElement>(".chat-timeline");
    const available = timeline?.clientHeight || (typeof window !== "undefined" ? window.innerHeight : 600) || 600;
    const max = Math.max(20, available - 120);
    return { min: Math.min(80, max), max };
  }

  private appliedHeight(): number { const { min, max } = this.heightBounds(); return Math.max(min, Math.min(max, this.inlineHeight)); }
  private applyHeight(): void {
    const height = this.appliedHeight();
    this.element.style.setProperty("--shell-inline-height", `${height}px`);
    this.slot.style.setProperty("--shell-inline-height", `${height}px`);
    const bounds = this.heightBounds();
    this.resize.setAttribute("aria-valuemin", String(bounds.min));
    this.resize.setAttribute("aria-valuemax", String(bounds.max));
    this.resize.setAttribute("aria-valuenow", String(height));
    this.resize.setAttribute("aria-valuetext", `${height} pixels`);
  }

  setInlineHeight(height: number): void {
    if (!Number.isFinite(height)) return;
    this.inspect();
    this.mutate(() => { this.inlineHeight = Math.max(20, height); this.applyHeight(); });
  }

  private releasePointer(): void {
    const drag = this.drag; this.drag = undefined;
    if (drag && this.resize.hasPointerCapture?.(drag.id)) this.resize.releasePointerCapture(drag.id);
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = undefined;
    if (this.pendingHeight !== undefined && !this.disposed) this.setInlineHeight(this.pendingHeight);
    this.pendingHeight = undefined;
  }

  returnInline(): void { shellOutputWindow().closeOwner(this); }
  dispose(): void {
    document.removeEventListener("selectionchange", this.selectionChanged); this.selectionRestore = undefined;
    this.disposed = true; this.returnInline(); this.releasePointer(); this.observer?.disconnect(); this.scroll.dispose(); this.slot.remove(); this.element.remove();
  }
}
