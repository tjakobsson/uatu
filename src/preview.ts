type MermaidRuntime = {
  initialize: (options: { startOnLoad: boolean; securityLevel: string; theme: string }) => void;
  run: (options: { nodes: HTMLElement[] }) => Promise<void>;
};

let mermaidInitialized = false;
let mermaidLoadPromise: Promise<MermaidRuntime | null> | null = null;

export async function renderMermaidDiagrams(container: ParentNode): Promise<void> {
  const mermaid = await getMermaidRuntime();
  if (!mermaid) {
    return;
  }

  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default",
    });
    mermaidInitialized = true;
  }

  const nodes = Array.from(container.querySelectorAll<HTMLElement>(".mermaid"));
  if (nodes.length === 0) {
    return;
  }

  await mermaid.run({ nodes });
}

export function replaceMermaidCodeBlocks(html: string): string {
  return html.replaceAll(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_match, source) => `<div class="mermaid">${source}</div>`,
  );
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
