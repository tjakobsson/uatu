// In-page and cross-document anchor handlers for the preview body.
// Extracted from `app.ts` so all of the preview's click-interception logic
// lives in one module. Both handlers are attached to `#preview` and decide
// per-click whether to override the browser's default navigation.

import { findDocumentById, findDocumentByRelativePath } from "../shell/storage";
import { buildInPageAnchorUrl } from "./anchor-url";
import { loadDocument } from "./mount";
import { renderEmptyPreview } from "./empty";
import { renderSidebar } from "../sidebar/shell";
import { syncFollowToggle } from "../shell/follow";
import { pushSelection, scrollToFragment } from "../shell/history";
import { appState } from "../shell/state";

export { buildInPageAnchorUrl } from "./anchor-url";

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (!previewElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/anchors)");
}

const previewElement: HTMLElement = previewElementMaybe;

// Intercept clicks on in-page anchor links (`<a href="#x">`) in the preview and
// scroll the matching element into view directly. Letting the browser handle
// these natively would resolve them against `<base href>` (set per-document to
// the doc's directory so relative image URLs work), which means a TOC link
// inside e.g. `guides/setup.adoc` resolves to `/guides/#x` and triggers a full
// navigation to the server's static fallback — returning 404. Intercepting
// gives us same-document scroll regardless of the base href.
export function initInPageAnchorHandler() {
  previewElement.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const anchor = target.closest("a");
    if (!anchor) {
      return;
    }
    const href = anchor.getAttribute("href");
    if (!href || !href.startsWith("#") || href === "#") {
      return;
    }
    // Don't override modifier-clicks the user explicitly intended (open in new
    // tab, etc.) — the browser will do something reasonable with the resolved
    // URL even if it's not a same-doc fragment.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    // decodeURIComponent throws URIError on malformed percent-sequences
    // (e.g. `#bad%GGid`). Treat that as "let the browser handle it" rather
    // than swallowing the click silently with an uncaught error.
    let id: string;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    const element = previewElement.querySelector(`[id="${cssEscape(id)}"]`);
    if (!(element instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    element.scrollIntoView({ behavior: "smooth", block: "start" });

    // Push a history entry so the browser back button returns the user to
    // the previous scroll state of the *same* document (fragment-less URL
    // or prior fragment) rather than to a previously selected document.
    // The popstate handler in `src/shell/history.ts` recognizes the
    // same-pathname-hash-changed case and treats it as a scroll-only event.
    const targetUrl = buildInPageAnchorUrl(window.location, id);
    const currentUrl = window.location.pathname
      + window.location.search
      + window.location.hash;
    if (targetUrl !== currentUrl) {
      window.history.pushState(null, "", targetUrl);
    }
  });
}


export function cssEscape(value: string): string {
  // Conservative escape for use inside [id="..."] attribute selectors. Only
  // backslashes and double quotes need escaping for that context.
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

// Intercept clicks on cross-document anchors (`<a href="other.adoc">`,
// `<a href="guides/setup.md">`, etc.) and switch the preview to the linked
// document via the existing in-app load path. Without this, the browser
// performs a full navigation to that URL — the static-file fallback then
// serves the raw `.adoc`/`.md` text (or triggers a download), bypassing the
// renderer entirely. We only intercept when the resolved URL maps to a
// non-binary document we know about; everything else (binary files,
// off-root paths, external URLs, modifier-clicks, target="_blank") falls
// through to the browser's default behavior.
export function initCrossDocAnchorHandler() {
  previewElement.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const anchor = target.closest("a");
    if (!anchor) {
      return;
    }

    // Modifier-clicks → respect the user's intent (open in new tab, etc.).
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    // target="_blank" / "_parent" / etc. → don't override.
    const explicitTarget = anchor.getAttribute("target");
    if (explicitTarget && explicitTarget !== "_self") {
      return;
    }

    const rawHref = anchor.getAttribute("href");
    if (!rawHref) {
      return;
    }

    // Fragment-only links are handled by initInPageAnchorHandler.
    if (rawHref.startsWith("#")) {
      return;
    }

    // anchor.href is the DOM-resolved absolute URL (it already accounts for
    // the per-document `<base href>`), which is what we need to map back to a
    // document path.
    let resolved: URL;
    try {
      resolved = new URL(anchor.href);
    } catch {
      return;
    }

    // `URL.origin` is `"null"` for `mailto:`/`javascript:`/`blob:`/etc., and
    // `window.location.origin` is always an `http(s)://host` triple, so this
    // single check eliminates both off-origin URLs and non-http(s) protocols.
    if (resolved.origin !== window.location.origin) {
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(resolved.pathname);
    } catch {
      return;
    }
    const relativePath = pathname.replace(/^\/+/, "");
    if (!relativePath) {
      return;
    }

    const doc = findDocumentByRelativePath(relativePath);

    // Binary docs are non-clickable in the sidebar but a hand-authored link
    // to one (e.g. a PDF) should still let the browser fetch it through the
    // static-file fallback.
    if (doc && doc.kind === "binary") {
      return;
    }

    if (!doc) {
      // Same-origin link the SPA can't map to a known viewable document
      // (renamed file, typo, etc.). Letting this fall through would trigger
      // a full browser navigation to the server's 404, tearing down every
      // SPA-owned WebSocket (notably the embedded terminal's). Intercept,
      // push the unresolved path so the back button returns to the current
      // doc, and show the same in-app empty state the popstate handler
      // renders for the equivalent case. Mirrors `history.ts:187-202`.
      event.preventDefault();
      if (appState.scope.kind === "file") {
        const pinnedDoc = appState.selectedId ? findDocumentById(appState.selectedId) : null;
        window.history.pushState(null, "", resolved.pathname);
        renderSidebar();
        renderEmptyPreview(
          "Session pinned",
          pinnedDoc
            ? `Session pinned to ${pinnedDoc.relativePath}. Unpin to view other documents.`
            : "Session pinned to another file. Unpin to view other documents.",
        );
        return;
      }
      appState.followEnabled = false;
      appState.selectedId = null;
      appState.previewMode = { kind: "empty" };
      window.history.pushState(null, "", resolved.pathname);
      syncFollowToggle();
      renderSidebar();
      renderEmptyPreview("Document not found", `Document not found at ${relativePath}.`);
      return;
    }

    event.preventDefault();
    appState.followEnabled = false;
    appState.selectedId = doc.id;
    appState.previewMode = { kind: "document" };
    pushSelection(doc.id, doc.relativePath);
    syncFollowToggle();
    renderSidebar();
    void loadDocument(doc.id).then(() => {
      if (resolved.hash) {
        scrollToFragment(resolved.hash.slice(1));
      }
    });
  });
}

// Convenience boot wrapper so `app.ts` can install both with a single call.
export function installAnchorHandlers(): void {
  initInPageAnchorHandler();
  initCrossDocAnchorHandler();
}
