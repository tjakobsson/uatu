import chokidar from "chokidar";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReadableStreamDefaultController } from "node:stream/web";

import { renderMarkdownToHtml } from "./markdown";
import {
  defaultDocumentId,
  hasDocument,
  type BuildSummary,
  type RootGroup,
  type Scope,
  type StatePayload,
} from "./shared";
import { BUILD, formatBuildIdentifier, type BuildInfo } from "./version";

export const BUILD_SUMMARY: BuildSummary = {
  version: BUILD.version,
  branch: BUILD.branch,
  commitSha: BUILD.commitSha,
  commitShort: BUILD.commitShort,
  release: BUILD.release,
  identifier: formatBuildIdentifier(BUILD),
};

const encoder = new TextEncoder();

// Directories and files to skip during the markdown scan. Unlike a blanket
// "ignore anything starting with a dot" rule, this is an explicit denylist: we
// DO want to surface markdown inside things like `.github/`, `.claude/`,
// `.openspec/`, etc., and we only want to hide the well-known junk.
const ignoredNames = new Set([
  // Node / JS output
  "node_modules",
  "dist",
  "build",
  "coverage",
  // Version control
  ".git",
  ".svn",
  ".hg",
  // OS metadata
  ".DS_Store",
  "Thumbs.db",
  // Build / framework caches
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".vercel",
  ".output",
  ".nitro",
  ".svelte-kit",
  ".astro",
  // Python
  ".venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  // JVM
  ".gradle",
  ".m2",
  // Package managers
  ".npm",
  ".yarn",
  ".pnpm-store",
  // Infra
  ".terraform",
  ".serverless",
]);
const hiddenFileSuffixes = [".swp", ".tmp", ".temp", "~"];

export const DEFAULT_PORT = 4312;
export const SERVE_IDLE_TIMEOUT_SECONDS = 0;

export type WatchOptions = {
  rootPaths: string[];
  openBrowser: boolean;
  follow: boolean;
  port: number;
};

export type ParsedCommand =
  | { kind: "watch"; options: WatchOptions }
  | { kind: "help" }
  | { kind: "version" };

export type RenderedDocument = {
  id: string;
  title: string;
  path: string;
  html: string;
};

type EventController = ReadableStreamDefaultController<Uint8Array>;

export function usageText(build: BuildInfo = BUILD): string {
  return `uatu ${formatBuildIdentifier(build)}

Usage:
  uatu watch [PATH...] [--no-open] [--no-follow] [--port <PORT>]
  uatu --help
  uatu --version

Options:
  --no-open       Do not open a browser automatically
  --no-follow     Start with follow mode disabled
  -p, --port      Bind the local server to a specific port
  -h, --help      Show help
  -V, --version   Show version
`;
}

export function versionText(build: BuildInfo = BUILD): string {
  return formatBuildIdentifier(build);
}

export const STARTUP_BANNER = `\
██╗   ██╗ █████╗ ████████╗██╗   ██╗
██║   ██║██╔══██╗╚══██╔══╝██║   ██║
██║   ██║███████║   ██║   ██║   ██║
██║   ██║██╔══██║   ██║   ██║   ██║
╚██████╔╝██║  ██║   ██║   ╚██████╔╝
 ╚═════╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝

I observe. I follow. I render.`;

export function printStartupBanner(
  stream: { isTTY?: boolean; write(chunk: string): unknown } = process.stdout,
): void {
  if (!stream.isTTY) {
    return;
  }

  stream.write(`\n${STARTUP_BANNER}\n\n`);
}

export function parseCommand(argv: string[]): ParsedCommand {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    return { kind: "help" };
  }

  if (argv[0] === "-V" || argv[0] === "--version") {
    return { kind: "version" };
  }

  if (argv[0] !== "watch") {
    throw new Error(`unknown command: ${argv[0]}`);
  }

  let openBrowser = true;
  let follow = true;
  let port = DEFAULT_PORT;
  const rootPaths: string[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--no-open") {
      openBrowser = false;
      continue;
    }

    if (arg === "--no-follow") {
      follow = false;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      return { kind: "help" };
    }

    if (arg === "-V" || arg === "--version") {
      return { kind: "version" };
    }

    if (arg === "-p" || arg === "--port") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("missing value for --port");
      }

      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`invalid port: ${value}`);
      }

      port = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    }

    rootPaths.push(arg);
  }

  return {
    kind: "watch",
    options: {
      rootPaths: rootPaths.length > 0 ? rootPaths : ["."],
      openBrowser,
      follow,
      port,
    },
  };
}

export type WatchEntry =
  | { kind: "dir"; absolutePath: string }
  | { kind: "file"; absolutePath: string; parentDir: string };

export async function resolveWatchRoots(inputPaths: string[], cwd: string): Promise<WatchEntry[]> {
  const resolved = new Map<string, WatchEntry>();

  for (const inputPath of inputPaths) {
    const absolutePath = path.resolve(cwd, inputPath);
    let stat;

    try {
      stat = await fs.stat(absolutePath);
    } catch {
      throw new Error(`watch root does not exist: ${inputPath}`);
    }

    if (stat.isDirectory()) {
      resolved.set(absolutePath, { kind: "dir", absolutePath });
      continue;
    }

    if (stat.isFile() && isMarkdownPath(absolutePath)) {
      resolved.set(absolutePath, {
        kind: "file",
        absolutePath,
        parentDir: path.dirname(absolutePath),
      });
      continue;
    }

    throw new Error(`watch path must be a directory or a Markdown file: ${inputPath}`);
  }

  return Array.from(resolved.values()).sort((left, right) =>
    left.absolutePath.localeCompare(right.absolutePath),
  );
}

export async function scanRoots(entries: WatchEntry[]): Promise<RootGroup[]> {
  const roots: RootGroup[] = [];

  for (const entry of entries) {
    if (entry.kind === "dir") {
      const docs = await walkMarkdownFiles(entry.absolutePath, entry.absolutePath);
      roots.push({
        id: entry.absolutePath,
        label: path.basename(entry.absolutePath) || entry.absolutePath,
        path: entry.absolutePath,
        docs: docs.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
      });
      continue;
    }

    const stat = await fs.stat(entry.absolutePath).catch(() => null);
    if (!stat) {
      roots.push({
        id: entry.absolutePath,
        label: path.basename(entry.absolutePath),
        path: entry.parentDir,
        docs: [],
      });
      continue;
    }

    const relativePath = path.basename(entry.absolutePath);
    roots.push({
      id: entry.absolutePath,
      label: relativePath,
      path: entry.parentDir,
      docs: [
        {
          id: entry.absolutePath,
          name: relativePath,
          relativePath,
          mtimeMs: stat.mtimeMs,
          rootId: entry.absolutePath,
        },
      ],
    });
  }

  return roots;
}

export async function renderDocument(roots: RootGroup[], documentId: string): Promise<RenderedDocument> {
  const document = roots.flatMap(root => root.docs).find(doc => doc.id === documentId);
  if (!document) {
    throw new Error("document not found");
  }

  const source = await fs.readFile(document.id, "utf8");

  return {
    id: document.id,
    path: document.relativePath,
    title: extractTitle(source, document.name),
    html: renderMarkdownToHtml(source),
  };
}

export function getAssetRoots(entries: WatchEntry[]): string[] {
  return entries.map(entry => (entry.kind === "dir" ? entry.absolutePath : entry.parentDir));
}

/**
 * Translate a URL pathname (e.g. `/docs/hero.svg`) into the set of absolute
 * filesystem paths it could map to across the asset roots, in root order.
 * Used by the server's static file fallback so documents can reference
 * adjacent files with normal relative URLs: the caller stats each candidate
 * and serves the first one that exists, falling through to 404 only when no
 * root contains the file. Paths that escape every root via `..` yield `[]`.
 */
export function resolveWatchedFileCandidates(pathname: string, assetRoots: string[]): string[] {
  if (!pathname) {
    return [];
  }

  const relative = pathname.replace(/^\/+/, "");
  if (relative === "") {
    return [];
  }

  const candidates: string[] = [];
  for (const root of assetRoots) {
    const candidate = path.resolve(root, relative);
    const relativeToRoot = path.relative(root, candidate);
    if (
      relativeToRoot === "" ||
      (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))
    ) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

export function createStatePayload(
  roots: RootGroup[],
  initialFollow: boolean,
  changedId: string | null = null,
  scope: Scope = { kind: "folder" },
): StatePayload {
  return {
    roots,
    initialFollow,
    defaultDocumentId: defaultDocumentId(roots),
    changedId: changedId && hasDocument(roots, changedId) ? changedId : null,
    generatedAt: Date.now(),
    build: BUILD_SUMMARY,
    scope,
  };
}

export async function openBrowser(url: string): Promise<boolean> {
  const platform = process.platform;
  let command = "";
  let args: string[] = [];

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  return await new Promise(resolve => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", () => resolve(false));
    child.unref();
    resolve(true);
  });
}

export type WatchSessionOptions = {
  usePolling?: boolean;
};

export function createWatchSession(
  entries: WatchEntry[],
  initialFollow: boolean,
  options: WatchSessionOptions = {},
) {
  let roots: RootGroup[] = [];
  let stateFingerprint = "";
  let scope: Scope = { kind: "folder" };
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingChangedId: string | null = null;
  const subscribers = new Set<EventController>();

  const watchPaths = entries.map(entry => entry.absolutePath);
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    usePolling: options.usePolling ?? false,
    interval: 100,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 25,
    },
  });
  const watcherReady = new Promise<void>(resolve => {
    watcher.once("ready", () => {
      resolve();
    });
  });

  const applyScope = (source: RootGroup[]): RootGroup[] => {
    if (scope.kind === "folder") {
      return source;
    }

    const pinnedId = scope.documentId;
    const pinnedRoots: RootGroup[] = [];

    for (const root of source) {
      const doc = root.docs.find(candidate => candidate.id === pinnedId);
      if (!doc) {
        continue;
      }

      pinnedRoots.push({
        ...root,
        docs: [doc],
      });
    }

    return pinnedRoots;
  };

  const refresh = async (changedId: string | null) => {
    const nextRoots = await scanRoots(entries);

    if (scope.kind === "file" && !hasDocument(nextRoots, scope.documentId)) {
      scope = { kind: "folder" };
    }

    const visibleRoots = applyScope(nextRoots);
    const nextFingerprint = fingerprintRoots(visibleRoots);
    const changedDocumentId = changedId && hasDocument(visibleRoots, changedId) ? changedId : null;
    const shouldBroadcast = nextFingerprint !== stateFingerprint || changedDocumentId !== null;

    roots = visibleRoots;
    stateFingerprint = nextFingerprint;

    if (shouldBroadcast) {
      broadcast(createStatePayload(roots, initialFollow, changedDocumentId, scope));
    }
  };

  const scheduleRefresh = (changedId: string | null) => {
    if (changedId) {
      pendingChangedId = changedId;
    }

    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(() => {
      const nextChangedId = pendingChangedId;
      pendingChangedId = null;
      void refresh(nextChangedId).catch(error => {
        console.error(`uatu: failed to refresh state: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 150);
  };

  watcher.on("all", (eventName, filePath) => {
    const absolutePath = path.resolve(filePath);

    if (scope.kind === "file" && eventName === "unlink" && absolutePath === scope.documentId) {
      scope = { kind: "folder" };
      scheduleRefresh(null);
      return;
    }

    if (scope.kind === "file" && absolutePath !== scope.documentId) {
      return;
    }

    const changedId = isMarkdownPath(absolutePath) && eventName !== "unlink" ? absolutePath : null;
    scheduleRefresh(changedId);
  });

  const setScope = (next: Scope): Scope => {
    if (next.kind === "file") {
      if (scope.kind === "file" && scope.documentId === next.documentId) {
        return scope;
      }
      scope = { kind: "file", documentId: next.documentId };
    } else {
      if (scope.kind === "folder") {
        return scope;
      }
      scope = { kind: "folder" };
    }

    scheduleRefresh(null);
    return scope;
  };

  return {
    async start() {
      await watcherReady;
      const scanned = await scanRoots(entries);
      roots = applyScope(scanned);
      stateFingerprint = fingerprintRoots(roots);
      reconcileTimer = setInterval(() => {
        void refresh(null).catch(error => {
          console.error(`uatu: failed to reconcile state: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, 5000);
    },
    stop() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }

      if (reconcileTimer) {
        clearInterval(reconcileTimer);
      }

      for (const subscriber of subscribers) {
        try {
          subscriber.close();
        } catch {
          // The browser may already have closed the SSE stream.
        }
      }

      subscribers.clear();
      return watcher.close();
    },
    getRoots() {
      return roots;
    },
    getScope() {
      return scope;
    },
    setScope,
    getStatePayload(changedId: string | null = null) {
      return createStatePayload(roots, initialFollow, changedId, scope);
    },
    eventsResponse() {
      let currentSubscriber: EventController | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          currentSubscriber = controller;
          subscribers.add(controller);
          controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(createStatePayload(roots, initialFollow, null, scope))}\n\n`));
        },
        cancel() {
          if (currentSubscriber) {
            subscribers.delete(currentSubscriber);
            currentSubscriber = null;
          }
        },
      });

      return new Response(stream, {
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        },
      });
    },
  };

  function broadcast(payload: StatePayload) {
    const message = encoder.encode(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);

    for (const subscriber of subscribers) {
      try {
        subscriber.enqueue(message);
      } catch {
        subscribers.delete(subscriber);
      }
    }
  }
}

async function walkMarkdownFiles(rootPath: string, currentPath: string) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const docs = [] as RootGroup[number]["docs"];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (shouldIgnoreEntry(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentPath, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      docs.push(...(await walkMarkdownFiles(rootPath, absolutePath)));
      continue;
    }

    if (!entry.isFile() || !isMarkdownPath(entry.name)) {
      continue;
    }

    const stat = await fs.stat(absolutePath);
    docs.push({
      id: absolutePath,
      name: entry.name,
      relativePath: path.relative(rootPath, absolutePath).split(path.sep).join("/"),
      mtimeMs: stat.mtimeMs,
      rootId: rootPath,
    });
  }

  return docs;
}

function shouldIgnoreEntry(name: string): boolean {
  if (ignoredNames.has(name)) {
    return true;
  }

  return hiddenFileSuffixes.some(suffix => name.endsWith(suffix));
}

function isMarkdownPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function extractTitle(source: string, fallbackName: string): string {
  const match = source.match(/^#\s+(.+)$/m);
  if (match?.[1]) {
    return match[1].trim();
  }

  return fallbackName.replace(/\.(md|markdown)$/i, "");
}

function fingerprintRoots(roots: RootGroup[]): string {
  return JSON.stringify(
    roots.map(root => ({
      id: root.id,
      docs: root.docs.map(doc => ({
        id: doc.id,
        relativePath: doc.relativePath,
        mtimeMs: doc.mtimeMs,
      })),
    })),
  );
}
