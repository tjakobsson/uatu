// Commit-message preview renderer — writes the per-commit detail card
// (author, sha, full message) into the preview body when a commit link in
// the git-log pane is activated. Extracted from `app.ts` so the preview/
// feature folder owns this body writer alongside the other preview
// renderers.

import { escapeHtml } from "../shared/html";
import { recomputeSelectionInspector } from "../shell/inspector-instance";
import type { RepositoryReviewSnapshot } from "../shared/types";
import { clearPreviewType } from "./header";
import { closeMermaidViewer } from "./mermaid-viewer";
import { hideViewToggle } from "./view-mode";

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
  throw new Error("uatu UI failed to initialize (preview/commit-message)");
}

// Locally-scoped non-null aliases. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies (the
// hoisted function declarations sit outside the if-block's control-flow
// scope), so we re-alias to `T` here.
const previewTitleElement: HTMLElement = previewTitleElementMaybe;
const previewPathElement: HTMLElement = previewPathElementMaybe;
const previewBaseElement: HTMLBaseElement = previewBaseElementMaybe;
const previewElement: HTMLElement = previewElementMaybe;

export function renderCommitMessage(
  repository: RepositoryReviewSnapshot,
  commit: RepositoryReviewSnapshot["commitLog"][number],
) {
  closeMermaidViewer();
  previewTitleElement.textContent = commit.subject;
  previewPathElement.textContent = `${repository.label} · ${commit.sha}`;
  clearPreviewType();
  hideViewToggle();
  previewBaseElement.href = new URL("/", window.location.origin).toString();
  previewElement.classList.remove("empty");
  previewElement.innerHTML = `
    <section class="commit-preview">
      <header>
        <p>${escapeHtml([commit.author, commit.relativeTime].filter(Boolean).join(" · "))}</p>
        <code>${escapeHtml(commit.sha)}</code>
      </header>
      <pre>${escapeHtml(commit.message)}</pre>
    </section>
  `;
  recomputeSelectionInspector();
}
