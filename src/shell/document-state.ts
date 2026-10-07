import { DocumentStateIndex } from "../shared/document-updates";

// Shared lookup for document event reduction and preview revision guards.
export let documentIndex = new DocumentStateIndex();
export function resetDocumentIndex(): void { documentIndex = new DocumentStateIndex(); }
export function documentRevisionKey(id: string): string {
  return `${documentIndex.epoch ?? "legacy"}:${documentIndex.find(id)?.revision ?? "missing"}`;
}
