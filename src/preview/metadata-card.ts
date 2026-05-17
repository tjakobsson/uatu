// Document metadata card — the collapsible "Metadata · N fields" disclosure
// that appears above markdown / asciidoc bodies. Extracted from `app.ts` so
// rendering of the card and its open/closed preference live together.

type RenderedDocumentAuthor = { name: string; email?: string };

type RenderedDocumentMetadata = {
  title?: string;
  authors?: RenderedDocumentAuthor[];
  date?: string;
  revision?: string;
  description?: string;
  tags?: string[];
  status?: string;
  extras?: Record<string, string>;
};

// Persists the user's last open/closed choice for the document metadata card
// across documents and reloads. The expectation is "if I opened it once, I
// want to see it on every other doc too" — and the converse for closing.
export const METADATA_CARD_OPEN_KEY = "uatu:metadata-card-open";

export function readMetadataCardOpenPreference(): boolean {
  try {
    return window.localStorage.getItem(METADATA_CARD_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeMetadataCardOpenPreference(open: boolean): void {
  try {
    window.localStorage.setItem(METADATA_CARD_OPEN_KEY, open ? "1" : "0");
  } catch {
    // best-effort persistence; localStorage may be disabled
  }
}

export function attachMetadataCardToggleListener(container: HTMLElement): void {
  const card = container.querySelector<HTMLDetailsElement>(".metadata-card");
  if (!card) {
    return;
  }
  card.addEventListener("toggle", () => {
    writeMetadataCardOpenPreference(card.open);
  });
}

export function renderMetadataCard(metadata: RenderedDocumentMetadata | undefined): string {
  if (!metadata) {
    return "";
  }
  // The server has already passed every reachable string through escapeHtml,
  // so values are safe to drop into innerHTML directly. The structural shell
  // here uses fixed tag names — no author-controlled HTML reaches the DOM.
  const rows: string[] = [];

  if (metadata.title) {
    rows.push(curatedRow("Title", metadata.title));
  }
  if (metadata.authors && metadata.authors.length > 0) {
    const formatted = metadata.authors
      .map(author =>
        author.email
          ? `${author.name} <span class="metadata-card-email">&lt;${author.email}&gt;</span>`
          : author.name,
      )
      .join(", ");
    rows.push(curatedRow(metadata.authors.length === 1 ? "Author" : "Authors", formatted));
  }
  if (metadata.date) {
    rows.push(curatedRow("Date", metadata.date));
  }
  if (metadata.revision) {
    rows.push(curatedRow("Revision", metadata.revision));
  }
  if (metadata.description) {
    rows.push(curatedRow("Description", metadata.description));
  }
  if (metadata.tags && metadata.tags.length > 0) {
    const chips = metadata.tags
      .map(tag => `<span class="metadata-card-tag">${tag}</span>`)
      .join("");
    rows.push(`<div class="metadata-card-row"><span class="metadata-card-label">Tags</span><span class="metadata-card-value metadata-card-tags">${chips}</span></div>`);
  }
  if (metadata.status) {
    rows.push(curatedRow("Status", metadata.status));
  }
  if (metadata.extras) {
    for (const [key, value] of Object.entries(metadata.extras)) {
      rows.push(`<div class="metadata-card-row metadata-card-row-extra"><span class="metadata-card-label">${key}</span><span class="metadata-card-value">${value}</span></div>`);
    }
  }

  if (rows.length === 0) {
    return "";
  }

  // Collapsed-by-default disclosure with a deliberately spare summary —
  // "METADATA · N fields". Earlier iterations also surfaced a teaser of
  // the most-distinguishing fields, but it duplicated the body's <h1> and
  // added visual noise without telling the reader much they couldn't get
  // by simply opening the disclosure. The body shows the rows in a tight
  // key/value layout. Using <details>/<summary> means no JS for toggle
  // behaviour and the disclosure remains keyboard-accessible by default.
  const fieldCount = rows.length;
  const countLabel = fieldCount === 1 ? "1 field" : `${fieldCount} fields`;
  const openAttr = readMetadataCardOpenPreference() ? " open" : "";
  return `<details class="metadata-card" aria-label="Document metadata"${openAttr}>` +
    `<summary class="metadata-card-summary">` +
    `<span class="metadata-card-summary-label">Metadata</span>` +
    `<span class="metadata-card-summary-count">${countLabel}</span>` +
    `</summary>` +
    `<div class="metadata-card-body">${rows.join("")}</div>` +
    `</details>`;
}

export function curatedRow(label: string, value: string): string {
  return `<div class="metadata-card-row"><span class="metadata-card-label">${label}</span><span class="metadata-card-value">${value}</span></div>`;
}
