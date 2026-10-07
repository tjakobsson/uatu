import type { ViewLayout, ViewMode } from "../shared/types";

export type DocumentLoadToken = {
  generation: number;
  selectionGeneration: number;
  documentId: string;
  view: ViewMode;
  layout: ViewLayout;
  revision: string;
};

export function createDocumentLoadGuard(selectionGeneration: () => number = () => 0, revisionOf: (id: string) => string = () => "") {
  let latestGeneration = 0;

  return {
    begin(documentId: string, view: ViewMode, layout: ViewLayout): DocumentLoadToken {
      return { generation: ++latestGeneration, selectionGeneration: selectionGeneration(), documentId, view, layout, revision: revisionOf(documentId) };
    },
    isCurrent(
      token: DocumentLoadToken,
      selectedId: string | null,
      view: ViewMode,
      layout: ViewLayout,
    ): boolean {
      return token.generation === latestGeneration
        && token.selectionGeneration === selectionGeneration()
        && token.documentId === selectedId
        && token.revision === revisionOf(token.documentId)
        && token.view === view
        && token.layout === layout;
    },
  };
}
