// A preview other than a workspace document that is driven by the document
// view chooser (Rendered / Source / Diff), the layout chooser and Wrap: the
// pull request file view (src/preview/pull-request-file.ts). While it owns
// the preview, view-mode.ts and layout.ts hand their changes to it instead of
// reloading the selected document. A registry rather than an import keeps
// the PR view out of the document modules' import graph.

export type PreviewViewHost = {
  // True while this host's content is the preview.
  active(): boolean;
  // The view mode or the layout changed: render again from its cache.
  rerender(): void;
  // Wrap changed: re-apply it in place.
  wrapChanged(): void;
};

let host: PreviewViewHost | null = null;

export function registerPreviewViewHost(next: PreviewViewHost): void {
  host = next;
}

export function activePreviewViewHost(): PreviewViewHost | null {
  return host?.active() ? host : null;
}
