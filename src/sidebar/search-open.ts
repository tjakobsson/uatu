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

// The literal text that matched, reconstructed from the query. For a literal
// query that is the query itself; for a regex the matched text varies per hit,
// so the offsets carry the truth and the caller supplies the matched slice.
export type OpenOptions = {
  matchText: string;
};

export async function openSearchResult(
  target: SearchResultTarget,
  options?: Partial<OpenOptions>,
): Promise<void> {
  const matchText = options?.matchText ?? target.query;

  // Rule A: this is a user navigation, so Follow turns off and history gets an
  // entry, exactly as a tree click would.
  await applyUserRowClick(target.documentId);

  if (matchText.length === 0) {
    return;
  }

  // Try where the reader already is. Forcing Rendered would override a
  // deliberate global preference on every single result click.
  if (revealExternalMatch(matchText)) {
    return;
  }

  // Not visible here — Source is where the searched text lives.
  if (appState.viewMode !== "source") {
    applyViewMode("source");
    // `applyViewMode` remounts the preview asynchronously; wait for the swap
    // before looking again.
    await nextMount();
    revealExternalMatch(matchText);
  }
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
