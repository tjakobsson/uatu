// Browser history / URL synchronization for in-app navigation. These
// functions push, replace, or react to history entries so the URL bar
// stays in lockstep with the active preview without ever triggering a
// full-page navigation.
//
// The popstate handler is exported as `attachPopstateHandler()` so the
// caller (app.ts) controls when it's attached — importing this module
// must not, by itself, install a global event listener.

import { appDocumentRelativePath, appUrl } from "../shared/app-url";
import { findDocumentById, findDocumentByRelativePath } from "./storage";
import { loadDocument } from "../preview/mount";
import { renderEmptyPreview } from "../preview/empty";
import { renderSidebar } from "../sidebar/shell";
import { setFollowEnabled, syncFollowToggle } from "./follow";
import { defaultDocumentId } from "../shared/types";
import { appState } from "./state";
import { setPreviewMode, setSelectedId } from "./selection";
import {
  activateCommitPreview,
  commitPreviewParamsFromUrl,
} from "./url";
import { previewScrollRoot } from "./preview-scroll-root";

// Local query for the preview body. We can't import this from `../app`
// without widening the type to `HTMLElement | null` for consumers — the
// in-app.ts throw-if-null guard narrows it inside that module, but the
// exported type is the original `T | null`. Querying here lets us assert
// non-null directly. The `!` matches the same precondition the shell's
// other module-load throw-if-null guards enforce.
const previewElement = document.querySelector<HTMLElement>("#preview")!;

// Build a same-origin URL for a document. Per-segment percent-encoding mirrors
// the cross-doc handler's decode: each path segment is encoded individually so
// `/` separators stay as path separators and other special characters
// (spaces, unicode, `#`, `?`) are escaped.
export function buildDocumentPath(relativePath: string): string {
  return appUrl("/" + relativePath.split("/").map(encodeURIComponent).join("/"));
}

// Push a new history entry for a user-initiated selection change. No-op when
// the URL already matches the target — clicking the currently active doc
// must not grow the back stack.
export function pushSelection(documentId: string, relativePath: string) {
  const url = buildDocumentPath(relativePath);
  if (window.location.pathname === url) {
    return;
  }
  window.history.pushState({ documentId }, "", url);
}

export function buildCommitPreviewPath(repositoryId: string, sha: string): string {
  const url = new URL(appUrl("/"), window.location.origin);
  url.searchParams.set("repository", repositoryId);
  url.searchParams.set("commit", sha);
  return `${url.pathname}${url.search}`;
}

export function pushCommitPreview(repositoryId: string, sha: string) {
  const nextPath = buildCommitPreviewPath(repositoryId, sha);
  const currentPath = `${window.location.pathname}${window.location.search}`;
  if (currentPath === nextPath) {
    return;
  }
  window.history.pushState({ commitRepositoryId: repositoryId, commitSha: sha }, "", nextPath);
}

// Replace the current history entry with a new selection. Used for follow-mode
// auto-switches (so the URL stays accurate without polluting the back stack)
// and on initial boot (so `history.state` carries the document id for
// subsequent popstate resolution — the initial entry has `state === null`
// until we set it). The hash is preserved on the boot path so a deep link
// like `/guides/setup.md#installation` still scrolls to the named heading.
export function replaceSelection(documentId: string, relativePath: string) {
  const url = buildDocumentPath(relativePath) + window.location.hash;
  window.history.replaceState({ documentId }, "", url);
}

export function scrollToFragment(rawId: string) {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return;
  }
  // Headings emerge from sanitize with `user-content-` prefixed onto every
  // id; mirror the same prefix on incoming fragments so a `#section` link
  // lands on the prefixed heading id without authors having to know.
  const candidates = id.startsWith("user-content-") ? [id] : [`user-content-${id}`, id];
  for (const candidate of candidates) {
    const element = previewElement.querySelector(`[id="${cssEscape(candidate)}"]`);
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
}

function cssEscape(value: string): string {
  // Conservative escape for use inside [id="..."] attribute selectors. Only
  // backslashes and double quotes need escaping for that context.
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isSameDocumentHashOnlyNavigation(): boolean {
  if (!appState.selectedId) {
    return false;
  }
  const activeDoc = findDocumentById(appState.selectedId);
  if (!activeDoc) {
    return false;
  }
  const pathname = appDocumentRelativePath(window.location.pathname);
  return pathname !== "" && pathname === activeDoc.relativePath;
}

// Handle browser back/forward navigation. The browser has already moved the
// URL by the time this fires, so we re-resolve the new pathname against the
// current root index and load that document — without ourselves pushing or
// replacing history. Follow mode is disabled here for the same reason a
// sidebar click disables it: a back press is an explicit navigation intent
// that would otherwise be immediately undone by the next file-change-driven
// auto-switch.
// A transient layer that a back press should dismiss before the document
// navigation below ever runs — Chat's subagent drill-down is the first.
// Registered rather than racing the popstate listener order: the layer's own
// module boots long after `attachPopstateHandler()`, so "who listened first"
// is not a contract anything can rely on. An interceptor returns true when it
// consumed the back press.
type BackInterceptor = () => boolean;
const backInterceptors: BackInterceptor[] = [];

export function registerBackInterceptor(interceptor: BackInterceptor): () => void {
  backInterceptors.push(interceptor);
  return () => {
    const at = backInterceptors.indexOf(interceptor);
    if (at !== -1) backInterceptors.splice(at, 1);
  };
}

export function attachPopstateHandler() {
  window.addEventListener("popstate", () => {
    // Topmost layer first — the most recently registered is the one on screen.
    for (const interceptor of [...backInterceptors].reverse()) {
      if (interceptor()) return;
    }
    // Same-document hash-only navigation: the user clicked an in-page anchor
    // (e.g. a TOC entry) which pushed a `#fragment` history entry, then hit
    // back. Pathname is unchanged so we MUST NOT reload the document, and we
    // MUST NOT disable follow mode — TOC navigation is not a document switch.
    if (isSameDocumentHashOnlyNavigation()) {
      if (window.location.hash) {
        scrollToFragment(window.location.hash.slice(1));
      } else {
        // Whichever element is the actual scrollable viewport — `#preview` is
        // only the inner article, and `.preview-shell` stops scrolling in
        // touch mode and the ≤900px stacked layout. Scrolling a non-scroller
        // is silent, not an error, which is how this class of bug hides.
        previewScrollRoot().scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }

    if (appState.followEnabled) {
      setFollowEnabled(false);
      syncFollowToggle();
    }

    const commitPreview = commitPreviewParamsFromUrl();
    if (commitPreview) {
      activateCommitPreview(commitPreview, { pushHistory: false });
      return;
    }

    const urlRelativePath = appDocumentRelativePath(window.location.pathname);

    if (!urlRelativePath) {
      const fallbackId = defaultDocumentId(appState.roots);
      if (fallbackId) {
        setSelectedId(fallbackId);
        setPreviewMode({ kind: "document" });
        renderSidebar();
        void loadDocument(fallbackId);
      } else {
        setSelectedId(null);
        setPreviewMode({ kind: "empty" });
        renderSidebar();
        renderEmptyPreview("No document selected", "Waiting for viewable files");
      }
      return;
    }

    const requestedDoc = findDocumentByRelativePath(urlRelativePath);
    if (requestedDoc && requestedDoc.kind !== "binary") {
      setSelectedId(requestedDoc.id);
      setPreviewMode({ kind: "document" });
      renderSidebar();
      void loadDocument(requestedDoc.id).then(() => {
        if (window.location.hash) {
          scrollToFragment(window.location.hash.slice(1));
        }
      });
      return;
    }

    if (appState.scope.kind === "file") {
      const pinnedDoc = appState.selectedId ? findDocumentById(appState.selectedId) : null;
      renderSidebar();
      renderEmptyPreview(
        "Session pinned",
        pinnedDoc
          ? `Session pinned to ${pinnedDoc.relativePath}. Unpin to view other documents.`
          : "Session pinned to another file. Unpin to view other documents.",
      );
      return;
    }

    setSelectedId(null);
    setPreviewMode({ kind: "empty" });
    renderSidebar();
    renderEmptyPreview("Document not found", `Document not found at ${urlRelativePath}.`);
  });
}
