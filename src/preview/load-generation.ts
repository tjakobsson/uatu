import type { ViewLayout, ViewMode } from "../shared/types";

export type DocumentLoadToken = {
  generation: number;
  documentId: string;
  view: ViewMode;
  layout: ViewLayout;
};

export function createDocumentLoadGuard() {
  let latestGeneration = 0;

  return {
    begin(documentId: string, view: ViewMode, layout: ViewLayout): DocumentLoadToken {
      return { generation: ++latestGeneration, documentId, view, layout };
    },
    isCurrent(
      token: DocumentLoadToken,
      selectedId: string | null,
      view: ViewMode,
      layout: ViewLayout,
    ): boolean {
      return token.generation === latestGeneration
        && token.documentId === selectedId
        && token.view === view
        && token.layout === layout;
    },
  };
}
