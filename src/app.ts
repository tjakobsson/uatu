import { fileIconForName } from "./file-icons";
import { renderMermaidDiagrams, replaceMermaidCodeBlocks } from "./preview";
import {
  buildTreeNodes,
  defaultDocumentId,
  formatRelativeTime,
  hasDocument,
  nextSelectedDocumentId,
  shouldRefreshPreview,
  type BuildSummary,
  type RootGroup,
  type Scope,
  type StatePayload,
  type TreeNode,
} from "./shared";

type RenderedDocument = {
  id: string;
  title: string;
  path: string;
  html: string;
  kind: "markdown" | "text";
  language: string | null;
};

const SIDEBAR_COLLAPSED_KEY = "uatu:sidebar-collapsed";

const appShellElement = document.querySelector<HTMLDivElement>(".app-shell");
const previewBaseElement = document.querySelector<HTMLBaseElement>("#preview-base");
const treeElement = document.querySelector<HTMLDivElement>("#tree");
const previewElement = document.querySelector<HTMLElement>("#preview");
const previewTitleElement = document.querySelector<HTMLElement>("#preview-title");
const previewPathElement = document.querySelector<HTMLElement>("#preview-path");
const previewTypeElement = document.querySelector<HTMLElement>("#preview-type");
const followToggleElement = document.querySelector<HTMLButtonElement>("#follow-toggle");
const documentCountElement = document.querySelector<HTMLElement>("#document-count");
const connectionStateElement = document.querySelector<HTMLElement>("#connection-state");
const connectionLabelElement = connectionStateElement?.querySelector<HTMLElement>(".connection-label") ?? null;
const buildBadgeElement = document.querySelector<HTMLElement>("#build-badge");
const sidebarCollapseElement = document.querySelector<HTMLButtonElement>("#sidebar-collapse");
const sidebarExpandElement = document.querySelector<HTMLButtonElement>("#sidebar-expand");
const pinToggleElement = document.querySelector<HTMLButtonElement>("#pin-toggle");

if (
  !appShellElement ||
  !previewBaseElement ||
  !treeElement ||
  !previewElement ||
  !previewTitleElement ||
  !previewPathElement ||
  !previewTypeElement ||
  !followToggleElement ||
  !documentCountElement ||
  !connectionStateElement ||
  !connectionLabelElement ||
  !buildBadgeElement ||
  !sidebarCollapseElement ||
  !sidebarExpandElement ||
  !pinToggleElement
) {
  throw new Error("uatu UI failed to initialize");
}

const appState = {
  roots: [] as RootGroup[],
  selectedId: null as string | null,
  followEnabled: true,
  scope: { kind: "folder" } as Scope,
  // Per-directory open/closed state the user explicitly set by clicking a
  // directory's <summary>. Session-only; wins over the default-open rule.
  dirOverrides: new Map<string, "open" | "closed">(),
};

initSidebarCollapse();
initBrandLogo();

function initBrandLogo() {
  const logo = document.querySelector<HTMLImageElement>(".brand-logo");
  const src = logo?.dataset.src;
  if (logo && src) {
    logo.src = src;
  }
}

followToggleElement.addEventListener("click", () => {
  if (appState.scope.kind === "file") {
    return;
  }
  const wasEnabled = appState.followEnabled;
  appState.followEnabled = !wasEnabled;
  syncFollowToggle();

  // Enabling follow should "catch up" to the latest changed file rather than
  // wait for the next change event — otherwise the user clicks Follow and
  // nothing visible happens until a file is touched.
  if (!wasEnabled && appState.followEnabled) {
    const latestId = defaultDocumentId(appState.roots);
    if (latestId && latestId !== appState.selectedId) {
      appState.selectedId = latestId;
      revealSelectedFile();
      renderSidebar();
      void loadDocument(latestId);
    }
  }
});

sidebarCollapseElement.addEventListener("click", () => setSidebarCollapsed(true));
sidebarExpandElement.addEventListener("click", () => setSidebarCollapsed(false));

pinToggleElement.addEventListener("click", () => {
  if (!appState.selectedId) {
    return;
  }

  const nextScope: Scope =
    appState.scope.kind === "file"
      ? { kind: "folder" }
      : { kind: "file", documentId: appState.selectedId };

  if (nextScope.kind === "file" && appState.followEnabled) {
    appState.followEnabled = false;
    syncFollowToggle();
  }

  void postScope(nextScope);
});

// Capture real user clicks on a directory's <summary> and record the resulting
// open/closed state as an override. We don't use the <details> `toggle` event
// because the browser fires a synthetic toggle for every element parsed with
// `open=""` — which would cause every re-render to "auto-user-open" all open
// directories, defeating the override system entirely.
treeElement.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const summary = target.closest("summary");
  if (!summary) {
    return;
  }
  const details = summary.parentElement;
  if (!(details instanceof HTMLDetailsElement)) {
    return;
  }
  const dirPath = details.dataset.dirPath;
  if (!dirPath) {
    return;
  }
  // The click fires before the browser toggles the element, so `details.open`
  // here reflects the PRE-toggle state. The next state is the inverse.
  const nextOpen = !details.open;
  appState.dirOverrides.set(dirPath, nextOpen ? "open" : "closed");
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
  revealSelectedFile();
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
  appState.scope = payload.scope;
  revealSelectedFile();
  syncStateGeneration(payload.generatedAt);
  renderBuildBadge(payload.build);

  syncFollowToggle();
  syncPinToggle();
  renderSidebar();

  if (appState.selectedId) {
    await loadDocument(appState.selectedId);
  }

  connectEvents();
}

function connectEvents() {
  const events = new EventSource("/api/events");

  events.addEventListener("open", () => {
    setConnectionState("live", "Online");
  });

  events.addEventListener("error", () => {
    setConnectionState("reconnecting", "Reconnecting");
  });

  events.addEventListener("state", async event => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as StatePayload;
    const previousSelectedId = appState.selectedId;
    const shouldReload = shouldRefreshPreview(previousSelectedId, payload.changedId);

    appState.roots = payload.roots;
    appState.scope = payload.scope;
    syncStateGeneration(payload.generatedAt);
    appState.selectedId = nextSelectedDocumentId(
      payload.roots,
      previousSelectedId,
      payload.changedId,
      appState.followEnabled,
    );

    // Reveal the newly-selected file only when selection actually changed —
    // so a user-closed ancestor isn't re-opened by unrelated state updates.
    if (appState.selectedId && appState.selectedId !== previousSelectedId) {
      revealSelectedFile();
    }

    syncPinToggle();
    renderSidebar();

    if (appState.selectedId && (shouldReload || appState.selectedId !== previousSelectedId)) {
      await loadDocument(appState.selectedId);
      return;
    }

    if (!hasDocument(payload.roots, appState.selectedId)) {
      renderEmptyPreview("No document selected", "Waiting for viewable files");
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
  setPreviewType(payload);
  previewElement.classList.remove("empty");
  setPreviewBase(payload.path);
  previewElement.innerHTML = replaceMermaidCodeBlocks(payload.html);
  await renderMermaidDiagrams(previewElement);
  if (payload.kind === "text") {
    attachLineNumbers(previewElement);
  }
  attachCopyButtons(previewElement);
  syncPinToggle();
}

// Attach a line-number gutter to each <pre><code> in the container. The gutter
// is a sibling <span> of <code>, NOT a child — copy-to-clipboard reads
// `code.textContent` so line numbers are excluded automatically. `user-select:
// none` on the gutter also keeps mouse-selection of the code clean.
function attachLineNumbers(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLPreElement>("pre");
  blocks.forEach(pre => {
    const code = pre.querySelector<HTMLElement>("code");
    if (!code) {
      return;
    }
    if (pre.querySelector(".line-numbers")) {
      return;
    }

    const text = code.textContent ?? "";
    const lineCount = Math.max(1, text.replace(/\n$/, "").split("\n").length);
    const numbers = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");

    const gutter = document.createElement("span");
    gutter.className = "line-numbers";
    gutter.setAttribute("aria-hidden", "true");
    gutter.textContent = numbers;

    pre.classList.add("has-line-numbers");
    pre.insertBefore(gutter, code);
  });
}

function attachCopyButtons(container: HTMLElement) {
  const blocks = container.querySelectorAll<HTMLPreElement>("pre");
  blocks.forEach(pre => {
    const code = pre.querySelector<HTMLElement>("code");
    if (!code) {
      return;
    }
    if (pre.querySelector(".code-copy")) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.setAttribute("aria-label", "Copy code to clipboard");
    button.title = "Copy to clipboard";
    button.textContent = "Copy";

    button.addEventListener("click", async event => {
      event.preventDefault();
      const text = code.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        flashCopyButton(button, "Copied!", "is-copied");
      } catch {
        flashCopyButton(button, "Failed", "is-failed");
      }
    });

    pre.appendChild(button);
  });
}

function flashCopyButton(button: HTMLButtonElement, label: string, modifier: string) {
  button.textContent = label;
  button.classList.add(modifier);
  window.setTimeout(() => {
    button.textContent = "Copy";
    button.classList.remove(modifier);
  }, 1500);
}

function setPreviewType(payload: RenderedDocument) {
  const label =
    payload.kind === "markdown"
      ? "markdown"
      : payload.language ?? "text";
  previewTypeElement.textContent = label;
  previewTypeElement.hidden = false;
}

function clearPreviewType() {
  previewTypeElement.textContent = "";
  previewTypeElement.hidden = true;
}

function setPreviewBase(relativePath: string) {
  // The preview's base href points at the document's directory so relative
  // references inside the markdown (e.g. <img src="./hero.svg">) resolve to
  // URLs the server's static file fallback already knows how to serve.
  const lastSlash = relativePath.lastIndexOf("/");
  const directory = lastSlash === -1 ? "" : relativePath.slice(0, lastSlash + 1);
  previewBaseElement.href = new URL(`/${directory}`, window.location.origin).toString();
}

async function postScope(scope: Scope) {
  try {
    const response = await fetch("/api/scope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { scope: Scope };
    appState.scope = payload.scope;
    syncPinToggle();
  } catch {
    // The state broadcast from the server will reconcile on the next tick.
  }
}

function renderSidebar() {
  const totalCount = appState.roots.reduce((sum, root) => sum + root.docs.length, 0);
  const binaryCount = appState.roots.reduce(
    (sum, root) => sum + root.docs.filter(doc => doc.kind === "binary").length,
    0,
  );
  const hiddenCount = appState.roots.reduce((sum, root) => sum + root.hiddenCount, 0);

  const segments = [`${totalCount} file${totalCount === 1 ? "" : "s"}`];
  if (binaryCount > 0) {
    segments.push(`${binaryCount} binary`);
  }
  if (hiddenCount > 0) {
    segments.push(`${hiddenCount} hidden`);
  }
  documentCountElement.textContent = segments.join(" · ");

  if (totalCount === 0) {
    treeElement.innerHTML = `<div class="tree-empty">No files found in the watched roots.</div>`;
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

// Directories default to closed (matching VS Code / Finder / GitHub conventions).
// A user's explicit click on <summary> stores an override that wins for the
// rest of the session.
function shouldDirRenderOpen(dirPath: string): boolean {
  return appState.dirOverrides.get(dirPath) === "open";
}

// When selection changes (initial load, follow-mode auto-switch, user click),
// reveal the path to the selected file by marking its ancestor directories as
// "open" in the same override map a manual click populates. Purely additive:
// we never mark anything closed — if the user later collapses a revealed
// ancestor, that stays collapsed (their next click stores "closed").
function revealSelectedFile() {
  if (!appState.selectedId) {
    return;
  }
  for (const root of appState.roots) {
    const doc = root.docs.find(candidate => candidate.id === appState.selectedId);
    if (!doc) {
      continue;
    }
    const parts = doc.relativePath.split("/").filter(Boolean);
    let current = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = current ? `${current}/${parts[index]}` : parts[index]!;
      appState.dirOverrides.set(current, "open");
    }
    return;
  }
}

function renderNodes(nodes: TreeNode[]): string {
  if (nodes.length === 0) {
    return `<div class="tree-empty">No files in this root.</div>`;
  }

  return `<ul>${nodes
    .map(node => {
      if (node.kind === "dir") {
        const openAttribute = shouldDirRenderOpen(node.path) ? " open" : "";
        const dirMtime = renderTreeMtime(node.mtimeMs);
        return `
          <li class="tree-node tree-dir">
            <details data-dir-path="${escapeHtmlAttribute(node.path)}"${openAttribute}>
              <summary><span class="tree-dir-name">${escapeHtml(node.name)}</span>${dirMtime}</summary>
              ${renderNodes(node.children ?? [])}
            </details>
          </li>
        `;
      }

      const mtimeMarkup = renderTreeMtime(node.mtimeMs);

      if (node.documentKind === "binary") {
        return `
          <li class="tree-node tree-doc">
            <span class="tree-doc-disabled" title="Binary file — not viewable">
              <span class="tree-icon">${fileIconForName(node.name)}</span>
              <span class="tree-label">${escapeHtml(node.name)}</span>
              ${mtimeMarkup}
            </span>
          </li>
        `;
      }

      const isSelected = node.id === appState.selectedId;
      return `
        <li class="tree-node tree-doc">
          <button type="button" class="tree-doc-button${isSelected ? " is-selected" : ""}" data-document-id="${escapeHtmlAttribute(node.id ?? "")}">
            <span class="tree-icon">${fileIconForName(node.name)}</span>
            <span class="tree-label">${escapeHtml(node.name)}</span>
            ${mtimeMarkup}
          </button>
        </li>
      `;
    })
    .join("")}</ul>`;
}

function renderTreeMtime(mtimeMs: number | undefined): string {
  if (mtimeMs === undefined) {
    return "";
  }
  const label = formatRelativeTime(mtimeMs, Date.now());
  return `<span class="tree-mtime" data-mtime="${mtimeMs}">${escapeHtml(label)}</span>`;
}

// Refresh tree-mtime labels every second so they tick visibly. Each pass is a
// DOM walk over ~one span per leaf + per directory; we skip the textContent
// write when the formatted label hasn't changed (most ticks past the first
// minute) so this stays cheap regardless of repo size. The server only
// broadcasts state when fingerprints change, so we can't rely on SSE alone
// to keep these labels fresh.
window.setInterval(() => {
  const now = Date.now();
  document
    .querySelectorAll<HTMLElement>(".tree-mtime[data-mtime]")
    .forEach(element => {
      const mtime = Number(element.dataset.mtime);
      if (!Number.isFinite(mtime)) {
        return;
      }
      const next = formatRelativeTime(mtime, now);
      if (element.textContent !== next) {
        element.textContent = next;
      }
    });
}, 1000);

function renderEmptyPreview(title: string, body: string) {
  previewTitleElement.textContent = title;
  previewPathElement.textContent = body;
  clearPreviewType();
  previewElement.classList.add("empty");
  previewElement.innerHTML = `<p>${escapeHtml(body)}</p>`;
}

function syncFollowToggle() {
  const label = followToggleElement.querySelector<HTMLElement>(".chip-label");
  if (label) {
    label.textContent = "Follow";
  }

  const pinned = appState.scope.kind === "file";
  const pressed = appState.followEnabled && !pinned;
  followToggleElement.setAttribute("aria-pressed", String(pressed));
  followToggleElement.classList.toggle("is-active", pressed);
  followToggleElement.disabled = pinned;
  followToggleElement.title = pinned
    ? "Unpin to re-enable follow mode"
    : pressed
      ? "Follow the latest changed document"
      : "Click to follow the latest changed document";
}

function syncPinToggle() {
  const hasSelection = Boolean(appState.selectedId);
  pinToggleElement.hidden = !hasSelection;

  const pinned = appState.scope.kind === "file";
  pinToggleElement.setAttribute("aria-pressed", String(pinned));
  pinToggleElement.classList.toggle("is-active", pinned);
  pinToggleElement.setAttribute(
    "aria-label",
    pinned ? "Unpin preview from this file" : "Pin preview to this file",
  );
  pinToggleElement.title = pinned ? "Unpin preview" : "Pin preview to this file";

  const label = pinToggleElement.querySelector<HTMLElement>(".chip-label");
  if (label) {
    label.textContent = pinned ? "Pinned" : "Pin";
  }

  syncFollowToggle();
}

function setConnectionState(state: "live" | "reconnecting" | "connecting", label: string) {
  connectionStateElement.classList.remove("is-live", "is-reconnecting", "is-connecting");
  connectionStateElement.classList.add(`is-${state}`);
  connectionLabelElement.textContent = label;
}

function renderBuildBadge(build: BuildSummary) {
  buildBadgeElement.textContent = build.identifier;
  buildBadgeElement.title = build.release
    ? `Release build · ${build.commitSha}`
    : `Dev build on ${build.branch} · ${build.commitSha}`;
}

function initSidebarCollapse() {
  const stored = readCollapsedPreference();
  setSidebarCollapsed(stored, { persist: false });
}

function readCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setSidebarCollapsed(collapsed: boolean, options: { persist?: boolean } = {}) {
  appShellElement.classList.toggle("is-sidebar-collapsed", collapsed);
  sidebarCollapseElement.setAttribute("aria-expanded", String(!collapsed));
  sidebarExpandElement.setAttribute("aria-expanded", String(!collapsed));

  if (options.persist === false) {
    return;
  }

  try {
    if (collapsed) {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    } else {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
    }
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
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
