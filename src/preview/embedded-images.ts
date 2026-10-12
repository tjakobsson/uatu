// Which watched images the shown document embeds — read from the document's
// rendered payload, never from the live preview DOM. Follow (Rule C) reads it
// to keep a document selected when one of its own images changes: that image
// refreshes in place (image-revision.ts) instead of taking the preview over.
//
// The rendered payload is the only representation that names the images, and
// Source, Diff, and split layouts show it partly or not at all. So the record
// is kept per document revision, independent of the view on screen: a rendered
// payload fills it whenever one is fetched, and a document shown only as
// Source or Diff has its rendered payload looked up once per revision just for
// this (see `learnEmbeddedImages` in mount.ts). Only the shown document is
// remembered.
//
// Membership is known only for the revision the record was taken from. Until
// the lookup for the current revision has answered it is unknown — not an
// empty list — and Follow defers its image decision rather than guessing (see
// shell/image-follow.ts).
//
// The record keeps the authored `src` values and the document's base URL, not
// resolved ids, so an image created after the document was rendered is still
// recognised when it appears in the index.

import type { DocumentMeta, RootGroup } from "../shared/types";
import { imageDocumentId } from "./image-revision";

type EmbeddedImages = {
  documentId: string;
  revision: string;
  baseUrl: string;
  sources: readonly string[];
};

// What is known about the images a document embeds: the ids, or nothing yet.
export type EmbeddedImageMembership =
  | { known: true; ids: ReadonlySet<string> }
  | { known: false };

// How one lookup of a document's rendered payload ended. `known`: the record
// now holds the revision asked about. `stale`: the document is no longer
// selected, or its revision moved, so the answer was dropped. `failed`: no
// usable answer (a network error, a non-OK status, or no answer in time).
export type EmbeddedImagesLookup = "known" | "stale" | "failed";

let record: EmbeddedImages | null = null;

export function recordEmbeddedImages(
  documentId: string,
  revision: string,
  baseUrl: string,
  sources: readonly string[],
): void {
  record = { documentId, revision, baseUrl, sources };
}

// Whether the images of `documentId` at `revision` are already known.
export function knowsEmbeddedImages(documentId: string, revision: string): boolean {
  return record?.documentId === documentId && record.revision === revision;
}

// Only Markdown and AsciiDoc render images; any other file embeds none.
export function canEmbedImages(document: Pick<DocumentMeta, "kind">): boolean {
  return document.kind === "markdown" || document.kind === "asciidoc";
}

// The watched files `document` (at `revision`) embeds as images, resolved
// against `roots`. No document, or one that cannot embed images, embeds
// nothing — that is known. A Markdown or AsciiDoc document is known only once
// its rendered payload at this very revision has been recorded: an edit can
// add or remove images, so an older record does not answer.
export function embeddedImageMembership(
  document: Pick<DocumentMeta, "id" | "kind"> | null | undefined,
  revision: string,
  roots: readonly RootGroup[],
  basePath: string,
): EmbeddedImageMembership {
  if (!document || !canEmbedImages(document)) return { known: true, ids: new Set() };
  if (!record || !knowsEmbeddedImages(document.id, revision)) return { known: false };
  const ids = new Set<string>();
  for (const src of record.sources) {
    const id = imageDocumentId(src, record.baseUrl, basePath, roots);
    if (id) ids.add(id);
  }
  return { known: true, ids };
}

// Looks up the images of a document whose rendered payload is not on the page
// (shown as Source or Diff): one request per document revision, shared by
// every caller that asks while it is in flight. The answer is recorded only
// while it still belongs to what is on screen — the document is still the
// selected one and still at the revision the request was made for. A late
// answer for a document the user has left, or for a revision that has since
// changed, is dropped (`stale`); the newer revision's load asks again.
export type EmbeddedImagesLearnerDeps = {
  revisionOf: (documentId: string) => string;
  isSelected: (documentId: string) => boolean;
  // Null, or a rejection, when no usable answer arrived. Must settle: the
  // caller bounds the request (see mount.ts).
  fetchSources: (documentId: string) => Promise<{ baseUrl: string; sources: readonly string[] } | null>;
};

export function createEmbeddedImagesLearner(
  deps: EmbeddedImagesLearnerDeps,
): (documentId: string) => Promise<EmbeddedImagesLookup> {
  let inFlight: { key: string; lookup: Promise<EmbeddedImagesLookup> } | null = null;
  return documentId => {
    const revision = deps.revisionOf(documentId);
    if (knowsEmbeddedImages(documentId, revision)) return Promise.resolve("known");
    const key = `${documentId}\n${revision}`;
    if (inFlight?.key === key) return inFlight.lookup;
    const lookup = (async (): Promise<EmbeddedImagesLookup> => {
      let learned: Awaited<ReturnType<EmbeddedImagesLearnerDeps["fetchSources"]>>;
      try { learned = await deps.fetchSources(documentId); } catch { learned = null; }
      if (!deps.isSelected(documentId) || deps.revisionOf(documentId) !== revision) return "stale";
      if (!learned) return "failed";
      recordEmbeddedImages(documentId, revision, learned.baseUrl, learned.sources);
      return "known";
    })().finally(() => {
      if (inFlight?.key === key) inFlight = null;
    });
    inFlight = { key, lookup };
    return lookup;
  };
}

export function resetEmbeddedImagesForTests(): void {
  record = null;
}
