import { appUrl } from "../shared/app-url";
import { copyChatText } from "./copy-actions";

/** Bind only new visual nodes. Retained previews keep source state while text streams. */
export function decorateChatVisuals(root: HTMLElement): void {
  for (const visual of root.querySelectorAll<HTMLElement>(".chat-visual")) {
    if (visual.dataset.visualBound) continue;
    visual.dataset.visualBound = "true";
    const status = visual.querySelector<HTMLElement>(".chat-visual-status");
    const copyButton = visual.querySelector<HTMLButtonElement>("[data-visual-copy]");
    let loading: Promise<string> | undefined;
    const source = (): Promise<string> => {
      const code = visual.querySelector<HTMLElement>(".chat-visual-source code");
      if (!code) return Promise.reject(new Error("SVG source is unavailable."));
      if (visual.dataset.visualSourceLoaded) return Promise.resolve(code.textContent ?? "");
      loading ??= (async () => {
        const url = visual.dataset.visualSourceUrl;
        const id = url?.match(/\/api\/chat\/visuals\/([0-9a-f]{64})\/source$/)?.[1];
        if (!id || url !== appUrl(`/api/chat/visuals/${id}/source`)) throw new Error("SVG source is unavailable.");
        const response = await fetch(url);
        if (!response.ok) throw new Error("Could not load SVG source.");
        const text = await response.text();
        code.textContent = text;
        visual.dataset.visualSourceLoaded = "true";
        if (copyButton) {
          copyButton.disabled = false;
          copyButton.removeAttribute("title");
        }
        return text;
      })().catch(error => { loading = undefined; throw error; });
      return loading;
    };
    visual.addEventListener("click", event => {
      const target = event.target as Element;
      const tab = target.closest<HTMLElement>("[data-visual-tab]");
      if (tab) {
        const showSource = tab.dataset.visualTab === "source";
        const preview = visual.querySelector<HTMLElement>(".chat-visual-preview");
        const sourcePanel = visual.querySelector<HTMLElement>(".chat-visual-source");
        if (preview) preview.hidden = showSource;
        if (sourcePanel) sourcePanel.hidden = !showSource;
        for (const button of visual.querySelectorAll<HTMLElement>("[data-visual-tab]")) {
          button.setAttribute("aria-pressed", String(button === tab));
        }
        if (showSource) void source().catch(error => { if (status) status.textContent = messageOf(error); });
        return;
      }
      const copy = target.closest<HTMLButtonElement>("[data-visual-copy]");
      // Source is loaded before copying is enabled. Start clipboard work in
      // this click's activation, never after awaiting a network response.
      if (copy && !copy.disabled && visual.dataset.visualSourceLoaded) {
        const text = visual.querySelector(".chat-visual-source code")?.textContent ?? "";
        void copyChatText(copy, text, message => { if (status) status.textContent = message; })
          .catch(error => { if (status) status.textContent = messageOf(error); });
      }
    });
    const image = visual.querySelector<HTMLImageElement>(".chat-visual-enlarge img");
    if (image) {
      const failed = () => {
        const fallback = visual.querySelector<HTMLElement>(".chat-visual-fallback");
        if (fallback) fallback.hidden = false;
        image.closest(".chat-visual-enlarge")?.remove();
      };
      image.addEventListener("error", failed, { once: true });
      // Cached failures can finish before this newly rendered node is bound.
      // An unrequested lazy image is not complete, so it remains a preview.
      if (image.complete && image.naturalWidth === 0) failed();
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "SVG source is unavailable.";
}
