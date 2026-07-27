// The Search pane: ⇧⌘F, content search across the watched roots.
//
// Unlike ⌘F, this one is global — it does not consult the active surface,
// because the tree is not a surface the user can be "in". It consumes the
// NDJSON stream from `/api/search` and renders results as they arrive, so a
// repository-sized sweep fills the pane instead of hanging it.

import { appState } from "../shell/state";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import type { SearchEvent, SearchFileResult } from "../server/search";
import {
  countMatches,
  describeSearchSummary,
  displayLine,
  mergeResult,
  shouldDispatch,
} from "./search-model";
import { renderSidebar } from "./shell";
import { persistPaneState } from "./panes";
import { openSearchResult } from "./search-open";

const queryInputMaybe = document.querySelector<HTMLInputElement>("#search-query");
const summaryElementMaybe = document.querySelector<HTMLElement>("#search-summary");
const scopeElementMaybe = document.querySelector<HTMLElement>("#search-scope");
const noticeElementMaybe = document.querySelector<HTMLElement>("#search-notice");
const resultsElementMaybe = document.querySelector<HTMLElement>("#search-results");
const caseToggleMaybe = document.querySelector<HTMLButtonElement>("#search-case");
const wordToggleMaybe = document.querySelector<HTMLButtonElement>("#search-word");
const regexToggleMaybe = document.querySelector<HTMLButtonElement>("#search-regex");

if (
  !queryInputMaybe ||
  !summaryElementMaybe ||
  !scopeElementMaybe ||
  !noticeElementMaybe ||
  !resultsElementMaybe ||
  !caseToggleMaybe ||
  !wordToggleMaybe ||
  !regexToggleMaybe
) {
  throw new Error("uatu UI failed to initialize (sidebar/search-pane)");
}

const queryInput: HTMLInputElement = queryInputMaybe;
const summaryElement: HTMLElement = summaryElementMaybe;
const scopeElement: HTMLElement = scopeElementMaybe;
const noticeElement: HTMLElement = noticeElementMaybe;
const resultsElement: HTMLElement = resultsElementMaybe;
const caseToggle: HTMLButtonElement = caseToggleMaybe;
const wordToggle: HTMLButtonElement = wordToggleMaybe;
const regexToggle: HTMLButtonElement = regexToggleMaybe;

// Longer than the in-document find's debounce: this one crosses the network
// and reads files, so the cost of a wasted keystroke is much higher.
const SEARCH_DEBOUNCE_MS = 250;

type Toggles = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };

let toggles: Toggles = { caseSensitive: false, wholeWord: false, regex: false };
let results: SearchFileResult[] = [];
let running = false;
let truncated = false;
let expensive: string[] = [];
let abandoned = false;
let patternError: string | null = null;
let stale = false;
let searchAllRoots = false;
let debounceHandle: number | null = null;
// Abandons an in-flight sweep when the query changes under it — without this a
// slow search would keep streaming rows for a query the user has moved on from.
let inFlight: AbortController | null = null;

// Whether `controller` still owns the pane. Every write to shared state is
// gated on this — a superseded sweep is not merely uninteresting, it is
// actively harmful, because its rows would be attributed to the new query.
function isCurrent(controller: AbortController): boolean {
  return inFlight === controller && !controller.signal.aborted;
}

function buildUrl(query: string): string {
  const params = new URLSearchParams({ q: query });
  if (toggles.caseSensitive) params.set("case", "1");
  if (toggles.wholeWord) params.set("word", "1");
  if (toggles.regex) params.set("regex", "1");
  if (searchAllRoots) params.set("allRoots", "1");
  return `/api/search?${params.toString()}`;
}

async function runSearch(): Promise<void> {
  const query = queryInput.value;
  inFlight?.abort();
  results = [];
  truncated = false;
  expensive = [];
  abandoned = false;
  patternError = null;
  stale = false;

  if (!shouldDispatch(query)) {
    running = false;
    render();
    return;
  }

  const controller = new AbortController();
  inFlight = controller;
  running = true;
  render();

  let response: Response;
  try {
    response = await fetch(buildUrl(query), { signal: controller.signal });
  } catch {
    // Aborted or offline; a newer query owns the pane now.
    return;
  }

  if (!isCurrent(controller)) {
    return;
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    patternError = body?.error ?? "search failed";
    running = false;
    render();
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    running = false;
    render();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // A read that resolved just before this sweep was superseded must not
      // append its rows into the new query's results — `consume` writes to
      // shared state, so the guard has to come before it, not after.
      if (!isCurrent(controller)) return;
      buffer += decoder.decode(value, { stream: true });
      // NDJSON: everything before the last newline is a complete record.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) {
          consume(JSON.parse(line) as SearchEvent);
        }
      }
      render();
    }
  } catch {
    // Stream died or was aborted; keep whatever arrived.
  }

  if (!isCurrent(controller)) return;
  running = false;
  render();
}

function consume(event: SearchEvent): void {
  switch (event.kind) {
    case "file":
      results = mergeResult(results, event.result);
      return;
    case "expensive":
      expensive.push(event.relativePath);
      return;
    case "done":
      truncated = event.truncated;
      abandoned = event.abandoned === true;
      return;
  }
}

function scheduleSearch(): void {
  if (debounceHandle !== null) {
    window.clearTimeout(debounceHandle);
  }
  debounceHandle = window.setTimeout(() => {
    debounceHandle = null;
    void runSearch();
  }, SEARCH_DEBOUNCE_MS);
}

function renderScope(): void {
  const scoped = appState.scope.kind === "file";
  if (!scoped && !searchAllRoots) {
    scopeElement.hidden = true;
    return;
  }
  scopeElement.hidden = false;
  if (searchAllRoots) {
    scopeElement.innerHTML =
      `Searching all roots. <button type="button" class="search-scope-action" data-search-scope="respect">Use current scope</button>`;
    return;
  }
  // A scope narrowed to one file makes search look broken; name it and offer
  // the way out rather than silently returning almost nothing.
  scopeElement.innerHTML =
    `Scoped to one file. <button type="button" class="search-scope-action" data-search-scope="all">Search all roots</button>`;
}

function renderNotice(): void {
  const notes: string[] = [];
  if (truncated) {
    // A silently capped list reads as "that's everywhere it appears", which is
    // exactly the wrong conclusion for a reviewer to draw.
    notes.push("Showing the first results — refine the query to see the rest.");
  }
  if (abandoned) {
    // Stopping early and saying nothing would read as "that is all there is".
    notes.push("Search stopped early — it was taking too long. Narrow the query.");
  }
  if (expensive.length > 0) {
    notes.push(
      `Pattern too expensive for ${expensive.length} file${expensive.length === 1 ? "" : "s"}.`,
    );
  }
  if (stale) {
    notes.push(`Files changed since this search. <button type="button" class="search-scope-action" data-search-rerun>Run again</button>`);
  }
  noticeElement.hidden = notes.length === 0;
  noticeElement.innerHTML = notes.join(" ");
}

function render(): void {
  const summary = describeSearchSummary({
    query: queryInput.value,
    files: results.length,
    matches: countMatches(results),
    running,
    truncated,
    error: patternError,
  });
  summaryElement.textContent = summary.label;
  summaryElement.dataset.state = summary.state;
  caseToggle.setAttribute("aria-pressed", String(toggles.caseSensitive));
  wordToggle.setAttribute("aria-pressed", String(toggles.wholeWord));
  regexToggle.setAttribute("aria-pressed", String(toggles.regex));
  renderScope();
  renderNotice();
  renderResults();
}

function renderResults(): void {
  if (results.length === 0) {
    resultsElement.replaceChildren();
    return;
  }
  const html = results
    .map(result => {
      // Which occurrence of the same text each row is, within this document.
      // Several rows can share a matched string, and the reveal needs to know
      // which one to land on — otherwise every row reveals the first.
      const seen = new Map<string, number>();
      const rows = result.matches
        .map(match => {
          const matchText = match.text.slice(match.start, match.end);
          const occurrence = seen.get(matchText) ?? 0;
          seen.set(matchText, occurrence + 1);
          const line = displayLine(match.text, match.start, match.end);
          const before = escapeHtml(line.text.slice(0, line.start));
          const hit = escapeHtml(line.text.slice(line.start, line.end));
          const after = escapeHtml(line.text.slice(line.end));
          const lead = line.truncatedStart ? "…" : "";
          const tail = line.truncatedEnd ? "…" : "";
          return (
            `<button class="search-hit" type="button" role="treeitem"` +
            ` data-document-id="${escapeHtml(result.documentId)}"` +
            ` data-line="${match.line}" data-start="${match.start}" data-end="${match.end}"` +
            // The literal slice that matched — for a regex this differs per
            // hit, so it cannot be re-derived from the query alone — plus which
            // occurrence of it this row is within the document.
            ` data-match="${escapeHtmlAttribute(matchText)}" data-occurrence="${occurrence}">` +
            `<span class="search-hit-line">${match.line}</span>` +
            `<span class="search-hit-text">${lead}${before}<mark>${hit}</mark>${after}${tail}</span>` +
            `</button>`
          );
        })
        .join("");
      return (
        `<div class="search-file">` +
        `<div class="search-file-path" title="${escapeHtml(result.relativePath)}">` +
        `${escapeHtml(result.relativePath)}` +
        `<span class="search-file-count">${result.matches.length}</span>` +
        `</div>${rows}</div>`
      );
    })
    .join("");
  resultsElement.innerHTML = html;
}

function toggleOption(key: keyof Toggles): void {
  toggles = { ...toggles, [key]: !toggles[key] };
  void runSearch();
  queryInput.focus();
}

// Open the pane if hidden or collapsed and put the cursor in the query box.
// Other panes' persisted state is left alone — revealing search must not
// rearrange the sidebar the user set up.
export function openSearchPane(seed?: string): void {
  const pane = appState.panes.search;
  if (!pane.visible || pane.collapsed) {
    pane.visible = true;
    pane.collapsed = false;
    persistPaneState();
    renderSidebar();
  }
  if (seed !== undefined && seed.length > 0) {
    queryInput.value = seed;
    void runSearch();
  }
  queryInput.focus();
  queryInput.select();
}

// A watched file changed. Results captured line numbers that may no longer
// hold, so say so rather than re-running — in a watched repository that would
// be a query storm, and results would jump under the reader's cursor.
// The scope line is derived from `appState.scope`, which arrives asynchronously
// from `/api/state` and can change mid-session. Without this the pane renders
// its scope once at boot — before the snapshot lands — and never corrects
// itself until the next query.
export function syncSearchScope(): void {
  renderScope();
}

export function markSearchResultsStale(): void {
  if (results.length === 0 || stale) {
    return;
  }
  stale = true;
  renderNotice();
}

// Boot-time wiring. Called once by app.ts.
export function initSearchPane(): void {
  queryInput.addEventListener("input", scheduleSearch);
  queryInput.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      queryInput.blur();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      resultsElement.querySelector<HTMLButtonElement>(".search-hit")?.focus();
    }
  });
  caseToggle.addEventListener("click", () => toggleOption("caseSensitive"));
  wordToggle.addEventListener("click", () => toggleOption("wholeWord"));
  regexToggle.addEventListener("click", () => toggleOption("regex"));

  scopeElement.addEventListener("click", event => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-search-scope]");
    if (!target) return;
    searchAllRoots = target.dataset.searchScope === "all";
    void runSearch();
  });

  noticeElement.addEventListener("click", event => {
    if ((event.target as HTMLElement | null)?.closest("[data-search-rerun]")) {
      void runSearch();
    }
  });

  resultsElement.addEventListener("click", event => {
    const hit = (event.target as HTMLElement | null)?.closest<HTMLElement>(".search-hit");
    if (!hit) return;
    activate(hit);
  });

  // Arrow keys walk the flat list of hits; Enter opens the focused one.
  resultsElement.addEventListener("keydown", event => {
    const hits = [...resultsElement.querySelectorAll<HTMLButtonElement>(".search-hit")];
    const index = hits.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? index + 1 : index - 1;
      if (next < 0) {
        queryInput.focus();
        return;
      }
      hits[Math.min(next, hits.length - 1)]?.focus();
      return;
    }
    if (event.key === "Enter" && index >= 0) {
      event.preventDefault();
      activate(hits[index]!);
    }
  });

  render();
}

function activate(hit: HTMLElement): void {
  const documentId = hit.dataset.documentId;
  const line = Number(hit.dataset.line);
  const start = Number(hit.dataset.start);
  const end = Number(hit.dataset.end);
  if (!documentId || !Number.isFinite(line)) {
    return;
  }
  void openSearchResult(
    { documentId, line, start, end, query: queryInput.value },
    {
      matchText: hit.dataset.match ?? queryInput.value,
      occurrence: Number(hit.dataset.occurrence ?? 0),
      fromAllRoots: searchAllRoots,
    },
  );
}
