// Injected only by the isolated test host, before the actual app module.
import { openWorktreePicker } from "../../src/shell/worktree-picker";
const generation = Number(document.querySelector('meta[name="demo-generation"]')!.getAttribute("content"));
let leaving = false;
window.addEventListener("pagehide", () => { leaving = true; });
const originalFetch = window.fetch.bind(window);
window.fetch = Object.assign((input: RequestInfo | URL, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("x-demo-generation", String(generation));
  return originalFetch(input, { ...init, headers });
}, { preconnect: window.fetch.preconnect });
// Observe the existing brokered connection; never open a second SSE stream.
const OriginalEventSource = window.EventSource;
window.EventSource = class extends OriginalEventSource {
  constructor(url: string | URL, options?: EventSourceInit) {
    super(url, options);
    this.addEventListener("worktrees", () => window.dispatchEvent(new Event("uatu:worktrees-invalidated")));
    this.addEventListener("open", () => window.dispatchEvent(new Event("uatu:worktrees-invalidated")));
    this.addEventListener("demo-generation", event => {
      if (JSON.parse((event as MessageEvent).data).generation !== generation) resetPage();
    });
    this.addEventListener("error", () => {
      // Reset may have removed this stream's workspace entirely. Even a
      // rejected reconnect must retire its old browser restoration state.
      void originalFetch("/__demo/generation").then(response => response.json()).then(state => {
        if (state.generation !== generation) resetPage();
      }).catch(() => undefined);
    });
  }
};
const clearRestoration = () => {
  for (const storage of [localStorage, sessionStorage]) for (const key of Object.keys(storage)) {
    if (key.startsWith("uatu") || key.startsWith("demo-")) storage.removeItem(key);
  }
};
function resetPage() {
  if (leaving) return;
  leaving = true;
  clearRestoration();
  location.replace("/s/atlas/");
}
const url = new URL(location.href);
const oldGeneration = url.searchParams.get("demoGeneration");
for (const storage of [localStorage, sessionStorage]) {
  const previous = storage.getItem("demo-generation");
  if (previous !== null && Number(previous) !== generation) { clearRestoration(); break; }
}
localStorage.setItem("demo-generation", String(generation));
sessionStorage.setItem("demo-generation", String(generation));
for (const method of ["pushState", "replaceState"] as const) {
  const original = history[method].bind(history);
  history[method] = (data, unused, target) => {
    const destination = new URL(target?.toString() ?? location.href, location.href);
    destination.searchParams.set("demoGeneration", String(generation));
    original({ ...data, demoGeneration: generation }, unused, destination);
  };
}
window.addEventListener("popstate", event => {
  if (event.state?.demoGeneration && event.state.demoGeneration !== generation) {
    event.stopImmediatePropagation(); resetPage();
  }
}, true);
if (oldGeneration && Number(oldGeneration) !== generation) {
  resetPage();
} else {
  url.searchParams.set("demoGeneration", String(generation));
  history.replaceState(history.state, "", url);
}
window.addEventListener("pageshow", async event => {
  leaving = false;
  if (!event.persisted) return;
  const state = await originalFetch("/__demo/generation").then(response => response.json());
  if (state.generation !== generation) resetPage();
});
window.addEventListener("DOMContentLoaded", () => {
  // Reserve a small test-only review strip instead of covering the real chat
  // composer or terminal controls. Expanded scenario controls are temporary.
  const chromeStyle = document.createElement("style");
  chromeStyle.textContent = `
    #demo-controls{bottom:0;left:0;right:0;max-width:none;min-height:36px;box-sizing:border-box;border-radius:0;padding:8px 12px}
    html[data-ui-mode="desktop"] .app-shell{height:calc(100dvh - 36px)}
    html[data-ui-mode="touch"] #demo-controls{bottom:var(--tab-bar-total)}
    html[data-ui-mode="touch"][data-active-tab="chat"] .chat-surface,
    html[data-ui-mode="touch"] .chat-drilldown{height:calc(var(--chat-visual-height, calc(100dvh - var(--tab-bar-total))) - 36px)}
    html[data-ui-mode="touch"] .terminal-panel[data-display="fullscreen"]{height:calc(var(--terminal-visual-height, calc(100dvh - var(--tab-bar-total))) - 36px)!important}
    html[data-ui-mode="touch"] .preview-shell{padding-bottom:36px}
  `;
  document.body.append(chromeStyle);
  const panel = document.querySelector<HTMLElement>("#demo-controls")!;
  const inventory = document.createElement("button");
  inventory.textContent = "Review simulated inventory / recovery / folder safety";
  inventory.onclick = () => {
    panel.querySelector("details")!.open = false;
    openWorktreePicker("/worktrees", document.querySelector<HTMLElement>("#hub-toggle")!);
  };
  panel.querySelector("details")!.append(inventory);
  panel.querySelector('[name="scenario"]')!.setAttribute("aria-label", "Scenario");
  panel.querySelector('[name="latency"]')!.setAttribute("aria-label", "Operation latency");
  panel.querySelector("form")!.addEventListener("submit", async event => {
    event.preventDefault();
    const response = await fetch("/__demo/reset", { method: "POST", body: new FormData(event.target as HTMLFormElement) }).catch(() => null);
    if (response?.ok) resetPage();
  });
  for (const action of ["discover", "reconnect"]) panel.querySelector(`#demo-${action}`)!.addEventListener("click", () => {
    void fetch(`/__demo/${action}`, { method: "POST" });
  });
});
