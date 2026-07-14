// Document render dispatch: given the current root index and a document id,
// produce the HTML payload for /api/document. Chooses the renderer by file
// kind and requested view (rendered / source), and extracts a display title
// from the rendered output.

import { promises as fs } from "node:fs";
import path from "node:path";

import { collectFileFacts } from "../document/file-facts";
import { type DocumentMetadata, sanitizeMetadata } from "../document/metadata";
import { languageForName } from "../document/languages";
import { renderAsciidocToHtml } from "../render/asciidoc";
import { decodeHtmlEntities, renderCodeAsHtml, renderMarkdownToHtml } from "../render/markdown";
import { findDocument, type FileFacts, type RootGroup, type ViewMode } from "../shared/types";

export type RenderedDocument = {
  id: string;
  title: string;
  path: string;
  html: string;
  kind: "markdown" | "asciidoc" | "text";
  // The rendering applied for this response. "rendered" runs Markdown /
  // AsciiDoc through their full pipelines; "source" returns the file's
  // verbatim text in a `<pre class="uatu-source-pre"><code>` block. Text /
  // source files (kind === "text") are always rendered as "source" since they
  // have no separate rendered representation.
  view: ViewMode;
  language: string | null;
  metadata?: DocumentMetadata;
  // Repo-derived facts (lines, bytes, mtime, last-commit) — attached to every
  // payload regardless of view so the per-view client cache keeps one shape;
  // the client gates display on view mode. Absent only if collection failed
  // outright (stat error).
  fileFacts?: FileFacts;
};

export type RenderDocumentOptions = {
  view?: ViewMode;
};

export async function renderDocument(
  roots: RootGroup[],
  documentId: string,
  options: RenderDocumentOptions = {},
): Promise<RenderedDocument> {
  const document = findDocument(roots, documentId);
  if (!document) {
    throw new Error("document not found");
  }

  if (document.kind === "binary") {
    throw new Error("document is binary");
  }

  const source = await fs.readFile(document.id, "utf8");
  // Facts collection (stat + two git subprocesses) overlaps the render work
  // below; awaited just before assembling the payload.
  // The root group always exists for a found document; the dirname fallback
  // is a type-level guard only.
  const rootPath = roots.find(root => root.id === document.rootId)?.path ?? path.dirname(document.id);
  const fileFactsPromise = collectFileFacts({
    absolutePath: document.id,
    rootPath,
    source,
  });
  const requestedView: ViewMode = options.view ?? "rendered";
  // Text / source files have no separate rendered representation, so a
  // request for "rendered" still produces source rendering. Markdown and
  // AsciiDoc honor the requested view.
  const effectiveView: ViewMode =
    document.kind === "markdown" || document.kind === "asciidoc"
      ? requestedView
      : "source";

  let html: string;
  let metadata: DocumentMetadata | undefined;
  let language: string | null;
  let title: string;

  if (effectiveView === "source") {
    // Whole-file source rendering: `<pre class="uatu-source-pre"><code>...`,
    // syntax-highlighted by file kind. Markdown / AsciiDoc files highlight
    // as their own markup languages (see file-languages.ts).
    language = languageForName(document.name) ?? null;
    html = renderCodeAsHtml(source, language ?? undefined);
    metadata = undefined;
    title = document.name;
  } else if (document.kind === "markdown") {
    const rendered = renderMarkdownToHtml(source);
    html = rendered.html;
    metadata = sanitizeMetadata(rendered.metadata);
    language = null;
    title = extractTitle(html, document.name);
  } else if (document.kind === "asciidoc") {
    const rendered = await renderAsciidocToHtml(source);
    html = rendered.html;
    metadata = sanitizeMetadata(rendered.metadata);
    language = null;
    title = extractTitle(html, document.name);
  } else {
    // `effectiveView === "rendered"` was forced to "source" above for any
    // non-markdown/non-asciidoc kind, so this branch is unreachable. Kept as
    // an exhaustive guard for the type-checker.
    language = languageForName(document.name) ?? null;
    html = renderCodeAsHtml(source, language ?? undefined);
    metadata = undefined;
    title = document.name;
  }

  const fileFacts = await fileFactsPromise;

  return {
    id: document.id,
    path: document.relativePath,
    title,
    html,
    kind: document.kind,
    view: effectiveView,
    language,
    ...(metadata ? { metadata } : {}),
    ...(fileFacts ? { fileFacts } : {}),
  };
}

// Pull the title from the FIRST `<h1>` in the rendered HTML rather than from
// the raw Markdown source. Two reasons:
//   1) The previous source-side regex was unaware of fenced code blocks, so a
//      `# Lockfiles` comment inside a fenced ` ```gitignore ` block would win
//      over the actual document heading.
//   2) Working off rendered HTML lets us pick up GitHub-style centered hero
//      headings (`<h1 align="center">…</h1>`), which Markdown source regex
//      can't see.
// The HTML is already sanitized — `<h1>` survives, `<script>`/etc. don't.
function extractTitle(html: string, fallbackName: string): string {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (match?.[1]) {
    const text = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, "")).trim();
    if (text) {
      return text;
    }
  }

  return fallbackName.replace(/\.(md|markdown|adoc|asciidoc)$/i, "");
}
