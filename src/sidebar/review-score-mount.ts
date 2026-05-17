// Review-burden score-details preview renderer — writes the explanatory
// breakdown of a repository's burden score into the preview body when the
// score chip in the change-overview pane is activated. Extracted from
// `app.ts` so the sidebar feature folder owns this preview alongside the
// other score / change-overview presentation helpers.

import type { RepositoryReviewSnapshot } from "../shared/types";
import { recomputeSelectionInspector } from "../shell/inspector-instance";
import { clearPreviewType } from "../preview/header";
import { closeMermaidViewer } from "../preview/mermaid-viewer";
import { hideViewToggle } from "../preview/view-mode";
import { buildScoreExplanationHTML } from "./score-explanation";

const previewTitleElementMaybe = document.querySelector<HTMLElement>("#preview-title");
const previewPathElementMaybe = document.querySelector<HTMLElement>("#preview-path");
const previewBaseElementMaybe = document.querySelector<HTMLBaseElement>("#preview-base");
const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (
  !previewTitleElementMaybe ||
  !previewPathElementMaybe ||
  !previewBaseElementMaybe ||
  !previewElementMaybe
) {
  throw new Error("uatu UI failed to initialize (sidebar/review-score-mount)");
}

// Locally-scoped non-null aliases. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies (the
// hoisted function declarations sit outside the if-block's control-flow
// scope), so we re-alias to `T` here.
const previewTitleElement: HTMLElement = previewTitleElementMaybe;
const previewPathElement: HTMLElement = previewPathElementMaybe;
const previewBaseElement: HTMLBaseElement = previewBaseElementMaybe;
const previewElement: HTMLElement = previewElementMaybe;

export function renderReviewScoreDetails(repository: RepositoryReviewSnapshot) {
  const load = repository.reviewLoad;
  if (load.status !== "available") {
    return;
  }
  closeMermaidViewer();
  previewTitleElement.textContent = "Review burden score";
  previewPathElement.textContent = repository.label;
  clearPreviewType();
  hideViewToggle();
  previewBaseElement.href = new URL("/", window.location.origin).toString();
  previewElement.classList.remove("empty");
  previewElement.innerHTML = buildScoreExplanationHTML(load);
  recomputeSelectionInspector();
}
