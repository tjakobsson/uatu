import { renderMermaidDiagrams, replaceMermaidCodeBlocks } from "./preview";
import {
  buildTreeNodes,
  hasDocument,
  nextSelectedDocumentId,
  shouldRefreshPreview,
  type RootGroup,
  type StatePayload,
  type TreeNode,
} from "./shared";

type RenderedDocument = {
  id: string;
  title: string;
  path: string;
  html: string;
};

const treeElement = document.querySelector<HTMLDivElement>("#tree");
const previewElement = document.querySelector<HTMLElement>("#preview");
const previewTitleElement = document.querySelector<HTMLElement>("#preview-title");
const previewPathElement = document.querySelector<HTMLElement>("#preview-path");
const followToggleElement = document.querySelector<HTMLButtonElement>("#follow-toggle");
const documentCountElement = document.querySelector<HTMLElement>("#document-count");
const connectionStateElement = document.querySelector<HTMLElement>("#connection-state");

if (
  !treeElement ||
  !previewElement ||
  !previewTitleElement ||
  !previewPathElement ||
  !followToggleElement ||
  !documentCountElement ||
  !connectionStateElement
) {
  throw new Error("uatu UI failed to initialize");
}

const appState = {
  roots: [] as RootGroup[],
  selectedId: null as string | null,
  followEnabled: true,
};

followToggleElement.addEventListener("click", () => {
  appState.followEnabled = !appState.followEnabled;
  syncFollowToggle();
});

treeElement.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest<HTMLButtonElement>("button[data-document-id]");
  if (!button) {
    return;
  }

  const documentId = button.dataset.documentId;
  if (!documentId) {
    return;
  }

  appState.followEnabled = false;
  appState.selectedId = documentId;
  syncFollowToggle();
  renderSidebar();
  void loadDocument(documentId);
});

void loadInitialState();

async function loadInitialState() {
  const response = await fetch("/api/state");
  const payload = (await response.json()) as StatePayload;

  appState.roots = payload.roots;
  appState.followEnabled = payload.initialFollow;
  appState.selectedId = payload.defaultDocumentId;
  syncStateGeneration(payload.generatedAt);

  syncFollowToggle();
  renderSidebar();

  if (appState.selectedId) {
    await loadDocument(appState.selectedId);
  }

  connectEvents();
}

function connectEvents() {
  const events = new EventSource("/api/events");

  events.addEventListener("open", () => {
    connectionStateElement.textContent = "Live";
  });

  events.addEventListener("error", () => {
    connectionStateElement.textContent = "Reconnecting";
  });

  events.addEventListener("state", async event => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as StatePayload;
    const previousSelectedId = appState.selectedId;
    const shouldReload = shouldRefreshPreview(previousSelectedId, payload.changedId);

    appState.roots = payload.roots;
    syncStateGeneration(payload.generatedAt);
    appState.selectedId = nextSelectedDocumentId(
      payload.roots,
      previousSelectedId,
      payload.changedId,
      appState.followEnabled,
    );

    renderSidebar();

    if (appState.selectedId && (shouldReload || appState.selectedId !== previousSelectedId)) {
      await loadDocument(appState.selectedId);
      return;
    }

    if (!hasDocument(payload.roots, appState.selectedId)) {
      renderEmptyPreview("No document selected", "Waiting for supported documents");
    }
  });
}

async function loadDocument(documentId: string) {
  const response = await fetch(`/api/document?id=${encodeURIComponent(documentId)}`);

  if (!response.ok) {
    renderEmptyPreview("Document unavailable", "The selected file no longer exists.");
    return;
  }

  const payload = (await response.json()) as RenderedDocument;
  previewTitleElement.textContent = payload.title;
  previewPathElement.textContent = payload.path;
  previewElement.classList.remove("empty");
  previewElement.innerHTML = replaceMermaidCodeBlocks(payload.html);
  await renderMermaidDiagrams(previewElement);
}

function renderSidebar() {
  const documentCount = appState.roots.reduce((sum, root) => sum + root.docs.length, 0);
  documentCountElement.textContent = `${documentCount} doc${documentCount === 1 ? "" : "s"}`;

  if (documentCount === 0) {
    treeElement.innerHTML = `<div class="tree-empty">No supported documents found in the watched roots.</div>`;
    return;
  }

  treeElement.innerHTML = appState.roots
    .map(root => {
      const nodes = buildTreeNodes(root);
      return `
        <section class="root-group">
          <header class="root-title">
            <strong>${escapeHtml(root.label)}</strong>
            <span>${escapeHtml(root.path)}</span>
          </header>
          ${renderNodes(nodes)}
        </section>
      `;
    })
    .join("");
}

function renderNodes(nodes: TreeNode[]): string {
  if (nodes.length === 0) {
    return `<div class="tree-empty">No supported documents in this root.</div>`;
  }

  return `<ul>${nodes
    .map(node => {
      if (node.kind === "dir") {
        return `
          <li class="tree-node tree-dir">
            <details open>
              <summary>${escapeHtml(node.name)}</summary>
              ${renderNodes(node.children ?? [])}
            </details>
          </li>
        `;
      }

      const isSelected = node.id === appState.selectedId;
      return `
        <li class="tree-node tree-doc">
          <button type="button" class="tree-doc-button${isSelected ? " is-selected" : ""}" data-document-id="${escapeHtmlAttribute(node.id ?? "")}">
            ${escapeHtml(node.name)}
          </button>
        </li>
      `;
    })
    .join("")}</ul>`;
}

function renderEmptyPreview(title: string, body: string) {
  previewTitleElement.textContent = title;
  previewPathElement.textContent = body;
  previewElement.classList.add("empty");
  previewElement.innerHTML = `<p>${escapeHtml(body)}</p>`;
}

function syncFollowToggle() {
  followToggleElement.textContent = appState.followEnabled ? "Follow on" : "Follow off";
  followToggleElement.setAttribute("aria-pressed", String(appState.followEnabled));
}

function syncStateGeneration(generatedAt: number) {
  document.body.dataset.stateGeneratedAt = String(generatedAt);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}
