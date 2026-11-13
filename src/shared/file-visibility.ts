import type { DocumentMeta } from "./types";

// Follow never jumps to a file Git ignores (builds, installs, renders),
// whether or not ignored files are shown. Unknown classification stays
// eligible, matching the visible-when-unknown display.
export function isFollowEligible(doc: Pick<DocumentMeta, "gitIgnoreStatus">): boolean {
  return doc.gitIgnoreStatus !== "ignored";
}

export function isDocumentVisible(doc: DocumentMeta, showIgnored = true): boolean {
  return showIgnored || doc.gitIgnoreStatus !== "ignored" || doc.ignoreVisibilityException === true;
}
