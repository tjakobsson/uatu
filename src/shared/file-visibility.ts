import type { DocumentMeta } from "./types";

export function isDocumentVisible(doc: DocumentMeta, showIgnored = true): boolean {
  return showIgnored || doc.gitIgnoreStatus !== "ignored" || doc.ignoreVisibilityException === true;
}
