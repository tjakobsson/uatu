type MermaidRuntime = {
  initialize: (options: { startOnLoad: boolean; securityLevel: string; theme: string; themeVariables?: Record<string, string> }) => void;
  run: (options: { nodes: HTMLElement[]; suppressErrors?: boolean }) => Promise<void>;
};

export type MermaidThemeInputs = {
  theme: "default" | "dark" | "neutral" | "forest" | "base";
  themeVariables?: Record<string, string>;
};

const DEFAULT_THEME_INPUTS: MermaidThemeInputs = { theme: "default" };

// Lazy-rendering machinery (see openspec/specs/mermaid-rendering — "Mermaid
// diagrams render lazily"). Diagrams render when they approach the viewport
// instead of all at mount: on a 42-diagram benchmark document the eager
// batch froze the main thread for ~0.5s in Chromium and ~2.3s in WebKit,
// invisible to the network panel. The queue renders ONE diagram per pass
// with a paint yield in between, and rendered SVGs are reused from an
// in-memory cache keyed by source + theme.
const OBSERVER_ROOT_MARGIN = "50% 0px";
const SVG_CACHE_MAX_ENTRIES = 200;
const PENDING_CLASS = "mermaid-pending";

let lastThemeInputs: MermaidThemeInputs | null = null;
let mermaidLoadPromise: Promise<MermaidRuntime | null> | null = null;

// Generation tag: bumped on every install. Queue entries from a superseded
// install (the user switched documents mid-drain) are abandoned instead of
// rendering stale diagrams into the new preview.
let renderGeneration = 0;
let activeObserver: IntersectionObserver | null = null;
let draining = false;
// The container of the most recent install — the active preview. A theme
// re-render targets this rather than threading the container through the
// theme subscription (mounts always reinstall, so "last" is "current").
let lastInstallContainer: ParentNode | null = null;

type QueueEntry = { node: HTMLElement; generation: number; themeInputs: MermaidThemeInputs };
const renderQueue: QueueEntry[] = [];

// Rendered-SVG reuse across mounts: key is theme inputs + trimmed diagram
// source, value is the normalized SVG markup (pre-trigger-wrap). A Map is
// insertion-ordered, which gives us cheap oldest-first eviction. Failed
// renders are never cached so a corrected source re-renders.
const renderedSvgCache = new Map<string, string>();

// Install lazy rendering for every `.mermaid` node in the container.
// Resolves once observation is set up — NOT when all diagrams are rendered;
// diagrams stream in as they approach the viewport. Callers that need
// completion (tests) await `__drainMermaidQueueForTests()`.
export async function renderMermaidDiagrams(
  container: ParentNode,
  themeInputs: MermaidThemeInputs = DEFAULT_THEME_INPUTS,
): Promise<void> {
  const generation = ++renderGeneration;
  activeObserver?.disconnect();
  activeObserver = null;
  lastInstallContainer = container;

  const nodes = Array.from(container.querySelectorAll<HTMLElement>(".mermaid"));
  if (nodes.length === 0) {
    return;
  }
  for (const node of nodes) {
    // Rendering replaces the node's content with the SVG, destroying the
    // source — stash it so a theme re-render can restore and re-run.
    if (node.dataset.mermaidSource === undefined) {
      node.dataset.mermaidSource = (node.textContent ?? "").trim();
    }
    node.classList.add(PENDING_CLASS);
  }

  const Observer = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  if (typeof Observer === "function") {
    // Generous ahead-of-viewport margin: diagrams normally finish rendering
    // before they scroll into actual view, so pop-in and placeholder-height
    // layout shift stay off-screen.
    //
    // The root MUST be the nearest scrollable ancestor (`.preview-shell`
    // in single view, the rendered pane in split view), not the default
    // viewport: with an implicit root, ancestor clipping by the nested
    // scroller still applies and rootMargin would expand only the viewport
    // rect — leaving the margin inert and diagrams un-queued until they
    // are already visible.
    const observer = new Observer(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        enqueueDiagram({ node: entry.target as HTMLElement, generation, themeInputs });
      }
    }, { root: nearestScrollRoot(container), rootMargin: OBSERVER_ROOT_MARGIN });
    activeObserver = observer;
    for (const node of nodes) {
      observer.observe(node);
    }
  } else {
    // No viewport observation available (non-browser DOM, ancient engine):
    // still render everything, but through the yielding queue so a large
    // batch never blocks as one unit.
    for (const node of nodes) {
      enqueueDiagram({ node, generation, themeInputs });
    }
  }
}

// Walk up from the container to the nearest overflow-scrolling ancestor —
// the element whose scrollport actually clips the diagrams. Returns null
// (the viewport) when none exists or when getComputedStyle is unavailable
// (non-browser DOM), which degrades to the pre-fix behavior: rendering on
// visibility rather than ahead of it.
function nearestScrollRoot(container: ParentNode): Element | null {
  const getStyle = (globalThis as { getComputedStyle?: (el: Element) => CSSStyleDeclaration }).getComputedStyle;
  if (typeof getStyle !== "function") {
    return null;
  }
  // `instanceof Element` needs the Element global, which non-browser DOM
  // environments may not install — duck-type on nodeType instead.
  let element: Element | null =
    (container as { nodeType?: number }).nodeType === 1 ? (container as Element) : null;
  while (element) {
    try {
      const style = getStyle(element);
      if (/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`)) {
        return element;
      }
    } catch {
      return null;
    }
    element = element.parentElement;
  }
  return null;
}

function enqueueDiagram(entry: QueueEntry): void {
  renderQueue.push(entry);
  void drainRenderQueue();
}

async function drainRenderQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (renderQueue.length > 0) {
      const entry = renderQueue.shift();
      if (!entry || entry.generation !== renderGeneration) {
        continue;
      }
      await renderSingleDiagram(entry.node, entry.themeInputs);
      // One diagram per pass: yield to the paint cycle so the page stays
      // responsive while a long run of diagrams renders.
      await nextAnimationFrame();
    }
  } finally {
    draining = false;
  }
}

async function renderSingleDiagram(node: HTMLElement, themeInputs: MermaidThemeInputs): Promise<void> {
  const source = (node.dataset.mermaidSource ?? node.textContent ?? "").trim();
  const cacheKey = `${serializeThemeInputs(themeInputs)}\u0000${source}`;

  const cachedSvg = renderedSvgCache.get(cacheKey);
  if (cachedSvg !== undefined) {
    // Cache hit: reuse the normalized SVG without invoking mermaid, then
    // wrap it with the fullscreen-viewer trigger like any fresh render.
    node.innerHTML = cachedSvg;
    node.classList.remove(PENDING_CLASS);
    normalizeRenderedDiagram(node);
    return;
  }

  const mermaid = await getMermaidRuntime();
  if (!mermaid) {
    node.classList.remove(PENDING_CLASS);
    return;
  }
  if (!lastThemeInputs || !themeInputsEqual(lastThemeInputs, themeInputs)) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: themeInputs.theme,
      ...(themeInputs.themeVariables ? { themeVariables: themeInputs.themeVariables } : {}),
    });
    lastThemeInputs = themeInputs;
  }

  // suppressErrors keeps a bad block (e.g., mid-edit `flowchat` typo) from
  // rejecting — Mermaid logs the error, paints its built-in syntax-error
  // indicator on the node, and resolves. The catch is belt-and-braces for
  // runtime versions that reject anyway.
  try {
    await mermaid.run({ nodes: [node], suppressErrors: true });
  } catch {
    // Leave the node as-is; the pending affordance is cleared below.
  }
  node.classList.remove(PENDING_CLASS);

  const svg = node.querySelector<SVGElement>("svg");
  normalizeRenderedDiagram(node);
  if (svg && !isErrorDiagramSvg(svg)) {
    renderedSvgCache.set(cacheKey, svg.outerHTML);
    if (renderedSvgCache.size > SVG_CACHE_MAX_ENTRIES) {
      const oldest = renderedSvgCache.keys().next().value;
      if (oldest !== undefined) {
        renderedSvgCache.delete(oldest);
      }
    }
  }
}

// Mermaid's suppressErrors path paints a syntax-error SVG instead of a
// diagram. Those must not enter the cache — a live reload delivering the
// corrected source has to re-render. Detection covers Mermaid's error
// markers across versions plus the explicit attribute our tests stub.
function isErrorDiagramSvg(svg: SVGElement): boolean {
  if (svg.getAttribute("aria-roledescription") === "error") return true;
  if (svg.hasAttribute("data-mermaid-error")) return true;
  return svg.querySelector(".error-icon, .error-text") !== null;
}

function serializeThemeInputs(themeInputs: MermaidThemeInputs): string {
  return JSON.stringify({ theme: themeInputs.theme, themeVariables: themeInputs.themeVariables ?? null });
}

// One paint-cycle yield, guarded for non-browser (unit test) environments
// where requestAnimationFrame is absent.
function nextAnimationFrame(): Promise<void> {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== "function") {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  return new Promise(resolve => raf(() => resolve()));
}

// Test-only: resolves when the render queue has fully drained. Production
// code MUST NOT call this — diagrams are meant to stream in.
export async function __drainMermaidQueueForTests(): Promise<void> {
  while (draining || renderQueue.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

export function replaceMermaidCodeBlocks(html: string): string {
  return html.replaceAll(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_match, source) => `<div class="mermaid">${source}</div>`,
  );
}

// Strip Mermaid's intrinsic-pixel sizing from a rendered diagram so the SVG
// scales to its container, then wrap the SVG in a button trigger that opens
// the fullscreen viewer.
export function normalizeRenderedDiagram(node: HTMLElement): void {
  const svg = node.querySelector<SVGElement>("svg");
  if (!svg) {
    return;
  }
  normalizeMermaidSvg(svg);

  // Don't double-wrap if normalize is called twice on the same node.
  for (const child of Array.from(node.children) as Element[]) {
    if (child.classList.contains("mermaid-trigger")) {
      return;
    }
  }

  const trigger = node.ownerDocument.createElement("button");
  trigger.type = "button";
  trigger.className = "mermaid-trigger";
  trigger.setAttribute("aria-label", "Open diagram in fullscreen viewer");

  const badge = node.ownerDocument.createElement("span");
  badge.className = "mermaid-trigger-badge";
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = "⛶";

  trigger.append(svg, badge);
  node.replaceChildren(trigger);
}

export function normalizeMermaidSvg(svg: SVGElement): void {
  // Mermaid emits the SVG with `width="100%"` (a percentage, not pixels) and
  // the actual library-chosen display size in `style="max-width: Wpx"`. With
  // `width="100%"` on an inline-block trigger, the layout is circular —
  // SVG-100%-of-trigger and trigger-shrink-to-fit-SVG — and the SVG falls
  // back to its intrinsic UA size (~300x150) in every browser. Every
  // diagram then renders at that fallback regardless of complexity.
  //
  // Move Mermaid's intended pixel size from `style.maxWidth` onto the
  // `width` attribute so the SVG has an explicit intrinsic display size,
  // and strip `height` so CSS `height: auto` can recompute height from
  // viewBox when our `max-width: 100%` cap binds in narrow containers.
  //
  // Reading `svg.style.maxWidth` is safe; only assigning to `svg.style.*`
  // tripped the Safari "Invalid value for <svg> attribute width=" bug.
  // Coalesce to "" because some non-browser DOM impls used in tests return
  // undefined for unset properties instead of the spec-mandated empty string.
  const intendedMaxWidth = svg.style.maxWidth ?? "";
  const match = intendedMaxWidth.match(/^([\d.]+)px$/);
  if (match) {
    svg.setAttribute("width", match[1]);
  }
  svg.removeAttribute("height");
}

function themeInputsEqual(a: MermaidThemeInputs, b: MermaidThemeInputs): boolean {
  if (a.theme !== b.theme) {
    return false;
  }
  const av = a.themeVariables;
  const bv = b.themeVariables;
  if (!av && !bv) {
    return true;
  }
  if (!av || !bv) {
    return false;
  }
  const akeys = Object.keys(av);
  const bkeys = Object.keys(bv);
  if (akeys.length !== bkeys.length) {
    return false;
  }
  return akeys.every(key => av[key] === bv[key]);
}

// Reset module state. For tests only.
export function __resetMermaidStateForTests(): void {
  lastThemeInputs = null;
  mermaidLoadPromise = null;
  renderGeneration = 0;
  renderQueue.length = 0;
  renderedSvgCache.clear();
  activeObserver?.disconnect();
  activeObserver = null;
  lastInstallContainer = null;
}

// Re-render the active preview's diagrams with new theme inputs (the
// mermaid-rendering spec's theme-change requirement). Restores each
// diagram's stashed source — rendering destroyed the node content — then
// reinstalls lazy rendering over the same container, so off-screen
// diagrams stay lazy and theme-keyed cache hits skip the renderer.
export async function rerenderMermaidDiagrams(themeInputs: MermaidThemeInputs): Promise<void> {
  const container = lastInstallContainer;
  if (!container) {
    return;
  }
  for (const node of Array.from(container.querySelectorAll<HTMLElement>(".mermaid"))) {
    const source = node.dataset.mermaidSource;
    if (source !== undefined) {
      node.textContent = source;
      // Mermaid stamps rendered nodes as processed and mermaid.run()
      // silently skips them — clear the stamp or the re-render is a no-op.
      node.removeAttribute("data-processed");
    }
  }
  await renderMermaidDiagrams(container, themeInputs);
}

async function getMermaidRuntime(): Promise<MermaidRuntime | null> {
  const candidate = globalThis.mermaid;
  if (candidate) {
    return candidate as MermaidRuntime;
  }

  if (typeof document === "undefined") {
    return null;
  }

  if (!mermaidLoadPromise) {
    mermaidLoadPromise = loadScript("/assets/mermaid.min.js").then(() => {
      const runtime = globalThis.mermaid;
      return runtime ? (runtime as MermaidRuntime) : null;
    });
  }

  return mermaidLoadPromise;
}

async function loadScript(src: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load script: ${src}`));
    document.head.append(script);
  });
}

declare global {
  var mermaid: MermaidRuntime | undefined;
}
