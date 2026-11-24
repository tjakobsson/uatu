// The pull request file view (`?pr=<n>&path=<path>[&rev=base]`): one file of
// a pull request, at its head (or its base), in the same Rendered / Source /
// Diff chooser documents use (`appState.viewMode`, so the mode carries over
// from file to file). Rendered and Source come from the session's file route
// (src/github/http.ts), which renders the head blob with the document
// pipeline; this view mounts that payload like a document (mount.ts, in its
// pull request context): metadata card, Mermaid, outline, Find, layouts.
// Relative images and links resolve against the pull request's blob route,
// because the preview's <base href> points there. Diff is Files changed for
// this one file (src/preview/diff-review.ts, `only`): its threads, the
// composer and the pending review. Comments are written in Diff only:
// Rendered and Source show a bar with the file's threads and "Show in Diff",
// and Source marks the lines that hold a thread (read-only; a current
// thread's line is a head line, so the marks are exact).
//
// pull-request-view.ts owns the navigation (the tab row's file crumb,
// history, ‹ n of m ›, Jump to file) and asks this module to show a target;
// the content goes into #preview itself (the Conversation / Files changed
// panels are set aside meanwhile), and the facts line and thread bar sit in
// `.pr-file-bar` above it.
//
// A head that isn't local yet answers 409: a consent card explains the
// explicit, narrow fetch (into a private ref; the checkout stays as it is)
// before anything is fetched. For the checked-out branch's own pull request
// the facts line compares the file with the checkout: "Same as your
// checkout" with Open in workspace, or how the checkout differs. The PR head
// stays on screen either way.

import { githubApi, GithubRequestError } from "../github/client";
import { pullRequestStore } from "../github/pull-request-store";
import { shortOid } from "../github/present";
import type { PullRequestDetail, PullRequestFileFacts, PullRequestFileRevision, PullRequestRevision } from "../shared/github-contract";
import { appUrl } from "../shared/app-url";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import type { ViewMode } from "../shared/types";
import { appState } from "../shell/state";
import { pushSelection, scrollToFragment } from "../shell/history";
import { previewScrollRoot } from "../shell/preview-scroll-root";
import { setPreviewMode, setSelectedId } from "../shell/selection";
import { setFollowEnabled, syncFollowToggle } from "../shell/follow";
import { findDocumentById } from "../shell/storage";
import { contextualAppUrl } from "../shell/watch-context";
import { renderSidebar } from "../sidebar/shell";
import { releaseMediaPreview } from "../media/preview";
import { applySourceWrap } from "./code-block";
import { mountFilesChanged, type FilesChangedView } from "./diff-review";
import { clearPreviewType, previewBaseElement, setPreviewType } from "./header";
import { mountLayoutToolbar } from "./layout";
import { closeMermaidViewer } from "./mermaid-viewer";
import { loadDocument, renderSinglePayload, renderSplitPayloads, type RenderedDocument } from "./mount";
import { refreshOutline } from "./outline";
import { observePreviewSvgImages, preparePreviewHtml } from "./svg-images";
import { hideViewToggle, syncViewToggle } from "./view-mode";
import { registerPreviewViewHost } from "./view-host";
import { effectiveRevision, effectiveViewMode, fileViewModes, formatBytes, kindOfPath, parseBlobLink } from "./pull-request-file-model";

export { kindOfPath } from "./pull-request-file-model";
export type FileTarget = { path: string; rev: PullRequestRevision };
type Payload = RenderedDocument & PullRequestFileFacts;
type Local = { state: "same"; documentId: string } | { state: "differs"; why: string; documentId: string } | { state: "missing" };

export type FileViewContext = {
  repositoryId: string;
  number: number;
  // Another file of this pull request (‹ ›, a relative link): a history entry.
  open: (target: FileTarget) => void;
};

const PULL_REQUEST_FILE_MOUNT = { kind: "pull-request-file" } as const;
const PAYLOAD_CACHE_LIMIT = 80;

const previewElement = document.querySelector<HTMLElement>("#preview")!;
const previewShell = document.querySelector<HTMLElement>(".preview-shell")!;

type State = {
  context: FileViewContext;
  target: FileTarget;
  detail: PullRequestDetail | null;
  generation: number;
  // What #preview shows now, and a node of it (gone once anything else
  // renders into the preview).
  shownKey: string | null;
  shownNode: Element | null;
  diff: FilesChangedView | null;
  // Renders under way (their content isn't in #preview yet).
  rendering: number;
  // The head commit the content was read at (a moved head says so).
  readAt: string | null;
  payload: Payload | null;
  local: Local | null;
  comparing: boolean;
  fragment: string | null;
  notice: string | null;
};

let state: State | null = null;
const payloads = new Map<string, Payload>();

// --- public -------------------------------------------------------------

export function showPullRequestFile(context: FileViewContext, target: FileTarget, detail: PullRequestDetail | null, options: { fragment?: string } = {}): void {
  const same = state && state.context.number === context.number && state.context.repositoryId === context.repositoryId
    && state.target.path === target.path && state.target.rev === target.rev;
  if (same && state && pullRequestFileShowing()) {
    state.context = context;
    if (detail) updatePullRequestFile(detail);
    if (options.fragment) scrollToFragment(options.fragment);
    return;
  }
  const switched = !same;
  const previous = state;
  state = {
    context,
    target,
    detail: detail ?? previous?.detail ?? null,
    generation: (previous?.generation ?? 0) + 1,
    shownKey: null,
    shownNode: null,
    diff: null,
    rendering: 0,
    readAt: null,
    payload: null,
    local: null,
    comparing: false,
    fragment: options.fragment ?? null,
    notice: null,
  };
  if (switched) previewScrollRoot().scrollTo({ top: 0 });
  void render(state);
}

// The detail moved on (a write, a refresh): the bar's threads, the diff, and
// whether the head moved past what is shown.
export function updatePullRequestFile(detail: PullRequestDetail): void {
  if (!state) return;
  const before = state.detail;
  state.detail = detail;
  if (state.readAt && detail.summary.headRefOid !== state.readAt) {
    state.notice = `#${detail.summary.number} has new commits since this file was read.`;
  }
  state.diff?.update(detail);
  renderBar(state);
  markThreadLines(state);
  // The branch's pull request and the workspace's documents may only now be
  // known (a reload straight into the file view).
  maybeCompare(state);
  // The first detail (the view opened before it) decides the modes.
  if (!before) void render(state);
}

export function pullRequestFileShowing(): boolean {
  return state !== null && appState.previewMode.kind === "pull-request"
    && (state.rendering > 0 || (state.shownNode !== null && state.shownNode.parentElement === previewElement));
}

// Leaving the file view (another tab, another preview): its chrome goes and
// its loads stop counting.
export function closePullRequestFile(): void {
  if (!state) return;
  state = null;
  removeChrome();
  previewBaseElement.href = new URL(appUrl("/"), window.location.origin).toString();
  hideViewToggle();
  clearPreviewType();
}

// Show in Diff (the threads bar) and Review the diff instead (the cards):
// Diff, at the thread.
export function showPullRequestFileThread(threadId: string | undefined): void {
  if (!state) return;
  const reveal = () => state?.diff?.reveal({ threadId, path: threadId ? undefined : state.target.path });
  if (appState.viewMode !== "diff") {
    pendingReveal = reveal;
    document.querySelector<HTMLButtonElement>("#view-diff")?.click();
  } else reveal();
}
let pendingReveal: (() => void) | null = null;

// A rendered document's relative link under the blob route: the target's
// file view at the same commit. anchors.ts hands these over.
document.addEventListener("uatu:pull-request-file-link", event => {
  const link = (event as CustomEvent<{ path: string; hash: string }>).detail;
  const parsed = parseBlobLink(link.path);
  if (!state || !parsed || parsed.number !== state.context.number) return;
  const path = parsed.path;
  const pr = state.detail?.summary;
  const rev: PullRequestRevision = pr && parsed.oid === pr.baseRefOid ? "base" : "head";
  const fragment = link.hash ? link.hash.slice(1) : undefined;
  if (path === state.target.path && rev === state.target.rev) {
    if (fragment) scrollToFragment(fragment);
    return;
  }
  state.context.open({ path, rev });
  if (state && fragment) state.fragment = fragment;
});

// The view chooser, the layout chooser and Wrap drive this view while it is
// the preview.
registerPreviewViewHost({
  active: pullRequestFileShowing,
  rerender: () => { if (state) void render(state); },
  wrapChanged: () => {
    if (!state) return;
    if (effectiveMode(state) === "diff") void render(state, { force: true });
    else applySourceWrap(previewElement, appState.wrap);
  },
});

// Anything else taking the preview (a document, a commit) takes the chrome
// down with it.
new MutationObserver(() => {
  if (document.documentElement.dataset.previewKind !== "pull-request") closePullRequestFile();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-preview-kind"] });

function changedFile(current: State) {
  return current.detail?.files.find(file => file.path === current.target.path) ?? null;
}

function effectiveRev(current: State): PullRequestRevision {
  return effectiveRevision(changedFile(current)?.status ?? null, current.target.rev);
}

function effectiveMode(current: State): ViewMode | null {
  return effectiveViewMode(fileViewModes(kindOfPath(current.target.path), changedFile(current) !== null), appState.viewMode);
}

// --- rendering ------------------------------------------------------------

async function render(current: State, options: { force?: boolean } = {}): Promise<void> {
  current.rendering += 1;
  try {
    await renderNow(current, options);
  } finally {
    current.rendering -= 1;
  }
}

async function renderNow(current: State, options: { force?: boolean }): Promise<void> {
  const generation = ++current.generation;
  const isCurrent = () => state === current && current.generation === generation && appState.previewMode.kind === "pull-request";
  const kind = kindOfPath(current.target.path);
  const changed = changedFile(current);
  const mode = effectiveMode(current);
  const rev = effectiveRev(current);
  const key = `${current.target.path}\n${rev}\n${mode}\n${appState.viewLayout}\n${current.detail ? "d" : "-"}`;
  releaseMediaPreview();
  closeMermaidViewer();
  ensureChrome(current);
  if (kind === "image") syncViewToggle(null);
  else syncViewToggle({ kind }, { diff: changed !== null });
  renderBar(current);
  if (!options.force && current.shownKey === key && current.shownNode?.parentElement === previewElement) return;

  if (mode === "diff") {
    if (!current.detail) { showMessage(current, "Reading the pull request…"); return; }
    current.payload = null;
    mountLayoutToolbar(false);
    refreshOutline(null);
    clearPreviewType();
    previewElement.classList.remove("is-split", "is-split-h", "is-split-v");
    previewElement.removeAttribute("data-auto-stack");
    const host = document.createElement("section");
    host.className = "pr-view pr-file-diff-view";
    host.dataset.prTab = "files";
    previewElement.replaceChildren(host);
    current.diff = mountFilesChanged(host, current.detail, current.context.repositoryId, { only: current.target.path });
    current.shownKey = key;
    current.shownNode = host;
    renderBar(current);
    const reveal = pendingReveal;
    pendingReveal = null;
    reveal?.();
    return;
  }
  current.diff = null;
  const target = { repository: current.context.repositoryId, number: current.context.number };
  const headOid = rev === "base" ? current.detail?.summary.baseRefOid : current.detail?.summary.headRefOid;
  const read = (view: "rendered" | "source") => readPayload(target, current.target.path, rev, view, headOid);
  const cachedFirst = headOid && mode ? payloads.get(payloadKey(target.number, rev, headOid, current.target.path, mode === "source" ? "source" : "rendered")) : undefined;
  if (!cachedFirst && current.shownKey?.split("\n")[0] !== current.target.path) showMessage(current, "Reading the file…");
  try {
    if (kind === "image") {
      // Images: the blob route serves them; the file route names the commit.
      const revision = await imageRevision(target, current.target.path, rev);
      if (!isCurrent()) return;
      mountImage(current, revision);
      current.shownKey = key;
      return;
    }
    const split = appState.viewLayout !== "single" && (kind === "markdown" || kind === "asciidoc");
    const [primary, other] = await Promise.all([
      read(mode === "source" ? "source" : "rendered"),
      split ? read(mode === "source" ? "rendered" : "source") : Promise.resolve(null),
    ]);
    if (!isCurrent()) return;
    current.payload = primary;
    current.readAt = rev === "head" ? primary.revision.oid : current.detail?.summary.headRefOid ?? null;
    setBase(primary.revision, current.target.path);
    setPreviewType(primary);
    previewElement.classList.remove("empty");
    if (split && other) {
      const source = primary.view === "source" ? primary : other;
      const rendered = primary.view === "source" ? other : primary;
      await renderSplitPayloads(source, rendered, isCurrent, PULL_REQUEST_FILE_MOUNT);
    } else {
      await renderSinglePayload(primary, isCurrent, PULL_REQUEST_FILE_MOUNT);
    }
    if (!isCurrent()) return;
    syncViewToggle({ kind: primary.kind }, { diff: changed !== null });
    current.shownKey = key;
    current.shownNode = previewElement.firstElementChild;
    markThreadLines(current);
    renderBar(current);
    if (current.fragment) {
      scrollToFragment(current.fragment);
      current.fragment = null;
    }
    current.local = null;
    maybeCompare(current);
  } catch (error) {
    if (!isCurrent()) return;
    showRefusal(current, error);
  }
}

const payloadKey = (number: number, rev: PullRequestRevision, oid: string, path: string, view: string) => `${number}\n${rev}\n${oid}\n${path}\n${view}`;

async function readPayload(target: { repository: string; number: number }, path: string, rev: PullRequestRevision, view: "rendered" | "source", oid: string | undefined): Promise<Payload> {
  const key = oid ? payloadKey(target.number, rev, oid, path, view) : null;
  const cached = key ? payloads.get(key) : undefined;
  if (cached) return cached;
  const payload = await githubApi.pullRequestFile(target, { path, rev, view });
  payloads.set(payloadKey(target.number, rev, payload.revision.oid, path, view), payload);
  if (payloads.size > PAYLOAD_CACHE_LIMIT) payloads.delete(payloads.keys().next().value!);
  return payload;
}

async function imageRevision(target: { repository: string; number: number }, path: string, rev: PullRequestRevision): Promise<PullRequestFileRevision> {
  try {
    return (await githubApi.pullRequestFile(target, { path, rev, view: "source" })).revision;
  } catch (error) {
    const revision = error instanceof GithubRequestError ? error.body?.revision as PullRequestFileRevision | undefined : undefined;
    if (revision && (error as GithubRequestError).state === "binary") return revision;
    throw error;
  }
}

// The preview's base: the file's directory under the commit's blob route.
function setBase(revision: PullRequestFileRevision, path: string): void {
  const slash = path.lastIndexOf("/");
  const directory = slash < 0 ? "" : path.slice(0, slash + 1);
  const encoded = directory.split("/").map(encodeURIComponent).join("/");
  previewBaseElement.href = new URL(appUrl(`/${revision.blobBase}${encoded}`), window.location.origin).toString();
}

function mountImage(current: State, revision: PullRequestFileRevision): void {
  setBase(revision, current.target.path);
  clearPreviewType();
  mountLayoutToolbar(false);
  refreshOutline(null);
  previewElement.classList.remove("empty", "is-split", "is-split-h", "is-split-v");
  const name = current.target.path.split("/").at(-1) ?? current.target.path;
  previewElement.replaceChildren(preparePreviewHtml(`<div class="image-preview"><img alt="${escapeHtmlAttribute(current.target.path)}" src="./${escapeHtmlAttribute(encodeURIComponent(name))}"></div>`));
  observePreviewSvgImages(previewElement);
  current.shownNode = previewElement.firstElementChild;
  renderBar(current);
}

function showMessage(current: State, text: string): void {
  mountLayoutToolbar(false);
  refreshOutline(null);
  previewElement.classList.remove("empty", "is-split", "is-split-h", "is-split-v");
  previewElement.innerHTML = `<p class="pr-muted pr-file-loading" role="status">${escapeHtml(text)}</p>`;
  current.shownKey = null;
  current.shownNode = previewElement.firstElementChild;
}

// Not fetched: the consent card. Binary, too large, missing, or GitHub
// unreachable: what happened and where else to read it.
function showRefusal(current: State, error: unknown): void {
  mountLayoutToolbar(false);
  refreshOutline(null);
  clearPreviewType();
  previewElement.classList.remove("empty", "is-split", "is-split-h", "is-split-v");
  const number = current.context.number;
  const state = error instanceof GithubRequestError ? error.state : null;
  const status = error instanceof GithubRequestError ? error.status : 0;
  const github = current.detail ? `${current.detail.summary.url}/files` : null;
  const githubLink = github ? `<a class="gh-button" href="${escapeHtmlAttribute(github)}" target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a>` : "";
  const diff = changedFile(current) ? `<button type="button" class="gh-button" data-pr-file-show-diff>Review the diff instead</button>` : "";
  if (state === "not-fetched") {
    previewElement.innerHTML = `<div class="gh-state-card pr-fetch-card" role="region" aria-labelledby="pr-fetch-title">
        <p class="gh-state-card-eyebrow">Pull request #${number}${current.detail?.mock ? ` · <span class="gh-mock-label">Mocked</span>` : ""}</p>
        <h3 id="pr-fetch-title">Get #${number}'s files</h3>
        <p>To show its files, uatu fetches the pull request's head from the repository's remote into a private ref, <code>refs/uatu/pull/${number}/head</code>, with this workspace's Git credentials. Your branch, your files and the index stay as they are.</p>
        <p class="pr-fetch-actions"><button type="button" class="gh-button gh-button-primary" data-pr-file-fetch>Fetch #${number}'s head</button>${diff}${githubLink}</p>
        <p class="pr-muted pr-fetch-status" data-pr-fetch-status role="status"></p>
      </div>`;
    const button = previewElement.querySelector<HTMLButtonElement>("[data-pr-file-fetch]")!;
    button.addEventListener("click", () => void fetchHead(current, button));
  } else {
    const title = state === "binary" ? "This file is binary"
      : state === "too-large" ? "This file is too large to show here"
      : status === 404 ? "This file isn't in the pull request"
      : "Couldn't read this file";
    const why = state === "binary" ? `${current.target.path} has no text to show.`
      : state === "too-large" ? `${current.target.path} is larger than uatu renders.`
      : errorText(error);
    previewElement.innerHTML = `<div class="gh-state-card${status >= 500 || status === 0 ? " gh-state-card-danger" : ""}">
        <p class="gh-state-card-eyebrow">Pull request #${number}</p>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(why)}</p>
        <p class="pr-fetch-actions">${status >= 500 || status === 0 ? `<button type="button" class="gh-button" data-pr-file-retry>Retry</button>` : ""}${diff}${githubLink}</p>
      </div>`;
    previewElement.querySelector("[data-pr-file-retry]")?.addEventListener("click", () => void render(current, { force: true }));
  }
  previewElement.querySelector("[data-pr-file-show-diff]")?.addEventListener("click", () => showPullRequestFileThread(undefined));
  current.shownKey = null;
  current.shownNode = previewElement.firstElementChild;
  current.payload = null;
  renderBar(current);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

// The explicit fetch (design D7, narrowed): only on the reviewer's click.
async function fetchHead(current: State, button: HTMLButtonElement): Promise<void> {
  const status = previewElement.querySelector<HTMLElement>("[data-pr-fetch-status]");
  button.disabled = true;
  button.textContent = "Fetching…";
  try {
    await githubApi.fetchHead({ repository: current.context.repositoryId, number: current.context.number });
    document.dispatchEvent(new CustomEvent("uatu:pull-request-head-fetched", { detail: { number: current.context.number } }));
    if (state === current) void render(current, { force: true });
  } catch (error) {
    button.disabled = false;
    button.textContent = `Fetch #${current.context.number}'s head`;
    // Q2: without a Git credential for the remote the fetch can't run; the
    // pull request stays readable on GitHub.
    if (status) status.textContent = `Couldn't fetch #${current.context.number}'s head: ${errorText(error)} Open it on GitHub instead.`;
  }
}

// --- the bar above the content -------------------------------------------

// The document view chooser and Wrap move into the bar's first row while a
// file is open (beside the facts, as the wireframe has it), and back into
// the header's toolbar when it closes.
const viewControl = document.querySelector<HTMLElement>("#view-control")!;
const wrapControl = document.querySelector<HTMLElement>("#wrap-control")!;
const actionBar = document.querySelector<HTMLElement>("#preview-action-bar")!;

function ensureChrome(_current: State): HTMLElement {
  let bar = previewShell.querySelector<HTMLElement>(":scope > .pr-file-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "pr-file-bar";
    bar.innerHTML = `<div class="pr-file-row"><div class="pr-file-facts" data-pr-file-facts></div><div class="pr-file-modes" data-pr-file-modes><span class="pr-file-rev-slot" data-pr-file-rev-slot></span></div></div><div data-pr-file-threads></div>`;
    bar.addEventListener("click", onBarClick);
  }
  const modes = bar.querySelector<HTMLElement>("[data-pr-file-modes]")!;
  if (viewControl.parentElement !== modes) modes.prepend(viewControl, wrapControl);
  // Above the layout toolbar (which sits right above #preview).
  const layout = previewShell.querySelector<HTMLElement>(":scope > .uatu-layout-toolbar");
  const before = layout ?? previewElement;
  if (bar.nextElementSibling !== before) previewShell.insertBefore(bar, before);
  return bar;
}

function removeChrome(): void {
  const bar = previewShell.querySelector(":scope > .pr-file-bar");
  if (!bar) return;
  actionBar.before(viewControl, wrapControl);
  bar.remove();
}

function onBarClick(event: Event): void {
  const target = event.target as HTMLElement;
  if (!state) return;
  const rev = target.closest<HTMLButtonElement>("[data-pr-file-rev]");
  if (rev && rev.getAttribute("aria-checked") !== "true") {
    state.context.open({ path: state.target.path, rev: rev.dataset.prFileRev as PullRequestRevision });
    return;
  }
  if (target.closest("[data-pr-file-show-threads]")) {
    const first = threadsOn(state)[0];
    showPullRequestFileThread(first?.id);
    return;
  }
  if (target.closest("[data-pr-file-reload]")) {
    state.notice = null;
    void pullRequestStore.loadDetail(state.context.number, state.context.repositoryId).then(() => { if (state) void render(state, { force: true }); }, () => undefined);
    return;
  }
  const open = target.closest<HTMLButtonElement>("[data-pr-file-open-local]");
  if (open && state.local && state.local.state !== "missing") openInWorkspace(state.local.documentId);
}

function threadsOn(current: State) {
  return (current.detail?.threads ?? []).filter(thread => thread.path === current.target.path && thread.line !== null && !thread.isOutdated);
}

function renderBar(current: State): void {
  const bar = previewShell.querySelector<HTMLElement>(":scope > .pr-file-bar");
  if (!bar || state !== current) return;
  const detail = current.detail;
  const mode = effectiveMode(current);
  const rev = effectiveRev(current);
  const changed = changedFile(current);
  const pr = detail?.summary;
  const oid = rev === "base" ? pr?.baseRefOid : pr?.headRefOid;
  const facts: string[] = [];
  if (oid) facts.push(`at <code>${escapeHtml(shortOid(oid))}</code> (${rev === "base" ? `${escapeHtml(pr!.baseRefName)}, the base` : "PR head"})`);
  if (current.payload && mode !== "diff") facts.push(escapeHtml(formatBytes(current.payload.bytes)));
  if (changed?.status === "removed") facts.push("deleted by this pull request");
  else if (changed?.status === "added") facts.push("added by this pull request");
  else if (!changed && detail) facts.push("not changed by this pull request");
  // Head and Base, where the file has both and they differ.
  const both = changed?.status === "modified";
  const revSwitch = both && mode !== "diff" ? `<span class="view-control pr-file-rev" role="radiogroup" aria-label="Revision">
      ${(["head", "base"] as const).map(value => `<button type="button" class="view-segment${rev === value ? " is-active" : ""}" role="radio" aria-checked="${rev === value}" data-pr-file-rev="${value}" title="${value === "head" ? "The file as the pull request leaves it" : `The file on ${escapeHtmlAttribute(pr?.baseRefName ?? "the base")} before the pull request`}">${value === "head" ? "Head" : "Base"}</button>`).join("")}
    </span>` : "";
  const local = current.local;
  const localHtml = !local || rev !== "head" || mode === "diff" ? ""
    : local.state === "same" ? `<span class="pr-file-local is-same">Same as your checkout <button type="button" class="gh-link-button" data-pr-file-open-local>Open in workspace</button></span>`
    : local.state === "differs" ? `<span class="pr-file-local">Your checkout differs (${escapeHtml(local.why)}); showing the PR head. <button type="button" class="gh-link-button" data-pr-file-open-local>Open your copy</button></span>`
    : `<span class="pr-file-local">Not in your checkout.</span>`;
  const lfs = current.payload?.lfsPointer ? `<span class="pr-file-note">Stored in Git LFS: this is its pointer. uatu never fetches LFS content.</span>` : "";
  const notice = current.notice ? `<span class="pr-file-note is-attention" role="status">${escapeHtml(current.notice)} <button type="button" class="gh-link-button" data-pr-file-reload>Reload</button></span>` : "";
  const threads = threadsOn(current);
  const pending = (detail?.pendingReview?.comments ?? []).filter(comment => comment.path === current.target.path).length;
  const unresolved = threads.filter(thread => !thread.isResolved).length;
  let threadBar = "";
  if (mode !== "diff" && (threads.length > 0 || pending > 0)) {
    const first = threads.find(thread => !thread.isResolved) ?? threads[0];
    const excerpt = first?.comments[0] ? `${escapeHtml(first.comments[0].author)} on line ${first.line}: “${escapeHtml(truncate(first.comments[0].body, 70))}”` : "";
    const counts = [
      threads.length > 0 ? `<strong>${threads.length} ${threads.length === 1 ? "thread" : "threads"}</strong>${unresolved < threads.length ? ` (${unresolved} unresolved)` : ""}` : "",
      pending > 0 ? `<strong>${pending} pending</strong> ${pending === 1 ? "comment" : "comments"} of yours` : "",
    ].filter(Boolean).join(" · ");
    threadBar = `<div class="pr-file-threads" role="note" aria-label="Review threads on this file">
        <span class="pr-file-threads-icon" aria-hidden="true">💬</span>
        <span class="pr-file-threads-text">${counts} on this file${excerpt ? `<span class="pr-file-threads-excerpt"> · ${excerpt}</span>` : ""}</span>
        <button type="button" class="gh-link-button pr-file-threads-show" data-pr-file-show-threads>Show in Diff</button>
      </div>`;
  }
  const factsHtml = `<span class="pr-file-facts-text">${facts.join(" · ")}</span>
      ${localHtml}${lfs}${notice}
      ${detail?.mock ? `<span class="gh-mock-label" title="Served by the in-memory fake (src/github/fake.ts). Nothing reaches GitHub.">Mocked</span>` : ""}`;
  // Rewritten only when they say something new: focus stays.
  for (const [slot, html] of [["[data-pr-file-facts]", factsHtml], ["[data-pr-file-rev-slot]", revSwitch], ["[data-pr-file-threads]", threadBar]] as const) {
    const element = bar.querySelector<HTMLElement>(slot)!;
    if (element.dataset.html === html) continue;
    const focused = element.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : null;
    element.dataset.html = html;
    element.innerHTML = html;
    const name = focused ? Object.keys(focused)[0] : undefined;
    if (name) element.querySelector<HTMLElement>(`[data-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}]`)?.focus({ preventScroll: true });
  }
}

function truncate(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

// Source (single or split): the lines holding a review thread at the head.
function markThreadLines(current: State): void {
  if (state !== current || effectiveRev(current) !== "head") return;
  const byLine = new Map<number, { count: number; resolved: boolean }>();
  for (const thread of threadsOn(current)) {
    if (thread.side !== "RIGHT" || thread.line === null) continue;
    const entry = byLine.get(thread.line) ?? { count: 0, resolved: true };
    entry.count += 1;
    entry.resolved &&= thread.isResolved;
    byLine.set(thread.line, entry);
  }
  for (const line of previewElement.querySelectorAll<HTMLElement>("pre.uatu-source-pre .uatu-cl")) {
    const mark = byLine.get(Number(line.dataset.ln));
    line.classList.toggle("has-pr-thread", Boolean(mark));
    line.classList.toggle("is-resolved", Boolean(mark?.resolved));
    if (mark) line.title = `${mark.count} review ${mark.count === 1 ? "thread" : "threads"} on this line: Show in Diff to read or reply`;
    else line.removeAttribute("title");
  }
}

// --- the checked-out branch's own pull request -----------------------------

// Compares the PR head's file with the checkout's, through the same source
// renderer (identical HTML means identical text). Only for the branch's own
// pull request, at its head; again while the answer is "missing" (the
// workspace's documents may not be indexed yet).
function maybeCompare(current: State): void {
  if (current.comparing || !current.payload || effectiveRev(current) !== "head") return;
  if (current.local && current.local.state !== "missing") return;
  if (pullRequestStore.branchNumber() !== current.context.number) return;
  const target = { repository: current.context.repositoryId, number: current.context.number };
  current.comparing = true;
  void compareWithCheckout(current, target, current.payload.revision.oid).finally(() => { current.comparing = false; });
}

async function compareWithCheckout(current: State, target: { repository: string; number: number }, oid: string): Promise<void> {
  const repository = appState.repositories.find(candidate => candidate.id === current.context.repositoryId);
  if (!repository) return;
  const documentId = `${repository.rootPath.replace(/\/$/, "")}/${current.target.path}`;
  const document_ = findDocumentById(documentId);
  let local: Local;
  if (!document_ || document_.kind === "binary") {
    local = { state: "missing" };
  } else {
    try {
      const [mine, theirs] = await Promise.all([
        fetch(contextualAppUrl(appUrl(`/api/document?id=${encodeURIComponent(documentId)}&view=source`)), { cache: "no-store" })
          .then(response => response.ok ? response.json() as Promise<RenderedDocument> : null),
        readPayload(target, current.target.path, "head", "source", oid),
      ]);
      if (!mine) local = { state: "missing" };
      else if (mine.html === theirs.html) local = { state: "same", documentId };
      else {
        const head = current.detail?.summary.headRefOid ?? "";
        const commit = repository.metadata.commitShort;
        const why = commit && !head.startsWith(commit) ? `checkout at ${commit}` : "local edits";
        local = { state: "differs", why, documentId };
      }
    } catch {
      return;
    }
  }
  if (state !== current) return;
  current.local = local;
  renderBar(current);
}

function openInWorkspace(documentId: string): void {
  const document_ = findDocumentById(documentId);
  if (!document_) return;
  setFollowEnabled(false);
  setSelectedId(document_.id, "navigation");
  setPreviewMode({ kind: "document" });
  pushSelection(document_.id, document_.relativePath);
  syncFollowToggle();
  renderSidebar();
  void loadDocument(document_.id);
}

// Dev Mock scenario switches and resets change what is fetched: read again.
document.addEventListener("uatu:github-scenario", () => {
  payloads.clear();
  if (state) void render(state, { force: true });
});
