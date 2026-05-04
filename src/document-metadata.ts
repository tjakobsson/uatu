import { parse as yamlParse } from "yaml";

// Inline escape so this module has no dependency on markdown.ts — markdown.ts
// imports from here, and pulling escapeHtml back through that boundary would
// create a cycle that breaks the test runner's static analysis.
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export type DocumentMetadataAuthor = {
  name: string;
  email?: string;
};

export type DocumentMetadata = {
  title?: string;
  authors?: DocumentMetadataAuthor[];
  date?: string;
  revision?: string;
  description?: string;
  tags?: string[];
  status?: string;
  extras?: Record<string, string>;
};

export type RawMetadataValue = string | string[] | DocumentMetadataAuthor[] | undefined;

export type SourceFormat = "yaml" | "toml" | "asciidoc";

export function isAsciidocInternalAttribute(key: string): boolean {
  return ASCIIDOC_INTERNAL_ATTRS.has(key.toLowerCase());
}

const CURATED_KEYS_BY_FORMAT: Record<SourceFormat, Record<string, keyof DocumentMetadata>> = {
  yaml: {
    title: "title",
    author: "authors",
    authors: "authors",
    date: "date",
    version: "revision",
    revision: "revision",
    description: "description",
    summary: "description",
    tags: "tags",
    keywords: "tags",
    status: "status",
  },
  toml: {
    title: "title",
    author: "authors",
    authors: "authors",
    date: "date",
    version: "revision",
    revision: "revision",
    description: "description",
    summary: "description",
    tags: "tags",
    keywords: "tags",
    status: "status",
  },
  asciidoc: {
    // The caller pre-populates `raw.title` from `getDocumentTitle()` and
    // filters the duplicate `:title:`/`:doctitle:` attribute keys, so this
    // mapping just routes that pre-populated value to `result.title`.
    title: "title",
    author: "authors",
    authors: "authors",
    revdate: "date",
    revnumber: "revision",
    description: "description",
    keywords: "tags",
    status: "status",
  },
};

// Asciidoctor surfaces every option we pass plus its own internals via
// getAttributes(). None of these should reach the metadata card — they're
// runtime configuration, not author metadata.
const ASCIIDOC_INTERNAL_ATTRS = new Set([
  // Asset-directory defaults injected by Asciidoctor — runtime config, not
  // author metadata. (`:title:` and `:doctitle:` are filtered upstream by the
  // asciidoc renderer because the title is surfaced via `getDocumentTitle()`.)
  "stylesdir",
  "stylesheet-name",
  "safe",
  "safe-mode-name",
  "safe-mode-level",
  "safe-mode-unsafe",
  "safe-mode-safe",
  "safe-mode-server",
  "safe-mode-secure",
  "showtitle",
  "relfilesuffix",
  "doctitle",
  "doctype",
  "doctype-article",
  "doctype-book",
  "doctype-manpage",
  "doctype-inline",
  "backend",
  "backend-html5",
  "basebackend",
  "basebackend-html",
  "basebackend-html5",
  "filetype",
  "filetype-html",
  "htmlsyntax",
  "outfilesuffix",
  "stylesheet",
  "linkcss",
  "copycss",
  "iconsdir",
  "imagesdir",
  "max-include-depth",
  "embedded",
  "notitle",
  "attribute-missing",
  "attribute-undefined",
  "appendix-caption",
  "appendix-refsig",
  "caution-caption",
  "important-caption",
  "note-caption",
  "tip-caption",
  "warning-caption",
  "example-caption",
  "figure-caption",
  "table-caption",
  "toc-title",
  "toc-placement",
  "section-refsig",
  "chapter-refsig",
  "part-refsig",
  "untitled-label",
  "version-label",
  "last-update-label",
  "manname-title",
  "table-stripes",
  "prewrap",
  "linkattrs",
  "compat-mode",
  "asciidoc-version",
  "asciidoctor-version",
  "asciidoctor",
  "user-home",
  "localdate",
  "localtime",
  "localyear",
  "localdatetime",
  "docdate",
  "doctime",
  "docyear",
  "docdatetime",
  "max-attribute-value-size",
  "fragment",
]);

const AUTHOR_LINE_PATTERN = /^([^<]+?)(?:\s*<([^>]+)>)?\s*$/;

// Public for the asciidoc renderer to surface multi-author lists from
// getAuthors() without re-implementing the email-extraction parsing.
export function parseAuthorEntry(entry: string): DocumentMetadataAuthor | undefined {
  const trimmed = entry.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(AUTHOR_LINE_PATTERN);
  if (!match) {
    return { name: trimmed };
  }
  const name = match[1]?.trim() ?? trimmed;
  const email = match[2]?.trim();
  return email ? { name, email } : { name };
}

function parseAuthorList(raw: RawMetadataValue): DocumentMetadataAuthor[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "string") {
    // YAML/TOML scalars allow comma-separated authors as a single value; treat
    // exactly as AsciiDoc's author line semantics for consistency.
    const parts = raw.split(/[;,]/).map(part => part.trim()).filter(Boolean);
    const authors = parts.map(parseAuthorEntry).filter((author): author is DocumentMetadataAuthor => Boolean(author));
    return authors.length > 0 ? authors : undefined;
  }
  if (Array.isArray(raw)) {
    const authors: DocumentMetadataAuthor[] = [];
    for (const entry of raw) {
      if (typeof entry === "string") {
        const parsed = parseAuthorEntry(entry);
        if (parsed) {
          authors.push(parsed);
        }
      } else if (entry && typeof entry === "object" && "name" in entry && typeof entry.name === "string") {
        authors.push({ name: entry.name, email: typeof entry.email === "string" ? entry.email : undefined });
      }
    }
    return authors.length > 0 ? authors : undefined;
  }
  return undefined;
}

function parseTagList(raw: RawMetadataValue): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "string") {
    const parts = raw.split(",").map(part => part.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(raw)) {
    const tags = raw
      .filter((item): item is string => typeof item === "string")
      .map(item => item.trim())
      .filter(Boolean);
    return tags.length > 0 ? tags : undefined;
  }
  return undefined;
}

function rawToString(raw: RawMetadataValue): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (Array.isArray(raw)) {
    const joined = raw
      .filter((item): item is string => typeof item === "string")
      .map(item => item.trim())
      .filter(Boolean)
      .join(", ");
    return joined === "" ? undefined : joined;
  }
  return undefined;
}

export function normalizeMetadata(
  raw: Record<string, RawMetadataValue>,
  format: SourceFormat,
): DocumentMetadata | undefined {
  const result: DocumentMetadata = {};
  const extras: Record<string, string> = {};
  const curatedKeyMap = CURATED_KEYS_BY_FORMAT[format];

  for (const [rawKey, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    const lowerKey = rawKey.toLowerCase();

    if (format === "asciidoc" && ASCIIDOC_INTERNAL_ATTRS.has(lowerKey)) {
      continue;
    }

    const curated = curatedKeyMap[lowerKey];
    if (curated === "authors") {
      const authors = parseAuthorList(value);
      if (authors) {
        result.authors = (result.authors ?? []).concat(authors);
      }
      continue;
    }
    if (curated === "tags") {
      const tags = parseTagList(value);
      if (tags) {
        result.tags = (result.tags ?? []).concat(tags);
      }
      continue;
    }
    if (curated && curated !== "extras") {
      const stringified = rawToString(value);
      if (stringified !== undefined) {
        // First non-empty wins for scalars: yaml `version` and yaml `revision`
        // both map to `revision`; the first one declared takes precedence.
        if (result[curated] === undefined) {
          (result as Record<string, unknown>)[curated] = stringified;
        }
      }
      continue;
    }

    const stringified = rawToString(value);
    if (stringified !== undefined) {
      extras[rawKey] = stringified;
    }
  }

  if (Object.keys(extras).length > 0) {
    result.extras = extras;
  }

  return hasAnyMetadata(result) ? result : undefined;
}

export function hasAnyMetadata(metadata: DocumentMetadata): boolean {
  if (metadata.title || metadata.date || metadata.revision || metadata.description || metadata.status) {
    return true;
  }
  if (metadata.authors && metadata.authors.length > 0) {
    return true;
  }
  if (metadata.tags && metadata.tags.length > 0) {
    return true;
  }
  if (metadata.extras && Object.keys(metadata.extras).length > 0) {
    return true;
  }
  return false;
}

// Parse YAML frontmatter using the canonical `yaml` package. Nested maps are
// flattened into dot-notation keys (`metadata.author`, `metadata.version`)
// because the metadata card is a flat key/value surface — preserving the
// nested shape would require either nested rendering or a stringified
// summary, both of which surface less information than the flattened keys do.
//
// Returning `undefined` signals an unparseable block. Returning `{}` signals
// "parsed cleanly, no recognized keys" — the normalize layer then folds that
// into a no-card outcome.
export function parseSimpleYaml(source: string): Record<string, RawMetadataValue> | undefined {
  let parsed: unknown;
  try {
    parsed = yamlParse(source);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
    // A plain scalar isn't a recognizable metadata document.
    return undefined;
  }
  if (Array.isArray(parsed)) {
    return undefined;
  }
  if (typeof parsed !== "object") {
    return undefined;
  }
  const flat: Record<string, RawMetadataValue> = {};
  flattenInto(flat, parsed as Record<string, unknown>, "");
  return flat;
}

function flattenInto(
  out: Record<string, RawMetadataValue>,
  source: Record<string, unknown>,
  prefix: string,
): void {
  for (const [key, value] of Object.entries(source)) {
    const flatKey = prefix === "" ? key : `${prefix}.${key}`;
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        continue;
      }
      // Arrays of scalars become string[] verbatim. Arrays of objects with a
      // `name` field become DocumentMetadataAuthor[]-shaped lists; anything
      // else degrades to a comma-joined string so the value still surfaces.
      if (value.every(item => typeof item === "string")) {
        out[flatKey] = value as string[];
        continue;
      }
      if (value.every(item => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
        out[flatKey] = value.map(item => String(item));
        continue;
      }
      if (value.every(item => item && typeof item === "object" && !Array.isArray(item) && "name" in (item as object))) {
        out[flatKey] = (value as Array<{ name: unknown; email?: unknown }>).map(item => ({
          name: String(item.name),
          ...(typeof item.email === "string" ? { email: item.email } : {}),
        }));
        continue;
      }
      out[flatKey] = value
        .map(item => (typeof item === "string" ? item : JSON.stringify(item)))
        .join(", ");
      continue;
    }
    if (typeof value === "object") {
      flattenInto(out, value as Record<string, unknown>, flatKey);
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      out[flatKey] = String(value);
      continue;
    }
    if (typeof value === "string") {
      out[flatKey] = value;
    }
  }
}

function stripYamlScalar(value: string): string | undefined {
  if (value.length === 0) {
    return "";
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    if (value.length < 2) {
      return undefined;
    }
    const body = value.slice(1, -1);
    return first === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : body;
  }
  // Reject braces — flow maps/anchors are out of scope.
  if (first === "{" || first === "&" || first === "*" || first === "|" || first === ">") {
    return undefined;
  }
  return value;
}

function splitFlowArray(inner: string): string[] | undefined {
  if (inner.trim() === "") {
    return [];
  }
  const items: string[] = [];
  let buffer = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"') {
        buffer += inner[i + 1] ?? "";
        i += 1;
        continue;
      }
      buffer += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === ",") {
      const stripped = stripYamlScalar(buffer.trim());
      if (stripped === undefined) {
        return undefined;
      }
      items.push(stripped);
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  const last = stripYamlScalar(buffer.trim());
  if (last === undefined) {
    return undefined;
  }
  if (last !== "" || buffer.trim().length > 0) {
    items.push(last);
  }
  return items;
}

// Same posture as the YAML parser: a deliberately-limited subset for
// `key = value` and `key = [a, b]` top-level pairs. `[table]` headers and
// nested keys are rejected, falling back to "no metadata".
export function parseSimpleToml(source: string): Record<string, RawMetadataValue> | undefined {
  const lines = source.split(/\r?\n/);
  const result: Record<string, RawMetadataValue> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      // Tables and arrays-of-tables are out of scope.
      return undefined;
    }
    const eqIndex = findUnquotedEquals(line);
    if (eqIndex === -1) {
      return undefined;
    }
    const key = line.slice(0, eqIndex).trim();
    const after = line.slice(eqIndex + 1).trim();
    if (!key || key.includes(".")) {
      return undefined;
    }

    if (after.startsWith("[")) {
      if (!after.endsWith("]")) {
        return undefined;
      }
      const items = splitFlowArray(after.slice(1, -1));
      if (items === undefined) {
        return undefined;
      }
      // TOML strings inside arrays are required to be quoted; the splitter
      // strips one layer of quotes, so unquoted bare words land here as bare
      // strings. We accept them — they're harmless metadata values.
      result[key] = items;
      continue;
    }

    const scalar = stripTomlScalar(after);
    if (scalar === undefined) {
      return undefined;
    }
    result[key] = scalar;
  }

  return result;
}

function stripTomlScalar(value: string): string | undefined {
  if (value.length === 0) {
    return undefined;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    if (value.length < 2) {
      return undefined;
    }
    const body = value.slice(1, -1);
    return first === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : body;
  }
  // Bare booleans and numbers stringify cleanly. Reject obvious garbage like
  // unclosed brackets.
  if (value.includes('"') || value.includes("'")) {
    return undefined;
  }
  return value;
}

function findUnquotedEquals(line: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "=") {
      return i;
    }
  }
  return -1;
}

// HTML-escape every reachable string in a DocumentMetadata before it is
// serialized into the document-render payload, matching the body-HTML
// sanitize posture: a metadata value containing `<script>` reaches the DOM
// as escaped text, never as live markup.
export function sanitizeMetadata(metadata: DocumentMetadata | undefined): DocumentMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const out: DocumentMetadata = {};
  if (metadata.title) {
    out.title = escapeHtml(metadata.title);
  }
  if (metadata.authors && metadata.authors.length > 0) {
    out.authors = metadata.authors.map(author => ({
      name: escapeHtml(author.name),
      ...(author.email ? { email: escapeHtml(author.email) } : {}),
    }));
  }
  if (metadata.date) {
    out.date = escapeHtml(metadata.date);
  }
  if (metadata.revision) {
    out.revision = escapeHtml(metadata.revision);
  }
  if (metadata.description) {
    out.description = escapeHtml(metadata.description);
  }
  if (metadata.tags && metadata.tags.length > 0) {
    out.tags = metadata.tags.map(escapeHtml);
  }
  if (metadata.status) {
    out.status = escapeHtml(metadata.status);
  }
  if (metadata.extras) {
    const escapedExtras: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata.extras)) {
      escapedExtras[escapeHtml(key)] = escapeHtml(value);
    }
    if (Object.keys(escapedExtras).length > 0) {
      out.extras = escapedExtras;
    }
  }
  return hasAnyMetadata(out) ? out : undefined;
}
