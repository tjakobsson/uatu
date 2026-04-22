import chokidar from "chokidar";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReadableStreamDefaultController } from "node:stream/web";

import { renderMarkdownToHtml } from "./markdown";
import {
  defaultDocumentId,
  hasDocument,
  type RootGroup,
  type StatePayload,
} from "./shared";

const encoder = new TextEncoder();

const ignoredNames = new Set(["node_modules", "dist", "build"]);
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

export function usageText(version: string): string {
  return `uatu ${version}

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

export async function resolveWatchRoots(inputPaths: string[], cwd: string): Promise<string[]> {
  const resolved = new Set<string>();

  for (const inputPath of inputPaths) {
    const absolutePath = path.resolve(cwd, inputPath);
    let stat;

    try {
      stat = await fs.stat(absolutePath);
    } catch {
      throw new Error(`watch root does not exist: ${inputPath}`);
    }

    if (!stat.isDirectory()) {
      throw new Error(`watch root is not a directory: ${inputPath}`);
    }

    resolved.add(absolutePath);
  }

  return Array.from(resolved).sort((left, right) => left.localeCompare(right));
}

export async function scanRoots(rootPaths: string[]): Promise<RootGroup[]> {
  const roots: RootGroup[] = [];

  for (const rootPath of rootPaths) {
    const docs = await walkMarkdownFiles(rootPath, rootPath);
    roots.push({
      id: rootPath,
      label: path.basename(rootPath) || rootPath,
      path: rootPath,
      docs: docs.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
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

export function createStatePayload(
  roots: RootGroup[],
  initialFollow: boolean,
  changedId: string | null = null,
): StatePayload {
  return {
    roots,
    initialFollow,
    defaultDocumentId: defaultDocumentId(roots),
    changedId: changedId && hasDocument(roots, changedId) ? changedId : null,
    generatedAt: Date.now(),
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

export function createWatchSession(rootPaths: string[], initialFollow: boolean) {
  let roots: RootGroup[] = [];
  let stateFingerprint = "";
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingChangedId: string | null = null;
  const subscribers = new Set<EventController>();

  const watcher = chokidar.watch(rootPaths, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 25,
    },
  });

  const refresh = async (changedId: string | null) => {
    const nextRoots = await scanRoots(rootPaths);
    const nextFingerprint = fingerprintRoots(nextRoots);
    const changedDocumentId = changedId && hasDocument(nextRoots, changedId) ? changedId : null;
    const shouldBroadcast = nextFingerprint !== stateFingerprint || changedDocumentId !== null;

    roots = nextRoots;
    stateFingerprint = nextFingerprint;

    if (shouldBroadcast) {
      broadcast(createStatePayload(roots, initialFollow, changedDocumentId));
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
    const changedId = isMarkdownPath(absolutePath) && eventName !== "unlink" ? absolutePath : null;
    scheduleRefresh(changedId);
  });

  return {
    async start() {
      roots = await scanRoots(rootPaths);
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
    getStatePayload(changedId: string | null = null) {
      return createStatePayload(roots, initialFollow, changedId);
    },
    eventsResponse() {
      let currentSubscriber: EventController | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          currentSubscriber = controller;
          subscribers.add(controller);
          controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(createStatePayload(roots, initialFollow))}\n\n`));
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

  if (name.startsWith(".")) {
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
