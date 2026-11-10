import { attachCopyButtons } from "../preview/code-block";
import { appUrl } from "../shared/app-url";
import { copyChatText } from "./copy-actions";

/** Reconcile only one native assistant bubble. Return its logical focused
 * control for restoration after the staging tree is installed, never autofocus.
 */
export function reconcileChatVisuals(content: HTMLElement, next: HTMLElement): HTMLElement | null {
  const selector = ".chat-visual[data-visual-occurrence]";
  const retained = new Map(Array.from(content.querySelectorAll<HTMLElement>(selector), visual => [visual.dataset.visualOccurrence!, visual]));
  const active = content.ownerDocument.activeElement as HTMLElement | null;
  let focus: HTMLElement | null = null;
  for (const visual of next.querySelectorAll<HTMLElement>(selector)) {
    const previous = retained.get(visual.dataset.visualOccurrence!);
    if (!previous) continue;
    const sameSnapshot = previous.dataset.visualKey !== undefined && previous.dataset.visualKey === visual.dataset.visualKey;
    if (sameSnapshot && previous.dataset.visualState !== "pending" && previous.dataset.visualState === visual.dataset.visualState) {
      // Captured bytes are immutable. Preserve the image, loaded source,
      // decode-failure fallback and controls without requesting them again.
      previous.dataset.visualIndex = visual.dataset.visualIndex;
      visual.replaceWith(previous);
      if (active && previous.contains(active)) focus = active;
      continue;
    }
    // Pending/refused source is live text, not immutable captured bytes. Keep
    // the new source/status/copy handlers, transferring only the reader's view.
    if (previous.querySelector('[data-visual-tab="source"]')?.getAttribute("aria-pressed") === "true") {
      const preview = visual.querySelector<HTMLElement>(".chat-visual-preview");
      const source = visual.querySelector<HTMLElement>(".chat-visual-source");
      if (source) {
        source.hidden = false;
        if (preview) preview.hidden = true;
        for (const tab of visual.querySelectorAll<HTMLElement>("[data-visual-tab]")) tab.setAttribute("aria-pressed", String(tab.dataset.visualTab === "source"));
      }
    }
    const copy = visual.querySelector<HTMLButtonElement>("[data-visual-copy]");
    if (sameSnapshot && previous.dataset.visualSourceLoaded) {
      const code = visual.querySelector(".chat-visual-source code");
      if (code) {
        code.textContent = previous.querySelector(".chat-visual-source code")?.textContent ?? "";
        visual.dataset.visualSourceLoaded = "true";
        if (copy) { copy.disabled = false; copy.removeAttribute("title"); }
      }
    }
    if (!active || !previous.contains(active)) continue;
    const control = active.matches('[data-visual-tab="source"]') ? '[data-visual-tab="source"]'
      : active.matches('[data-visual-tab="preview"]') ? '[data-visual-tab="preview"]'
      : active.matches("[data-visual-copy]") ? "[data-visual-copy]" : null;
    if (control) focus = visual.querySelector<HTMLElement>(control);
    if (focus === copy && copy?.disabled) {
      // Capture may issue an id while Copy is focused. Keep this same logical
      // control focusable, but unavailable until the immutable source loads.
      // The click path still requires visualSourceLoaded before copying.
      copy.disabled = false;
      copy.setAttribute("aria-disabled", "true");
    }
  }
  return focus;
}

/** Bind only new visual nodes. Retained previews keep source state while text streams. */
export function decorateChatVisuals(root: HTMLElement): void {
  // These surfaces have no snapshot capture. Their SVG stays ordinary code,
  // with the same copy decoration as other readable source blocks.
  const uncaptured = "#chat-aside-answer, .chat-request-plan, .chat-subagent-result";
  if (root.matches(uncaptured)) attachCopyButtons(root);
  for (const content of root.querySelectorAll<HTMLElement>(uncaptured)) attachCopyButtons(content);
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
          copyButton.removeAttribute("aria-disabled");
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
    // A pending Source view can survive capture without another tab click.
    // Each new node owns its source cache and handlers; old responses cannot
    // populate the newly issued snapshot or freeze a later streaming prefix.
    if (visual.querySelector('[data-visual-tab="source"]')?.getAttribute("aria-pressed") === "true"
      || copyButton?.getAttribute("aria-disabled") === "true") {
      void source().catch(error => { if (status) status.textContent = messageOf(error); });
    }
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
