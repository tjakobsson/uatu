// Preview header chrome — title chip, path label, type chip, and the
// per-document `<base href>` that anchors relative URLs inside rendered
// documents. Extracted from `app.ts` so the preview/ feature folder owns
// the small block of DOM that frames the rendered body.

const previewTitleElementMaybe = document.querySelector<HTMLElement>("#preview-title");
const previewPathElementMaybe = document.querySelector<HTMLElement>("#preview-path");
const previewTypeElementMaybe = document.querySelector<HTMLElement>("#preview-type");
const previewBaseElementMaybe = document.querySelector<HTMLBaseElement>("#preview-base");
const outlineToggleButtonMaybe = document.querySelector<HTMLButtonElement>("#outline-toggle");
const copySourceButtonMaybe = document.querySelector<HTMLButtonElement>("#copy-source-action");

if (
  !previewTitleElementMaybe
  || !previewPathElementMaybe
  || !previewTypeElementMaybe
  || !previewBaseElementMaybe
  || !outlineToggleButtonMaybe
  || !copySourceButtonMaybe
) {
  throw new Error("uatu UI failed to initialize (preview/header)");
}

// Locally-scoped non-null aliases. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies (the
// hoisted function declarations sit outside the if-block's control-flow
// scope), so we re-alias to `T` here.
const previewTitleElement: HTMLElement = previewTitleElementMaybe;
const previewPathElement: HTMLElement = previewPathElementMaybe;
const previewTypeElement: HTMLElement = previewTypeElementMaybe;
const previewBaseElement: HTMLBaseElement = previewBaseElementMaybe;
const outlineToggleButton: HTMLButtonElement = outlineToggleButtonMaybe;
const copySourceButton: HTMLButtonElement = copySourceButtonMaybe;

// Re-exports so other preview/ modules that already query `#preview-*` don't
// have to redo the throw-if-null dance. Used by `preview/mount.ts` etc.
export { previewTitleElement, previewPathElement, previewTypeElement, previewBaseElement };

// The preview action-icon bar buttons. `outline.ts` owns their behaviour and
// per-render visibility (it knows the rendered DOM's heading count); header
// just owns the throw-if-null query so all `#preview-*` chrome lives here.
export { outlineToggleButton, copySourceButton };

// Hide the entire action-icon bar. Called when leaving document mode (commit /
// review-score / empty previews) where neither copy-source nor an outline
// makes sense. The Rendered-view + heading-count gating for the document case
// lives in `outline.ts`'s refresh, which runs on every document render.
export function hidePreviewActionBar(): void {
  outlineToggleButton.hidden = true;
  outlineToggleButton.setAttribute("aria-pressed", "false");
  copySourceButton.hidden = true;
}

type PreviewTypePayload = {
  kind: "markdown" | "asciidoc" | "text";
  view: "rendered" | "source" | "diff";
  language: string | null;
};

export function setPreviewType(payload: PreviewTypePayload) {
  const baseLabel =
    payload.kind === "markdown"
      ? "markdown"
      : payload.kind === "asciidoc"
        ? "asciidoc"
        : payload.language ?? "text";
  // When the user has flipped a markdown / asciidoc document into source
  // view, surface that in the type badge so it is obvious why the body looks
  // different. Text / source files are always source-rendered and do not get
  // the suffix.
  const label =
    payload.view === "source" && (payload.kind === "markdown" || payload.kind === "asciidoc")
      ? `${baseLabel} (source)`
      : baseLabel;
  previewTypeElement.textContent = label;
  previewTypeElement.hidden = false;
}

export function clearPreviewType() {
  previewTypeElement.textContent = "";
  previewTypeElement.hidden = true;
}

export function setPreviewBase(relativePath: string) {
  // The preview's base href points at the document's directory so relative
  // references inside the markdown (e.g. <img src="./hero.svg">) resolve to
  // URLs the server's static file fallback already knows how to serve.
  const lastSlash = relativePath.lastIndexOf("/");
  const directory = lastSlash === -1 ? "" : relativePath.slice(0, lastSlash + 1);
  previewBaseElement.href = new URL(`/${directory}`, window.location.origin).toString();
}
