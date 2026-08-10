import { appUrl } from "../shared/app-url";

type MermaidRuntime = {
  initialize: (options: { startOnLoad: boolean; securityLevel: string; theme: string; themeVariables?: Record<string, string | boolean> }) => void;
  run: (options: { nodes: HTMLElement[]; suppressErrors?: boolean }) => Promise<void>;
};

export type MermaidThemeInputs = {
  theme: "default" | "dark" | "neutral" | "forest" | "base";
  // Booleans allowed so flags like `darkMode` reach mermaid as real
  // booleans — a string "true" only works while mermaid checks truthiness.
  themeVariables?: Record<string, string | boolean>;
};

const DEFAULT_THEME_INPUTS: MermaidThemeInputs = { theme: "default" };

// Supplied by the caller that knows the layout. `null` means the implicit
// viewport root — the correct answer whenever the page is what scrolls, and
// the only one available in a non-browser DOM.
export type ObserverRootResolver = () => Element | null;

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
// Stored as a resolver, not a resolved value: both the theme-flip reinstall
// and the mode-switch re-observation run without the caller present, and both
// need the root as it is *now*. A value captured at mount would freeze the
// layout the document happened to be mounted in.
let lastObserverRootResolver: ObserverRootResolver | null = null;
// The theme inputs the current install was made with, so re-observation can
// rebuild queue entries identically. Distinct from `lastThemeInputs`, which
// tracks what mermaid itself was last initialized with.
let lastInstallThemeInputs: MermaidThemeInputs = DEFAULT_THEME_INPUTS;

type QueueEntry = { node: HTMLElement; generation: number; themeInputs: MermaidThemeInputs };
const renderQueue: QueueEntry[] = [];
// Nodes with a live queue entry or a render in progress. Membership outlives
// the queue entry itself — a node is removed only once its render settles —
// because re-observation must not hand the drain loop a second entry for work
// already under way.
const queuedNodes = new Set<HTMLElement>();

// Rendered-SVG reuse across mounts: key is theme inputs + trimmed diagram
// source, value is the normalized SVG markup (pre-trigger-wrap). A Map is
// insertion-ordered, which gives us cheap oldest-first eviction. Failed
// renders are never cached so a corrected source re-renders.
const renderedSvgCache = new Map<string, string>();

// Install lazy rendering for every `.mermaid` node in the container.
// Resolves once observation is set up — NOT when all diagrams are rendered;
// diagrams stream in as they approach the viewport. Callers that need
// completion (tests) await `__drainMermaidQueueForTests()`.
//
// `resolveObserverRoot` answers "what region should a diagram be measured
// against?" — see the note on `installObserver` for why this module no longer
// derives that answer itself. Omitting it means the implicit viewport root,
// which is what a non-browser DOM gets.
export async function renderMermaidDiagrams(
  container: ParentNode,
  themeInputs: MermaidThemeInputs = DEFAULT_THEME_INPUTS,
  resolveObserverRoot?: ObserverRootResolver,
): Promise<void> {
  const generation = ++renderGeneration;
  activeObserver?.disconnect();
  activeObserver = null;
  lastInstallContainer = container;
  lastObserverRootResolver = resolveObserverRoot ?? null;
  lastInstallThemeInputs = themeInputs;

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

  if (!installObserver(nodes, generation, themeInputs)) {
    // No viewport observation available (non-browser DOM, ancient engine):
    // still render everything, but through the yielding queue so a large
    // batch never blocks as one unit.
    for (const node of nodes) {
      enqueueDiagram({ node, generation, themeInputs });
    }
  }
}

// Build the observer over `nodes` against a freshly resolved root. Returns
// false when the environment has no IntersectionObserver, so the caller can
// fall back to rendering everything.
//
// The root is injected rather than derived. This module used to walk up from
// the container looking for a computed overflow of `auto|scroll|overlay`,
// which is a different question from "what actually scrolls" and answers it
// wrongly wherever the page is the scroller: `<body>` carries `overflow: auto`
// in touch mode and in the ≤900px stacked layout, but it is `height: 100%` and
// its overflow propagates to the viewport. Picking it yields a one-screenful
// root pinned to the document origin, which clips every diagram below the
// first screen out of observation permanently — they never intersect at any
// scroll position, so they never render at all (#186). Layout is not this
// module's knowledge to hold; `preview/mount.ts` supplies it from the single
// resolver in `shell/preview-scroll-root.ts`.
function installObserver(
  nodes: HTMLElement[],
  generation: number,
  themeInputs: MermaidThemeInputs,
): boolean {
  const Observer = (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;
  if (typeof Observer !== "function") {
    return false;
  }
  // Generous ahead-of-viewport margin: diagrams normally finish rendering
  // before they scroll into actual view, so pop-in and placeholder-height
  // layout shift stay off-screen. The margin expands whatever the root
  // clips, so it is only meaningful once the root is the right region.
  const observer = new Observer(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      enqueueDiagram({ node: entry.target as HTMLElement, generation, themeInputs });
    }
  }, { root: lastObserverRootResolver?.() ?? null, rootMargin: OBSERVER_ROOT_MARGIN });
  activeObserver = observer;
  for (const node of nodes) {
    observer.observe(node);
  }
  return true;
}

// Rebuild observation against the currently effective root, for diagrams that
// have not rendered yet.
//
// An observer's root is fixed at construction — there is no way to retarget a
// live one — so a UI-mode switch that moves scrolling from the shell to the
// page leaves the existing observer bound to a region that no longer clips
// anything relevant. Disconnecting and rebuilding is the only mechanism the
// API offers.
//
// Deliberately NOT the theme-flip path: that restores each node's stashed
// source and clears `data-processed` to force a re-render, which is right when
// the theme changed and wrong here. The theme has not changed, so a rendered
// diagram has nothing to gain and a visible flash to lose. Only nodes still
// carrying the pending class are re-observed, which also keeps a node already
// in flight in the queue from being enqueued a second time: `enqueueDiagram`
// runs on intersection, and the pending class is cleared when the render
// completes, but an in-flight node was already `unobserve`d by the callback
// that queued it and is not in `nodes` here — it is only re-observed if it is
// still pending, and re-observing a still-pending in-flight node is harmless
// because the generation is unchanged and the queue entry it already has does
// the work.
export function reobserveMermaidDiagrams(): void {
  const container = lastInstallContainer;
  if (!container) {
    return;
  }
  const pending = Array.from(
    container.querySelectorAll<HTMLElement>(`.mermaid.${PENDING_CLASS}`),
  ).filter(node => !queuedNodes.has(node));
  activeObserver?.disconnect();
  activeObserver = null;
  if (pending.length === 0) {
    return;
  }
  installObserver(pending, renderGeneration, lastInstallThemeInputs);
}

function enqueueDiagram(entry: QueueEntry): void {
  renderQueue.push(entry);
  queuedNodes.add(entry.node);
  void drainRenderQueue();
}

async function drainRenderQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (renderQueue.length > 0) {
      const entry = renderQueue.shift();
      if (!entry) {
        continue;
      }
      if (entry.generation !== renderGeneration) {
        queuedNodes.delete(entry.node);
        continue;
      }
      try {
        await renderSingleDiagram(entry.node, entry.themeInputs, entry.generation);
      } finally {
        queuedNodes.delete(entry.node);
      }
      // One diagram per pass: yield to the paint cycle so the page stays
      // responsive while a long run of diagrams renders.
      await nextAnimationFrame();
    }
  } finally {
    draining = false;
  }
}

async function renderSingleDiagram(
  node: HTMLElement,
  themeInputs: MermaidThemeInputs,
  generation: number,
): Promise<void> {
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
  // A theme flip / new install may have superseded this render while the
  // runtime loaded. The node has been reset and re-queued by the new
  // install — leave it untouched for the new-generation entry.
  if (generation !== renderGeneration) {
    return;
  }
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
    // Still cached even when superseded below — the SVG is valid for its
    // own theme inputs, so flipping back becomes a cache hit.
    renderedSvgCache.set(cacheKey, svg.outerHTML);
    if (renderedSvgCache.size > SVG_CACHE_MAX_ENTRIES) {
      const oldest = renderedSvgCache.keys().next().value;
      if (oldest !== undefined) {
        renderedSvgCache.delete(oldest);
      }
    }
  }

  // mermaid.run() cannot be cancelled: if a theme flip superseded this
  // render mid-run, the stale mutation just landed on a node the new
  // install already reset — and its data-processed stamp would make the
  // new-generation run a silent no-op, leaving the old theme on screen.
  // Undo the stale mutation so the queued re-render starts clean.
  if (generation !== renderGeneration) {
    const stashedSource = node.dataset.mermaidSource;
    if (stashedSource !== undefined) {
      node.textContent = stashedSource;
      node.removeAttribute("data-processed");
      node.classList.add(PENDING_CLASS);
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
  queuedNodes.clear();
  renderedSvgCache.clear();
  activeObserver?.disconnect();
  activeObserver = null;
  lastInstallContainer = null;
  lastObserverRootResolver = null;
  lastInstallThemeInputs = DEFAULT_THEME_INPUTS;
}

// Re-render the active preview's diagrams with new theme inputs (the
// mermaid-rendering spec's theme-change requirement). Restores each
// diagram's stashed source — rendering destroyed the node content — then
// reinstalls lazy rendering over the same container, so off-screen
// diagrams stay lazy and theme-keyed cache hits skip the renderer.
//
// Reinstalls with the stashed *resolver*, so the new observer is built
// against the layout in force now rather than the one captured at mount.
export async function rerenderMermaidDiagrams(themeInputs: MermaidThemeInputs): Promise<void> {
  const container = lastInstallContainer;
  if (!container) {
    return;
  }
  const resolveObserverRoot = lastObserverRootResolver ?? undefined;
  for (const node of Array.from(container.querySelectorAll<HTMLElement>(".mermaid"))) {
    const source = node.dataset.mermaidSource;
    if (source !== undefined) {
      node.textContent = source;
      // Mermaid stamps rendered nodes as processed and mermaid.run()
      // silently skips them — clear the stamp or the re-render is a no-op.
      node.removeAttribute("data-processed");
    }
  }
  await renderMermaidDiagrams(container, themeInputs, resolveObserverRoot);
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
    mermaidLoadPromise = loadScript(appUrl("/assets/mermaid.min.js")).then(() => {
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
