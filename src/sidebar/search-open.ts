// Opening a search result: navigate to the document, then reveal the match.
//
// The awkward part of project search is that the corpus is *source* text while
// the reading surface is usually *rendered*. Roughly any match inside link
// syntax, heading markers, or a code fence exists in the file but not in the
// rendered DOM, so landing blindly would scroll to nothing.
//
// The rule: land in the view the reader is already in, and fall back to Source
// only when the match cannot be found there. Source is where the match always
// exists, because that is what was searched.

import { applyUserRowClick } from "../shell/follow";
import { applyViewMode } from "../preview/view-mode";
import { appState } from "../shell/state";
import { revealExternalMatch } from "../find/reveal";

export type SearchResultTarget = {
  documentId: string;
  // 1-based, as the search reports it.
  line: number;
  start: number;
  end: number;
  query: string;
};

export type OpenOptions = {
  // The literal text that matched. For a literal query that is the query
  // itself; under a regex it varies per hit, so the row carries its own slice.
  matchText: string;
  // Which occurrence of `matchText` within the document this row is, counted
  // from zero in source order. Without it every row for a repeated string
  // would reveal the first one.
  occurrence: number;
  // Whether the result came from a search that deliberately ignored the
  // session scope.
  fromAllRoots: boolean;
};

export async function openSearchResult(
  target: SearchResultTarget,
  options?: Partial<OpenOptions>,
): Promise<void> {
  const matchText = options?.matchText ?? target.query;
  const occurrence = options?.occurrence ?? 0;

  // A widened search can return documents the session's scope excludes. The
  // client cannot find them in `appState.roots` and `/api/document` resolves
  // against the scoped roots too, so opening one would 404 into "Document
  // unavailable" — the escape hatch would surface results it cannot open.
  // Widening the session first is the honest reading of "search all roots":
  // the user already opted out of the scope to find this.
  if (options?.fromAllRoots && !isDocumentInScope(target.documentId)) {
    await widenSessionScope();
  }

  // Rule A: this is a user navigation, so Follow turns off and history gets an
  // entry, exactly as a tree click would.
  await applyUserRowClick(target.documentId);

  if (matchText.length === 0) {
    return;
  }

  // Try where the reader already is. Forcing Rendered would override a
  // deliberate global preference on every single result click.
  if (revealExternalMatch(matchText, occurrence)) {
    return;
  }

  // Not visible here — Source is where the searched text lives, and where the
  // occurrence ordinal is exact, because source is what was searched.
  //
  // Known limitation: the ordinal is a *source* ordinal, and the rendered view
  // can hold fewer occurrences (a link URL matched in source is not rendered as
  // text). When it does, the ordinal overshoots what the rendered view offers
  // and we fall back to Source even though the hit may have been visible.
  // Landing on a different occurrence would be worse than an extra view flip,
  // and identifying the right one needs a source-to-rendered position map the
  // renderer does not emit.
  if (appState.viewMode !== "source") {
    applyViewMode("source");
    // `applyViewMode` remounts the preview asynchronously; wait for the swap
    // before looking again.
    await nextMount();
    revealExternalMatch(matchText, occurrence);
  }
}

function isDocumentInScope(documentId: string): boolean {
  return appState.roots.some(root => root.docs.some(doc => doc.id === documentId));
}

// Drop the session back to folder scope. Server-session state shared across
// clients, so this is deliberate and visible rather than a silent per-request
// override — the sidebar and the preview stay describing the same corpus.
async function widenSessionScope(): Promise<void> {
  try {
    await fetch("/api/scope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: { kind: "folder" } }),
    });
    // The SSE snapshot that follows repopulates `appState.roots`; wait for it
    // rather than racing the broadcast with the navigation below.
    await waitForFolderScope();
  } catch {
    // Offline or refused — the navigation below will surface the failure.
  }
}

// Poll briefly for the widened scope to arrive over SSE.
function waitForFolderScope(timeoutMs = 2000): Promise<void> {
  const startedAt = performance.now();
  return new Promise(resolve => {
    const tick = (): void => {
      if (appState.scope.kind === "folder" || performance.now() - startedAt > timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(tick, 50);
    };
    tick();
  });
}

// Resolve once the preview's children have been replaced, or after a short
// grace period if the swap already happened. Cheaper and less brittle than
// threading a completion signal through the view-mode module.
function nextMount(timeoutMs = 1500): Promise<void> {
  const preview = document.querySelector("#preview");
  if (!preview) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      // One frame for the mount's own follow-up work (line numbers, wrap).
      requestAnimationFrame(() => resolve());
    };
    const observer = new MutationObserver(finish);
    observer.observe(preview, { childList: true });
    const timer = window.setTimeout(finish, timeoutMs);
  });
}
