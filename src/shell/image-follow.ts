// Rule C's deferred image decision. With Follow on, a changed image moves the
// selection unless the shown document embeds it (it then refreshes in place).
// Which images a Markdown or AsciiDoc document embeds is known only once its
// rendered payload for the current revision has been read (see
// preview/embedded-images.ts); a document shown as Source or Diff looks that
// payload up in the background. While the answer is unknown the change must
// not be guessed either way: following would take the reader off a document
// that embeds the image, and staying would drop a change Follow should show.
//
// So the decision waits for the lookup. One decision is held at a time, the
// latest changed image's. It is settled when the lookup answers:
//   embedded       → stay; the image refreshes in place
//   not embedded   → follow the image
//   lookup failed  → follow the image (Rule C's default; a failed lookup
//                    proves nothing about the document, and following shows
//                    the change rather than losing it)
// and it is dropped without moving anything when something newer decided the
// selection meanwhile: another file change (`cancel`), a selection change or
// a user activation, an edit to the document, a Follow switch, Follow being
// off, or the preview no longer showing documents. `guard` folds the
// selection, activation, Follow-switch, and document-revision facts into one
// key captured when the decision is deferred and compared when it settles.
//
// No DOM: the shell wires it in events.ts; the unit tests drive it directly.

import type { EmbeddedImageMembership, EmbeddedImagesLookup } from "../preview/embedded-images";

export type DeferredImageFollowDeps = {
  guard: (documentId: string) => string;
  canFollow: () => boolean;
  lookup: (documentId: string) => Promise<EmbeddedImagesLookup>;
  membership: (documentId: string) => EmbeddedImageMembership;
  follow: (imageId: string) => void;
};

export type DeferredImageFollow = {
  // Hold the image decision for `documentId` (the shown document) until its
  // embedded images are known. Replaces any decision already held.
  defer: (documentId: string, imageId: string) => void;
  // Drop the held decision: a newer selection decision has been made.
  cancel: () => void;
  // The image whose decision is held, if any.
  pending: () => string | null;
};

export function createDeferredImageFollow(deps: DeferredImageFollowDeps): DeferredImageFollow {
  let held: { documentId: string; imageId: string; guard: string } | null = null;

  function settle(documentId: string, guard: string, outcome: EmbeddedImagesLookup): void {
    // Only the lookup the held decision is waiting on settles it; one started
    // for an older decision answers nothing about this one.
    const decision = held;
    if (!decision || decision.documentId !== documentId || decision.guard !== guard) return;
    held = null;
    if (!deps.canFollow() || deps.guard(documentId) !== guard) return;
    const membership = deps.membership(documentId);
    if (membership.known) {
      if (!membership.ids.has(decision.imageId)) deps.follow(decision.imageId);
      return;
    }
    if (outcome === "failed") deps.follow(decision.imageId);
  }

  return {
    defer(documentId, imageId) {
      const guard = deps.guard(documentId);
      held = { documentId, imageId, guard };
      // The lookup is shared per document revision, so a burst of image
      // changes waits on one request.
      void deps.lookup(documentId).then(
        outcome => settle(documentId, guard, outcome),
        () => settle(documentId, guard, "failed"),
      );
    },
    cancel() {
      held = null;
    },
    pending() {
      return held?.imageId ?? null;
    },
  };
}
