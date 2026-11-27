import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { createPresentedRender, setReloadNotice, type PresentedRenderKey } from "./presented-render";

function preview(): HTMLElement {
  const { document } = parseHTML("<!doctype html><html><body><article id='preview'></article></body></html>");
  return document.querySelector("#preview") as unknown as HTMLElement;
}

const readme: PresentedRenderKey = { documentId: "/docs/README.md", view: "rendered", layout: "single" };

function mountRender(container: HTMLElement, html = "<h1>Title</h1><p>Body</p>"): void {
  container.innerHTML = html;
}

describe("createPresentedRender", () => {
  test("nothing is presented before a render is noted", () => {
    const container = preview();
    mountRender(container);
    expect(createPresentedRender(container).shows(readme)).toBe(false);
  });

  test("a noted render is presented for the same document, view and layout", () => {
    const container = preview();
    const presented = createPresentedRender(container);
    mountRender(container);
    presented.note(readme);
    expect(presented.shows({ ...readme })).toBe(true);
  });

  test("another document, view or layout is not the presented render", () => {
    const container = preview();
    const presented = createPresentedRender(container);
    mountRender(container);
    presented.note(readme);
    expect(presented.shows({ ...readme, documentId: "/docs/guide.md" })).toBe(false);
    expect(presented.shows({ ...readme, view: "source" })).toBe(false);
    expect(presented.shows({ ...readme, layout: "split-h" })).toBe(false);
  });

  test("a render replaced by any other preview body is no longer presented", () => {
    const container = preview();
    const presented = createPresentedRender(container);
    mountRender(container);
    presented.note(readme);
    // Any other writer (empty state, diff, binary notice, commit message)
    // replaces the preview's children without telling the tracker.
    container.innerHTML = "<p>File unavailable.</p>";
    expect(presented.shows(readme)).toBe(false);
  });

  test("in-place decoration of the render's own content keeps it presented", () => {
    const container = preview();
    const presented = createPresentedRender(container);
    mountRender(container, "<div class='mermaid'></div><p>Body</p>");
    presented.note(readme);
    // Mermaid and similar decorations swap single nodes of the mounted body.
    const diagram = container.firstChild as ChildNode;
    const svg = container.ownerDocument.createElement("svg");
    diagram.replaceWith(svg);
    expect(presented.shows(readme)).toBe(true);
  });

  test("an empty render body is never presented", () => {
    const container = preview();
    const presented = createPresentedRender(container);
    mountRender(container, "");
    presented.note(readme);
    expect(presented.shows(readme)).toBe(false);
  });
});

describe("setReloadNotice", () => {
  function withNotice(run: (document: Document) => void): void {
    const { document } = parseHTML(`<!doctype html><html><body>
      <main class="preview-shell" tabindex="-1">
        <span id="preview-reload-notice" hidden>
          <span class="preview-reload-message" role="status"></span>
          <button type="button" class="preview-reload-retry" aria-label="Retry loading this file" hidden>Retry</button>
        </span>
      </main></body></html>`);
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as unknown as { document: Document }).document = document as unknown as Document;
    try {
      run(document as unknown as Document);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = previousDocument;
    }
  }
  const parts = (document: Document) => ({
    notice: document.querySelector<HTMLElement>("#preview-reload-notice")!,
    message: document.querySelector<HTMLElement>(".preview-reload-message")!,
    retry: document.querySelector<HTMLButtonElement>(".preview-reload-retry")!,
  });

  test("retrying says so and offers no action, since another attempt is already pending", () => {
    withNotice(document => {
      setReloadNotice("retrying");
      const { notice, message, retry } = parts(document);
      expect(notice.hidden).toBe(false);
      expect(message.textContent).toBe("This file couldn't be reloaded. Retrying…");
      expect(retry.hidden).toBe(true);
    });
  });

  test("an exhausted schedule keeps the notice up with a labelled Retry button", () => {
    withNotice(document => {
      setReloadNotice("retrying");
      setReloadNotice("gave-up");
      const { notice, message, retry } = parts(document);
      expect(notice.hidden).toBe(false);
      expect(message.textContent).toBe("This file couldn't be reloaded.");
      expect(retry.hidden).toBe(false);
      expect(retry.tagName).toBe("BUTTON");
      expect(retry.getAttribute("aria-label")).toBe("Retry loading this file");
    });
  });

  test("hiding the notice hides its Retry button too", () => {
    // linkedom has no focus model; the focus handoff is covered by the e2e.
    withNotice(document => {
      setReloadNotice("gave-up");
      setReloadNotice("hidden");
      const { notice, retry } = parts(document);
      expect(notice.hidden).toBe(true);
      expect(retry.hidden).toBe(true);
    });
  });
});
