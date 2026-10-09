// Live document state — the `document` topic consumer on the page's one
// brokered live channel (see `shell/live.ts`). Each `state` payload is
// dispatched back into the app from here. The reducer logic for
// build-freshness checking, follow-mode auto-switching, and on-disk-change
// reloads lives in here, intentionally close to its trigger (the envelope).

import { chooseSelectionForFileEvent, finishFollowDiscovery } from "./follow";
import { checkBuildFreshness } from "./freshness";
import { applyProjectIdentity } from "./identity";
import { findDocumentById, findDocumentByRelativePath, syncStateGeneration } from "./storage";
import { signalActiveDocumentUpdated } from "../preview/file-facts-strip";
import { documentDiffCache, forgetDocumentCache, loadDocument } from "../preview/mount";
import { applyDiffForActiveDocument, diffInputsMoved, dropStaleDiffs, forgetAllDiffs } from "../preview/diff";
import { renderEmptyPreview } from "../preview/empty";
import { renderSidebar, renderSidebarPatch } from "../sidebar/shell";
import { documentIndex, resetDocumentIndex, documentRevisionKey } from "./document-state";
import { enrichDocumentFacts, forgetDocumentFacts } from "../preview/facts-enrichment";
import { syncFileFactsStrip } from "../preview/file-facts-strip";
import { documentViewCache } from "../preview/mount";
import { sameDocumentContext, unseenSnapshotChange, type DocumentPatch, type DocumentSnapshot, type DocumentUpdate } from "../shared/document-updates";
import { markSearchResultsStale, noteSearchCorpusChange, syncSearchScope } from "../sidebar/search-pane";
import {
  hasDocument,
  shouldRefreshPreview,
  type StatePayload,
} from "../shared/types";
import { applyChannelStatus } from "./connection";
import type { LiveSubscriptionHandle, LiveTopicConsumer } from "./live-channel";
import { fetchWithinBudget } from "./bounded-fetch";
import { liveChannel, registerLiveTeardown, registerRecoveryWork } from "./live";
import { createStateReconciler } from "./recovery";
import { renderBuildBadge } from "./connection";
import { appUrl } from "../shared/app-url";
import { documentContextKey } from "../shared/live-protocol";
import { applyWatchContext } from "../shared/watch-context";
import { replaceSelection } from "./history";
import { setSelectedId, getPendingDocumentPath } from "./selection";
import { appState } from "./state";
import { renderCommitPreview } from "./url";
import { contextualAppUrl, currentWatchContext, setClientScope } from "./watch-context";

// The page's document subscription. Transport recovery belongs to the
// channel (`shell/live-channel.ts`): it closes each failed stream and reopens
// on a capped-backoff schedule of its own, presenting this topic's retained
// cursor so a reconnect resumes rather than restarts. What this module owns
// is the indicator's truth: a generation counts as connected only once it
// has proven the page's state current — the first applied `state` payload,
// or the topic's `ready` when the page already holds state at the presented
// cursor and nothing newer exists to deliver.
let documentSubscription: LiveSubscriptionHandle | null = null;
let subscriptionKey: string | null = null;
// Whether the current subscription has delivered state (or found the page's
// state current). Reset on every new subscription: a fresh one, with no
// cursor, owes a snapshot before `ready` can mean anything.
let documentStateHeld = false;
let installed = false;

// The document topic's key: the current watch context (compare target and
// scope) as the canonical query the hub appends to the child's route.
function documentKey(): string {
  const url = applyWatchContext(new URL("http://uatu.invalid/"), currentWatchContext());
  return documentContextKey(url.searchParams);
}

// Replaces the document subscription with one for the current context. No
// cursor is presented, so the hub delivers a fresh snapshot. Not a recovery:
// the transport is untouched — a scope widening, a compare-target change, or
// the server normalizing an invalid pin all land here.
function subscribeDocument(): void {
  documentSubscription?.close();
  documentStateHeld = false;
  subscriptionKey = documentKey();
  documentSubscription = liveChannel().subscribe({ topic: "document", key: subscriptionKey }, documentConsumer);
}

function scopesEqual(left: StatePayload["scope"], right: StatePayload["scope"]): boolean {
  return left.kind === right.kind
    && (left.kind === "folder" || (right.kind === "file" && left.documentId === right.documentId));
}

function renderPendingDocument(): boolean {
  const path = getPendingDocumentPath();
  if (!path) return false;
  const complete = appState.discovery.status === "ready";
  renderEmptyPreview(complete ? "Document not found" : "Document indexing",
    complete ? `Document not found at ${path}.` : `Waiting for indexing to resolve ${path}.`);
  return true;
}

function hasNewRepositoryState(update: DocumentUpdate): boolean {
  const previous = documentIndex.view();
  return update.epoch !== previous?.epoch || update.compareTarget !== previous?.compareTarget
    || update.repositoryState !== undefined && update.repositoryState.generation !== previous?.repositoryState.generation;
}

// Owner mutator for the server-snapshot triple (`roots`, `repositories`,
// `scope`). The SSE reducer below is the ongoing writer; the boot path
// (`shell/boot.ts`) applies its initial /api/state payload through
// `adoptBootSnapshot`, which also records its freshness.
function applyServerSnapshot(payload: StatePayload): boolean {
  let repositoryUpdated = false;
  if ((payload as DocumentSnapshot).kind === "snapshot") {
    const snapshot = payload as DocumentSnapshot;
    repositoryUpdated = hasNewRepositoryState(snapshot);
    const previous = documentIndex.view();
    if (previous && !sameDocumentContext(previous, snapshot)) resetDocumentIndex();
    if (documentIndex.apply(snapshot) !== "applied") return false;
    // A new epoch or compare target invalidates every diff; a repository
    // update only those whose inputs moved (after repositories are applied).
    if (snapshot.epoch !== previous?.epoch || snapshot.compareTarget !== previous?.compareTarget) documentDiffCache.clear();
    appState.discovery = snapshot.discovery;
    appState.repositoryFreshness = snapshot.repositoryState;
  }
  // Every payload carries the server's build identity — boot and SSE
  // reconnect both land here, so this is the one freshness chokepoint.
  checkBuildFreshness(payload.build);
  appState.roots = payload.roots;
  appState.repositories = payload.repositories ?? [];
  if ((payload as DocumentSnapshot).kind === "snapshot" && repositoryUpdated) dropStaleDiffs();
  setClientScope(payload.scope);
  appState.unscopedFingerprint = payload.unscopedFingerprint ?? null;
  // The Search pane names the scope in effect; it has to hear about changes.
  syncSearchScope();
  // And a document vanishing from the corpus invalidates results that point at
  // it — a deletion arrives with no `changedId`, so the change path misses it.
  // (For widened results the fingerprint just stored is the signal instead.)
  noteSearchCorpusChange();
  // Title, favicon tint, and sidebar marker all derive from roots;
  // re-applying on every payload keeps them honest if roots change.
  applyProjectIdentity(payload.roots);
  return true;
}

// Boot's initial /api/state payload. Applied like any snapshot, and recorded
// with the reconciler as the state every later payload must be newer than.
// Otherwise the first live frame is accepted whatever its age — and through
// the hub it can be older: a page joining a document upstream that is
// already open (another tab, or the one a reload leaves lingering) is handed
// that upstream's latest snapshot, produced before this fetch was answered,
// which would put the page back on the older roots.
export function adoptBootSnapshot(payload: StatePayload): void {
  stateReconciler.recordApplied(payload.generatedAt);
  applyServerSnapshot(payload);
}

// Boot's entry point: subscribes the document topic for the current context
// and opens the page's one live stream. Wake-up recovery is the channel's
// (`shell/live.ts`); this module registers the state fetch it needs.
export function connectEvents() {
  if (!installed) {
    installed = true;
    const unsubscribeStatus = liveChannel().onStatus(applyChannelStatus);
    const unregisterRecovery = registerRecoveryWork(() => stateReconciler.reconcile());
    // Repository data arrives on the document topic. The server observes Git
    // metadata, and for a narrow root its repository's working tree, so the
    // page never polls for it.
    registerLiveTeardown(() => {
      unsubscribeStatus();
      unregisterRecovery();
      documentSubscription?.close();
      documentSubscription = null;
      subscriptionKey = null;
      documentStateHeld = false;
      installed = false;
    });
  }
  subscribeDocument();
  liveChannel().connect();
}

const documentConsumer: LiveTopicConsumer = {
  data: (data, _cursor, generation) => {
    const update = data as DocumentUpdate;
    if (update.kind === "patch") void applyDocumentPatch(update, generation);
    else void applyDocumentFrame(data as StatePayload, generation);
  },
  // Nothing newer than the presented cursor exists: the state this page
  // holds IS current, and the indicator can say so without a payload.
  ready: generation => {
    if (documentStateHeld) liveChannel().confirm(generation);
  },
  // The cursor is not replayable. A fresh subscription delivers a snapshot,
  // which confirms the generation on arrival.
  resync: () => subscribeDocument(),
  // The workspace child is gone or unreachable; the hub retries and sends
  // `ready` (and fresh state) on recovery. Until then the page's state is
  // not proven current.
  unavailable: generation => liveChannel().invalidate(generation),
};

async function applyDocumentPatch(patch: DocumentPatch, generation: number): Promise<void> {
  if (!liveChannel().isCurrent(generation)) return;
  const mode = appState.previewMode;
  const repositoryChanged = hasNewRepositoryState(patch);
  const selected = appState.selectedId;
  const previousDocument = selected ? documentIndex.find(selected) : undefined;
  const result = documentIndex.apply(patch);
  if (result === "resync") { subscribeDocument(); return; }
  if (result === "ignored") { liveChannel().confirm(generation); return; }
  const payload = documentIndex.view()!;
  appState.roots = payload.roots;
  appState.repositories = payload.repositories;
  if (repositoryChanged) dropStaleDiffs();
  const attributesChanged = [...patch.upserts, ...patch.removals].some(doc => /(^|\/)\.gitattributes$/.test(doc.id));
  if (attributesChanged) forgetAllDiffs();
  appState.discovery = payload.discovery;
  appState.repositoryFreshness = payload.repositoryState;
  appState.unscopedFingerprint = payload.unscopedFingerprint ?? null;
  documentStateHeld = true;
  stateReconciler.recordApplied(payload.generatedAt);
  liveChannel().confirm(generation);
  syncStateGeneration(payload.generatedAt);
  for (const doc of patch.upserts) { forgetDocumentCache(doc.id); markSearchResultsStale(doc.id); }
  for (const doc of patch.removals) { forgetDocumentCache(doc.id); markSearchResultsStale(doc.id); }
  noteSearchCorpusChange();
  if (mode.kind === "commit") {
    renderSidebarPatch(patch);
    if (patch.repositories) renderCommitPreview(mode);
    return;
  }

  const pendingPath = getPendingDocumentPath();
  let next = (pendingPath ? patch.upserts.find(doc => doc.relativePath === pendingPath)?.id : null) ?? selected;
  const catchUp = finishFollowDiscovery(payload.defaultDocumentId, patch.changedId);
  if (appState.followEnabled && patch.changedId) next = patch.changedId;
  else if (catchUp) next = catchUp;
  else if (payload.discovery.status === "ready" && !appState.selectionCleared && appState.previewMode.kind === "document"
    && (!selected || appState.followEnabled && !documentIndex.find(selected))) next = payload.defaultDocumentId;
  setSelectedId(next);
  if (next && next !== selected) {
    const doc = documentIndex.find(next);
    if (doc) replaceSelection(next, doc.relativePath);
  }
  renderSidebarPatch(patch);
  if (patch.repositoryState && appState.selectedId && appState.viewMode !== "diff") {
    const id = appState.selectedId;
    const cached = documentViewCache.get(id);
    const payload = cached?.[appState.viewMode] ?? cached?.source ?? cached?.rendered;
    const key = documentRevisionKey(id);
    if (payload && patch.repositoryState.status === "ready") {
      void enrichDocumentFacts(payload, () => appState.selectedId === id && appState.viewMode !== "diff" && documentRevisionKey(id) === key);
    } else if (payload?.fileFacts && payload.fileFacts.gitState !== "non-git") {
      forgetDocumentFacts(id);
      payload.fileFacts = { ...payload.fileFacts, gitState: patch.repositoryState.status === "error" ? "unavailable" : payload.fileFacts.git ? "stale" : "pending" };
      syncFileFactsStrip({ kind: "document", facts: payload.fileFacts });
    }
  }
  const current = next ? documentIndex.find(next) : undefined;
  const reload = next !== selected || previousDocument?.revision !== current?.revision
    || Boolean(previousDocument) !== Boolean(current);
  if (next && reload) {
    await loadDocument(next);
    if (next === selected && appState.selectedId === next && current) signalActiveDocumentUpdated();
  } else if (next && appState.viewMode === "diff" && (attributesChanged || repositoryChanged && diffInputsMoved(next))) {
    await applyDiffForActiveDocument(next);
  } else if (!next && !renderPendingDocument() && reload) renderEmptyPreview("No document selected", "Waiting for viewable files");
}

async function applyDocumentFrame(payload: StatePayload, generation: number): Promise<void> {
  // A payload from a superseded attempt describes a connection this client
  // has already replaced; applying it could overwrite newer state.
  if (!liveChannel().isCurrent(generation)) return;
  documentStateHeld = true;
  // A frame the server produced before state this client has already applied
  // — the initial frame of a stream opened just before a reconciliation
  // fetch answered, typically. Applying it would put back the older roots,
  // repositories, and scope. The transport is still proven live, so the
  // channel is confirmed either way.
  if ((payload as DocumentSnapshot).kind !== "snapshot" && !stateReconciler.acceptFrame(payload.generatedAt)) {
    liveChannel().confirm(generation);
    return;
  }
  const previousSelectedId = appState.selectedId;
  const repositoryChanged = (payload as DocumentSnapshot).kind === "snapshot" && hasNewRepositoryState(payload as DocumentSnapshot);
  const changedId = payload.changedId ?? ((payload as DocumentSnapshot).kind === "snapshot" ? unseenSnapshotChange(documentIndex, payload as DocumentSnapshot) : null);
  const previousScope = appState.scope;
  const shouldReload = Boolean(documentIndex.epoch && (payload as DocumentSnapshot).epoch
    && documentIndex.epoch !== (payload as DocumentSnapshot).epoch) || shouldRefreshPreview(
    previousSelectedId,
    payload.changedId,
    appState.roots,
    payload.roots,
  );

  if (!applyServerSnapshot(payload)) { liveChannel().confirm(generation); return; }
  stateReconciler.recordApplied(payload.generatedAt);
  // Transport is only proven once this generation's authoritative state has
  // been applied — an open socket that never delivers state is exactly the
  // half-dead connection the indicator must not call `Connected`.
  liveChannel().confirm(generation);
  if (!scopesEqual(previousScope, payload.scope) || subscriptionKey !== documentKey()) {
    // The subscription is keyed by context. Replace it after server-side
    // normalization so a later reconnect cannot revive a deleted file pin
    // that this client has already widened away from. Not a recovery: the
    // transport never failed, the server changed the context.
    subscribeDocument();
  }
  syncStateGeneration(payload.generatedAt);

  // A watched file changed, so displayed search results captured line
  // numbers that may no longer hold. Mark them rather than re-running: in a
  // watched repository that would be a query storm, and rows would jump
  // under the reader's cursor while they are reading them. The pane checks
  // the id against its rows — a change to an unlisted file proves nothing
  // about the results. This must precede the preview-mode returns below:
  // the Search pane is visible in those modes too, and its results go stale
  // the same way there.
  if (payload.changedId) {
    markSearchResultsStale(payload.changedId);
  }

  // Local snapshot so the discriminant narrowing survives into the closure.
  const previewMode = appState.previewMode;
  if (previewMode.kind === "commit") {
    renderSidebar();
    renderCommitPreview(previewMode);
    return;
  }

  // Rule C/D selection decision (see follow-mode capability).
  const catchUp = finishFollowDiscovery(payload.defaultDocumentId, changedId);
  const pendingPath = getPendingDocumentPath();
  const pendingDocument = pendingPath ? findDocumentByRelativePath(pendingPath) : null;
  const preserveEmpty = !appState.followEnabled && appState.previewMode.kind === "empty" && previousSelectedId === null;
  const discovering = (payload as DocumentSnapshot).discovery?.status !== undefined && (payload as DocumentSnapshot).discovery.status !== "ready";
  setSelectedId(pendingDocument?.id ?? catchUp ?? (preserveEmpty || discovering && !changedId ? previousSelectedId : chooseSelectionForFileEvent(
    payload.roots,
    previousSelectedId,
    changedId,
    appState.followEnabled,
    appState.selectionCleared,
  )));

  // Reveal the newly-selected file only when selection actually changed —
  // so a user-closed ancestor isn't re-opened by unrelated state updates.
  if (appState.selectedId && appState.selectedId !== previousSelectedId) {
    // Server-driven selection change (follow auto-switch, or current doc
    // was deleted and we fell back to the default). The URL must follow
    // what's on screen, but we use replaceState — pushing here would
    // pollute the back stack with file-change-driven entries the user
    // never asked for.
    const switched = findDocumentById(appState.selectedId);
    if (switched) {
      replaceSelection(appState.selectedId, switched.relativePath);
    }
  }

  renderSidebar();

  if (
    appState.selectedId &&
    (shouldReload || appState.selectedId !== previousSelectedId)
  ) {
    if (shouldReload) {
      // The file changed on disk — any cached payload is now stale.
      forgetDocumentCache(appState.selectedId);
    }
    await loadDocument(appState.selectedId);
    if (shouldReload && appState.selectedId === previousSelectedId && hasDocument(appState.roots, previousSelectedId)) {
      // In-place reload of the document being viewed (Rule D): surface the
      // otherwise-silent swap. A selection switch is a new document, not an
      // update of what the user was reading — no signal there.
      signalActiveDocumentUpdated();
    }
    return;
  }

  if (appState.selectedId && !hasDocument(payload.roots, appState.selectedId)) {
    await loadDocument(appState.selectedId);
  } else if (appState.selectedId && repositoryChanged && appState.viewMode === "diff" && diffInputsMoved(appState.selectedId)) {
    await applyDiffForActiveDocument(appState.selectedId);
  } else if (!appState.selectedId) {
    if (!renderPendingDocument()) renderEmptyPreview("No document selected", "Waiting for viewable files");
  }
}

// How long the state fetch may go unanswered. A phone that changed networks
// mid-request gets no error, only silence; unbounded, that silence would hold
// the lifecycle recovery's coalescer (see `shell/recovery.ts`) and every
// later wake-up would be dropped. Under the recovery ceiling, so the fetch
// is the one that fails, and the reconciler's ordering sees a real rejection.
export const STATE_FETCH_TIMEOUT_MS = 15_000;

// The one path that converges this client on authoritative state and a fresh
// stream. Both the explicit callers (scope widening, compare-target change)
// and the lifecycle wake-up below go through it, so the reconciler's ordering
// guard covers them all: an older fetch cannot land on top of newer state,
// whichever route delivered that state.
const stateReconciler = createStateReconciler<StatePayload>({
  fetchState: async () => {
    const epoch = documentIndex.epoch;
    const context = currentWatchContext();
    const payload = await fetchWithinBudget(
      (input, init) => fetch(input, init), contextualAppUrl(appUrl("/api/state")), STATE_FETCH_TIMEOUT_MS,
      async response => {
        if (!response.ok) throw new Error(`state refresh failed: ${response.status}`);
        return await response.json() as StatePayload;
      },
    );
    // A stream can replace the child epoch or normalize/change context while
    // this HTTP read is pending. Its obsolete answer cannot put that back.
    if (!sameDocumentContext(context, currentWatchContext())
      || epoch !== documentIndex.epoch && (payload as DocumentSnapshot).epoch !== documentIndex.epoch) {
      return documentIndex.view() ?? payload;
    }
    return payload;
  },
  freshnessOf: payload => payload.generatedAt,
  acceptState: payload => {
    const snapshot = payload as DocumentSnapshot;
    if (snapshot.kind !== "snapshot") return undefined;
    const current = documentIndex.view();
    return !current || snapshot.epoch !== current.epoch || !sameDocumentContext(current, snapshot) || snapshot.revision >= current.revision;
  },
  applyState: payload => {
    // Decided against the roots this client still holds, BEFORE the snapshot
    // overwrites them. A document edited while the page was suspended arrives
    // with no `changedId` and, once these roots are replaced, the replacement
    // stream's first frame sees no mtime difference either — so this is the
    // only place the staleness is still visible.
    const selectedId = appState.selectedId;
    const repositoryChanged = (payload as DocumentSnapshot).kind === "snapshot" && hasNewRepositoryState(payload as DocumentSnapshot);
    const changedId = (payload as DocumentSnapshot).kind === "snapshot" ? unseenSnapshotChange(documentIndex, payload as DocumentSnapshot) : payload.changedId;
    const staleSelection = Boolean(documentIndex.epoch && (payload as DocumentSnapshot).epoch
      && documentIndex.epoch !== (payload as DocumentSnapshot).epoch) || shouldRefreshPreview(
      selectedId,
      payload.changedId,
      appState.roots,
      payload.roots,
    );

    if (!applyServerSnapshot(payload)) return;
    if (installed && subscriptionKey !== documentKey()) subscribeDocument();
    const catchUp = finishFollowDiscovery(payload.defaultDocumentId, changedId);
    const pendingPath = getPendingDocumentPath();
    const pendingDocument = pendingPath ? findDocumentByRelativePath(pendingPath) : null;
    const reconcileFollow = appState.followEnabled && appState.discovery.status === "ready" && appState.previewMode.kind !== "commit";
    const followTarget = pendingDocument?.id ?? catchUp ?? (reconcileFollow ? chooseSelectionForFileEvent(payload.roots, selectedId, changedId, true) : null);
    if (reconcileFollow || followTarget) {
      setSelectedId(followTarget);
      const document = followTarget ? findDocumentById(followTarget) : null;
      if (document) replaceSelection(document.id, document.relativePath);
    }
    syncStateGeneration(payload.generatedAt);
    renderBuildBadge(payload.build);
    renderSidebar();
    if (appState.previewMode.kind === "commit") {
      renderCommitPreview(appState.previewMode);
      return;
    }
    const activeId = appState.selectedId;
    if (activeId && (staleSelection || activeId !== selectedId)) {
      forgetDocumentCache(activeId);
      void loadDocument(activeId).then(() => {
        // Same signal the in-place reload gives on Rule D: the document the
        // user was reading changed under them, and the swap is otherwise
        // silent.
        if (appState.selectedId === selectedId && hasDocument(appState.roots, selectedId)) signalActiveDocumentUpdated();
      });
    } else if (activeId && repositoryChanged && appState.viewMode === "diff" && diffInputsMoved(activeId)) {
      void applyDiffForActiveDocument(activeId);
    } else if (!activeId && !renderPendingDocument() && reconcileFollow) renderEmptyPreview("No document selected", "Waiting for viewable files");
  },
});

// A context change, not a recovery — the caller moved the scope or the
// compare target and the transport was never in doubt. Reconciles
// authoritative state AND replaces the document subscription.
//
// The subscription is replaced FIRST, and there is no `await` between the
// caller's context change and this call, so the topic being replaced cannot
// deliver anything more: it carries the context the client has just moved
// away from (a file pin the caller is widening, an old compare target), and
// a frame from it would reinstate that context — and, being newer by the
// server's own clock, would also discard the payload this fetch is about to
// bring back, leaving the session on the context the user asked to leave.
//
// The fetch is then a fallback rather than the primary path — when the fresh
// subscription's snapshot arrives, it is the newer state and this payload is
// correctly discarded. (A wake-up goes through `shell/live.ts` instead: it
// reconnects the one channel, then runs the reconcile registered above.)
export async function refreshServerStateForContext(): Promise<void> {
  subscribeDocument();
  await stateReconciler.reconcile();
}
