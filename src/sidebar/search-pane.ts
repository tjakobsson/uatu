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
import { renderSidebar, setSidebarCollapsed } from "./shell";
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
let oversized: string[] = [];
let abandoned = false;
let patternError: string | null = null;
let requestFailed = false;
// The server ends every sweep with a `done` event. A stream that stops
// without one was cut off — the server went away, the connection dropped —
// and the rows on screen are however far it got, not the whole corpus.
// Rendering them as a complete result set would be a quiet lie.
let sawDone = false;
let incomplete = false;
let stale = false;
let searchAllRoots = false;
// Whether the rows currently on screen came from a widened sweep. Captured
// when the request is dispatched, because `searchAllRoots` is the *toggle* and
// can change while old rows are still visible — and both staleness checks and
// row activation must describe the sweep that produced the rows, not the
// toggle's present position.
let resultsFromAllRoots = false;
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
  oversized = [];
  abandoned = false;
  patternError = null;
  requestFailed = false;
  sawDone = false;
  incomplete = false;
  stale = false;
  resultsFromAllRoots = searchAllRoots;

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
    // An abort means a newer query owns the pane and will render for itself.
    // Anything else is a real failure — the local server going away, most
    // likely — and leaving `running` set would show "Searching…" for ever with
    // no error and no way to retry.
    if (isCurrent(controller)) {
      running = false;
      requestFailed = true;
      render();
    }
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
    // Stream died or was aborted; keep whatever arrived. Whether that is a
    // problem is decided below — an abort belongs to a superseding query and
    // is not ours to report, while a still-current stream failure is.
  }

  if (!isCurrent(controller)) return;
  incomplete = !sawDone;
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
    case "oversized":
      oversized.push(event.relativePath);
      return;
    case "done":
      truncated = event.truncated;
      abandoned = event.abandoned === true;
      sawDone = true;
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
  if (incomplete) {
    // The stream ended without the server's `done` — cut off, not finished.
    notes.push(`Search was interrupted — results may be incomplete. <button type="button" class="search-scope-action" data-search-rerun>Run again</button>`);
  }
  if (expensive.length > 0) {
    notes.push(
      `Pattern too expensive for ${expensive.length} file${expensive.length === 1 ? "" : "s"}.`,
    );
  }
  if (oversized.length > 0) {
    notes.push(
      `Skipped ${oversized.length} file${oversized.length === 1 ? "" : "s"} too large to search.`,
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
    failed: requestFailed,
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
      const rows = result.matches
        .map(match => {
          const matchText = match.text.slice(match.start, match.end);
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
            // The ordinal counts *literal* occurrences before this one, which
            // is what the reveal scans. Counting matched rows instead would be
            // wrong wherever a toggle excludes a literal occurrence — a
            // whole-word `cat` in `catapult cat` is match one but literal two.
            ` data-match="${escapeHtmlAttribute(matchText)}" data-occurrence="${match.ordinal}"` +
            ` data-total="${match.literalTotal}">` +
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
  // The whole sidebar first: collapsed, it is `display: none`, and expanding
  // only the pane would focus an invisible input — the shortcut would look
  // like it did nothing.
  setSidebarCollapsed(false);
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

export function markSearchResultsStale(changedId: string): void {
  if (results.length === 0 || stale) {
    return;
  }
  // Only a change to a document that actually appears in the results can
  // invalidate them. Without this filter, a repository with generated or
  // frequently edited files keeps the warning permanently lit for results
  // those files never touched.
  if (!results.some(result => result.documentId === changedId)) {
    return;
  }
  stale = true;
  renderNotice();
}

// A file with visible results was removed from the corpus.
//
// Deletion is not a content change: the watcher broadcasts `changedId: null`
// because there is no document to point at, so the change-driven path above
// never fires. Rows for a deleted file would otherwise sit there looking
// current, and activating one navigates to a document that no longer exists.
export function noteSearchCorpusChange(): void {
  if (results.length === 0 || stale) {
    return;
  }
  // A widened sweep legitimately returns documents outside the scoped
  // `appState.roots`, so membership there says nothing about deletion — every
  // out-of-scope row would read as "deleted" on the next snapshot, however
  // unrelated its cause. The unscoped corpus never reaches the client, so for
  // these results deletion is undetectable; leave them as they are.
  if (resultsFromAllRoots && appState.scope.kind === "file") {
    return;
  }
  const present = new Set<string>();
  for (const root of appState.roots) {
    for (const document of root.docs) {
      present.add(document.id);
    }
  }
  if (results.some(result => !present.has(result.documentId))) {
    stale = true;
    renderNotice();
  }
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
      sourceTotal: Number.isFinite(Number(hit.dataset.total)) ? Number(hit.dataset.total) : undefined,
      fromAllRoots: resultsFromAllRoots,
    },
  );
}
