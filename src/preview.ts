type MermaidRuntime = {
  initialize: (options: { startOnLoad: boolean; securityLevel: string; theme: string; themeVariables?: Record<string, string> }) => void;
  run: (options: { nodes: HTMLElement[] }) => Promise<void>;
};

export type MermaidThemeInputs = {
  theme: "default" | "dark" | "neutral" | "forest" | "base";
  themeVariables?: Record<string, string>;
};

const DEFAULT_THEME_INPUTS: MermaidThemeInputs = { theme: "default" };

let lastThemeInputs: MermaidThemeInputs | null = null;
let mermaidLoadPromise: Promise<MermaidRuntime | null> | null = null;

export async function renderMermaidDiagrams(
  container: ParentNode,
  themeInputs: MermaidThemeInputs = DEFAULT_THEME_INPUTS,
): Promise<void> {
  const mermaid = await getMermaidRuntime();
  if (!mermaid) {
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

  const nodes = Array.from(container.querySelectorAll<HTMLElement>(".mermaid"));
  if (nodes.length === 0) {
    return;
  }

  await mermaid.run({ nodes });

  for (const node of nodes) {
    normalizeRenderedDiagram(node);
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
  const intendedMaxWidth = svg.style.maxWidth;
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
