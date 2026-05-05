import chokidar from "chokidar";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReadableStreamDefaultController } from "node:stream/web";

import { renderAsciidocToHtml } from "./asciidoc";
import { type DocumentMetadata, sanitizeMetadata } from "./document-metadata";
import { classifyFile } from "./file-classify";
import { languageForName } from "./file-languages";
import { loadIgnoreMatcher, type IgnoreMatcher } from "./ignore-engine";
import { decodeHtmlEntities, renderCodeAsHtml, renderMarkdownToHtml } from "./markdown";
import { collectRepositorySnapshots, safeGit } from "./review-load";
import {
  DEFAULT_MODE,
  defaultDocumentId,
  findDocument,
  hasDocument,
  isMode,
  type BuildSummary,
  type DocumentMeta,
  type Mode,
  type RepositoryReviewSnapshot,
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
const secretFileNames = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".ssh",
  "credentials.json",
  "credential.json",
  "service-account.json",
  "service_account.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const secretFileSuffixes = [".pem", ".key", ".p12", ".pfx"];

export const DEFAULT_PORT = 4312;
export const SERVE_IDLE_TIMEOUT_SECONDS = 0;
export const DEFAULT_RESPECT_GITIGNORE = true;

export type WatchOptions = {
  rootPaths: string[];
  openBrowser: boolean;
  follow: boolean;
  port: number;
  respectGitignore: boolean;
  force: boolean;
  // When the user passes `--mode=author|review`, this is set and takes
  // precedence over the SPA's persisted localStorage preference at boot.
  // Undefined means "no startup override; let the browser decide".
  startupMode?: Mode;
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
  kind: "markdown" | "asciidoc" | "text";
  language: string | null;
  metadata?: DocumentMetadata;
};

export type StaticFileResolution = { status: "found"; filePath: string } | { status: "not-found" };

type EventController = ReadableStreamDefaultController<Uint8Array>;

export function usageText(build: BuildInfo = BUILD): string {
  return `uatu ${formatBuildIdentifier(build)}

Usage:
  uatu watch [PATH...] [--force] [--no-open] [--no-follow] [--no-gitignore] [--mode <MODE>] [--port <PORT>]
  uatu --help
  uatu --version

Options:
  --no-open        Do not open a browser automatically
  --no-follow      Start with follow mode disabled
  --no-gitignore   Do not honor .gitignore patterns when indexing files
  --force          Watch non-git paths anyway; indexing may be slow
  --mode <MODE>    Start in 'author' or 'review' mode (default: persisted browser preference, or 'author')
  -p, --port       Bind the local server to a specific port
  -h, --help       Show help
  -V, --version    Show version
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

export function printIndexingStatus(
  entries: WatchEntry[],
  stream: { isTTY?: boolean; write(chunk: string): unknown } = process.stdout,
): () => void {
  if (!stream.isTTY) {
    return () => undefined;
  }

  const label = entries.length === 1 ? entries[0]!.absolutePath : `${entries.length} watch roots`;
  const message = `Indexing ${label}...`;
  let cleared = false;
  stream.write(message);

  return () => {
    if (cleared) {
      return;
    }
    cleared = true;
    stream.write(`\r${" ".repeat(message.length)}\r`);
  };
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
  let respectGitignore = DEFAULT_RESPECT_GITIGNORE;
  let force = false;
  let startupMode: Mode | undefined;
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

    if (arg === "--no-gitignore") {
      respectGitignore = false;
      continue;
    }

    if (arg === "--force") {
      force = true;
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

    if (arg === "--mode" || arg.startsWith("--mode=")) {
      let value: string | undefined;
      if (arg === "--mode") {
        value = argv[index + 1];
        if (!value) {
          throw new Error("missing value for --mode");
        }
        index += 1;
      } else {
        value = arg.slice("--mode=".length);
      }
      if (!isMode(value)) {
        throw new Error(`invalid --mode value: '${value}' (expected 'author' or 'review')`);
      }
      startupMode = value;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    }

    rootPaths.push(arg);
  }

  // Review mode forces follow off — the UI gates Follow on Mode, and the
  // session-level follow flag is the source of truth that's broadcast to the
  // SPA at boot.
  if (startupMode === "review") {
    follow = false;
  }

  return {
    kind: "watch",
    options: {
      rootPaths: rootPaths.length > 0 ? rootPaths : ["."],
      openBrowser,
      follow,
      port,
      respectGitignore,
      force,
      startupMode,
    },
  };
}

export type WatchEntry =
  | { kind: "dir"; absolutePath: string }
  | { kind: "file"; absolutePath: string; parentDir: string };

export type NonGitWatchEntry = {
  entry: WatchEntry;
};

export async function findNonGitWatchEntries(entries: WatchEntry[]): Promise<NonGitWatchEntry[]> {
  const checked = await Promise.all(entries.map(async entry => {
    const probePath = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
    const result = await safeGit(probePath, ["rev-parse", "--show-toplevel"]);
    return result.ok && result.stdout.trim()
      ? null
      : { entry };
  }));

  return checked.filter((entry): entry is NonGitWatchEntry => Boolean(entry));
}

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

    if (stat.isFile()) {
      if (shouldDenyPath(path.basename(absolutePath))) {
        throw new Error(`watch path is not viewable: ${inputPath}`);
      }

      const kind = await classifyFile(absolutePath, path.basename(absolutePath));
      if (kind === "binary") {
        throw new Error(`watch path is a binary file: ${inputPath}`);
      }
      resolved.set(absolutePath, {
        kind: "file",
        absolutePath,
        parentDir: path.dirname(absolutePath),
      });
      continue;
    }

    throw new Error(`watch path must be a directory or a non-binary file: ${inputPath}`);
  }

  return Array.from(resolved.values()).sort((left, right) =>
    left.absolutePath.localeCompare(right.absolutePath),
  );
}

export type ScanOptions = {
  respectGitignore?: boolean;
  matcherCache?: Map<string, IgnoreMatcher>;
};

export async function scanRoots(
  entries: WatchEntry[],
  options: ScanOptions = {},
): Promise<RootGroup[]> {
  const { respectGitignore = DEFAULT_RESPECT_GITIGNORE, matcherCache } = options;
  const roots: RootGroup[] = [];

  for (const entry of entries) {
    if (entry.kind === "dir") {
      let matcher = matcherCache?.get(entry.absolutePath);
      if (!matcher) {
        matcher = await loadIgnoreMatcher({
          rootPath: entry.absolutePath,
          respectGitignore,
        });
        matcherCache?.set(entry.absolutePath, matcher);
      }

      const walked = await walkAllFiles(entry.absolutePath, entry.absolutePath, matcher);
      roots.push({
        id: entry.absolutePath,
        label: path.basename(entry.absolutePath) || entry.absolutePath,
        path: entry.absolutePath,
        docs: walked.docs.sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath),
        ),
        hiddenCount: walked.hiddenCount,
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
        hiddenCount: 0,
      });
      continue;
    }

    const relativePath = path.basename(entry.absolutePath);
    if (shouldDenyPath(relativePath)) {
      roots.push({
        id: entry.absolutePath,
        label: relativePath,
        path: entry.parentDir,
        docs: [],
        hiddenCount: 1,
      });
      continue;
    }

    const kind = await classifyFile(entry.absolutePath, relativePath);
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
          kind,
        },
      ],
      hiddenCount: 0,
    });
  }

  return roots;
}

export async function renderDocument(roots: RootGroup[], documentId: string): Promise<RenderedDocument> {
  const document = findDocument(roots, documentId);
  if (!document) {
    throw new Error("document not found");
  }

  if (document.kind === "binary") {
    throw new Error("document is binary");
  }

  const source = await fs.readFile(document.id, "utf8");
  const language =
    document.kind === "markdown" || document.kind === "asciidoc"
      ? null
      : languageForName(document.name) ?? null;

  let html: string;
  let metadata: DocumentMetadata | undefined;
  if (document.kind === "markdown") {
    const rendered = renderMarkdownToHtml(source);
    html = rendered.html;
    metadata = sanitizeMetadata(rendered.metadata);
  } else if (document.kind === "asciidoc") {
    const rendered = renderAsciidocToHtml(source);
    html = rendered.html;
    metadata = sanitizeMetadata(rendered.metadata);
  } else {
    html = renderCodeAsHtml(source, language ?? undefined);
    metadata = undefined;
  }

  return {
    id: document.id,
    path: document.relativePath,
    title:
      document.kind === "markdown" || document.kind === "asciidoc"
        ? extractTitle(html, document.name)
        : document.name,
    html,
    kind: document.kind,
    language,
    ...(metadata ? { metadata } : {}),
  };
}

export function canSetFileScope(roots: RootGroup[], documentId: string): boolean {
  const document = findDocument(roots, documentId);
  return Boolean(document && document.kind !== "binary");
}

export function getAssetRoots(entries: WatchEntry[]): string[] {
  return entries.map(entry => (entry.kind === "dir" ? entry.absolutePath : entry.parentDir));
}

export async function resolveStaticFileRequest(
  pathname: string,
  entries: WatchEntry[],
  options: { respectGitignore?: boolean } = {},
): Promise<StaticFileResolution> {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return { status: "not-found" };
  }

  if (decodedPathname.includes("\0")) {
    return { status: "not-found" };
  }

  const relativeUrlPath = decodedPathname.replace(/^\/+/, "");
  if (!relativeUrlPath) {
    return { status: "not-found" };
  }

  const respectGitignore = options.respectGitignore ?? DEFAULT_RESPECT_GITIGNORE;
  const matcherCache = new Map<string, IgnoreMatcher>();

  for (const entry of entries) {
    const rootPath = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
    const candidate = path.resolve(rootPath, relativeUrlPath);
    const relativeToRoot = path.relative(rootPath, candidate);

    if (
      relativeToRoot === "" ||
      relativeToRoot.startsWith("..") ||
      path.isAbsolute(relativeToRoot)
    ) {
      continue;
    }

    const relativeUnix = relativeToRoot.split(path.sep).join("/");
    if (shouldDenyPath(relativeUnix)) {
      continue;
    }

    let matcher = matcherCache.get(rootPath);
    if (!matcher) {
      matcher = await loadIgnoreMatcher({ rootPath, respectGitignore });
      matcherCache.set(rootPath, matcher);
    }

    if (matcher.shouldIgnore(relativeUnix)) {
      continue;
    }

    const stat = await fs.lstat(candidate).catch(() => null);
    if (!stat || !stat.isFile()) {
      continue;
    }

    const rootRealPath = await fs.realpath(rootPath).catch(() => null);
    const candidateRealPath = await fs.realpath(candidate).catch(() => null);
    if (!rootRealPath || !candidateRealPath || !isPathInsideRoot(candidateRealPath, rootRealPath)) {
      continue;
    }

    return { status: "found", filePath: candidateRealPath };
  }

  return { status: "not-found" };
}

export async function staticFileResponse(
  pathname: string,
  entries: WatchEntry[],
  options: { respectGitignore?: boolean } = {},
): Promise<Response | null> {
  const resolved = await resolveStaticFileRequest(pathname, entries, options);
  if (resolved.status !== "found") {
    return null;
  }

  return new Response(Bun.file(resolved.filePath), { headers: { "cache-control": "no-cache" } });
}

// Returns true when the request's Accept header expresses a preference for an
// HTML document over alternatives — the signal browsers send for top-level
// navigations (typed URL, refresh, link click) but not for sub-resource
// fetches (`<img>`, `<script>`, etc.). Treats absent headers and a pure
// `*/*` accept (typical of `curl`) as non-HTML-preferring so power users
// invoking `curl http://host/README.md` still receive raw bytes.
export function prefersHtmlNavigation(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) {
    return false;
  }

  let htmlQuality = 0;
  let otherQuality = 0;

  for (const part of accept.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const [rawType, ...params] = trimmed.split(";");
    const type = (rawType ?? "").trim().toLowerCase();
    if (!type) {
      continue;
    }
    let quality = 1;
    for (const param of params) {
      const trimmedParam = param.trim();
      if (trimmedParam.startsWith("q=")) {
        const parsed = Number.parseFloat(trimmedParam.slice(2));
        if (Number.isFinite(parsed)) {
          quality = parsed;
        }
      }
    }

    if (type === "text/html" || type === "application/xhtml+xml") {
      if (quality > htmlQuality) {
        htmlQuality = quality;
      }
    } else if (type !== "*/*") {
      // `*/*` is intentionally excluded from `otherQuality`: we want
      // `text/html,...,*/*;q=0.8` (every browser navigation) to register as
      // HTML-preferring, and `*/*` alone (curl default) to be excluded
      // entirely — handled by the `htmlQuality > 0` guard below. A
      // contrived header like `text/html;q=0.001,*/*;q=0.99` would,
      // strictly per RFC 9110, prefer the wildcard; we accept that
      // off-spec edge because no real client sends it.
      if (quality > otherQuality) {
        otherQuality = quality;
      }
    }
  }

  return htmlQuality > 0 && htmlQuality >= otherQuality;
}

// Cache the bundled SPA shell HTML on first use so subsequent navigation
// requests can return it without another self-fetch. The bundled HTML is
// reachable via the server's own `/` route (Bun's HTMLBundle handling
// produces it); a one-time real HTTP fetch lifts the body out of that
// route so the catch-all `fetch` handler can serve it for direct-link
// requests too. Caching is safe because the bundle does not change at
// runtime — a rebuild restarts the process.
type ShellCache = { body: string; contentType: string };
const shellCache = new Map<string, ShellCache>();

export async function spaShellResponse(server: {
  hostname?: string | undefined;
  port?: number | undefined;
}): Promise<Response> {
  const hostname = server.hostname ?? "127.0.0.1";
  const port = server.port;
  if (port === undefined) {
    throw new Error("spaShellResponse: server has no port");
  }
  const key = `${hostname}:${port}`;
  const existing = shellCache.get(key);
  if (existing) {
    return new Response(existing.body, {
      headers: {
        "content-type": existing.contentType,
        "cache-control": "no-cache",
      },
    });
  }

  // Network failures here are near-impossible (the server we're calling is
  // ourselves, and we're inside its own request handler) but the catch keeps
  // a single transient blip from poisoning the cache and surfaces a real
  // error to the user instead of a bare 500 with no body.
  let body: string;
  let contentType: string;
  try {
    const fetched = await fetch(`http://${hostname}:${port}/`, {
      headers: { accept: "text/html" },
    });
    if (!fetched.ok) {
      return new Response(`SPA shell unavailable: ${fetched.status}`, { status: 502 });
    }
    body = await fetched.text();
    contentType = fetched.headers.get("content-type") ?? "text/html; charset=utf-8";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`SPA shell unavailable: ${message}`, { status: 502 });
  }

  shellCache.set(key, { body, contentType });
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "no-cache",
    },
  });
}

// The catch-all fetch handler is shared by `cli.ts` (production) and
// `e2e-server.ts` (Playwright). Both need the same Accept-based dispatch
// (HTML-preferring navigations to known viewable docs → SPA shell;
// everything else → static file fallback or 404), and the e2e server's
// roots/entries mutate at runtime via the `/__e2e/reset` endpoint, so the
// helper takes getters rather than captured snapshots.
export function createNavigationFetchHandler(deps: {
  getUnscopedRoots: () => RootGroup[];
  getEntries: () => WatchEntry[];
  getRespectGitignore: () => boolean;
  getServer: () => { hostname?: string | undefined; port?: number | undefined };
}): (request: Request) => Promise<Response> {
  return async request => {
    const requestUrl = new URL(request.url);

    if (prefersHtmlNavigation(request)) {
      const doc = resolveViewableDocument(requestUrl.pathname, deps.getUnscopedRoots());
      if (doc) {
        return await spaShellResponse(deps.getServer());
      }
    }

    const response = await staticFileResponse(requestUrl.pathname, deps.getEntries(), {
      respectGitignore: deps.getRespectGitignore(),
    });
    if (response) {
      return response;
    }

    return new Response("Not Found", { status: 404 });
  };
}

// Resolves a request pathname to a known non-binary document under the
// current root index. Returns `null` for unknown paths, binary files,
// malformed encoding, or paths outside any root. Mirrors the SPA's
// path-to-doc lookup so server-side navigation dispatch stays consistent
// with what the client would do once it boots.
export function resolveViewableDocument(
  pathname: string,
  roots: RootGroup[],
): DocumentMeta | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) {
    return null;
  }

  const relativePath = decoded.replace(/^\/+/, "");
  if (!relativePath) {
    return null;
  }

  for (const root of roots) {
    const doc = root.docs.find(candidate => candidate.relativePath === relativePath);
    if (doc && doc.kind !== "binary") {
      return doc;
    }
  }
  return null;
}

export function createStatePayload(
  roots: RootGroup[],
  initialFollow: boolean,
  changedId: string | null = null,
  scope: Scope = { kind: "folder" },
  repositories: RepositoryReviewSnapshot[] = [],
  startupMode?: Mode,
): StatePayload {
  return {
    roots,
    repositories,
    initialFollow,
    defaultDocumentId: defaultDocumentId(roots),
    changedId: changedId && hasDocument(roots, changedId) ? changedId : null,
    generatedAt: Date.now(),
    build: BUILD_SUMMARY,
    scope,
    ...(startupMode ? { startupMode } : {}),
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
  respectGitignore?: boolean;
  startupMode?: Mode;
};

// Builds the predicate chokidar consults to decide whether to attach a native
// watcher to a path. Two layers:
//   1. Always exclude any path with a `.git` segment between it and a watched
//      root. `.git/` is git's working metadata; transient files inside it
//      (notably `.git/index.lock`) race with native fs.watch on macOS and
//      crash the process with EINVAL when chokidar emits an unhandled error.
//      This is the ONLY hardcoded directory we filter here — the broader
//      indexer denylist (`node_modules`, `.next`, etc.) is intentionally NOT
//      mirrored, because in the typical case it's already covered by the
//      user's `.gitignore` and spreading the heuristic into the watcher
//      would deepen an existing hack rather than minimize it.
//   2. Defer to the per-root IgnoreMatcher (built from .uatuignore /
//      .gitignore) for everything else.
export function buildWatcherIgnorePredicate(
  dirRoots: string[],
  matcherCache: Map<string, IgnoreMatcher>,
): (testPath: string) => boolean {
  return (testPath: string): boolean => {
    for (const rootPath of dirRoots) {
      const rel = path.relative(rootPath, testPath);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        continue;
      }
      if (rel.split(path.sep).includes(".git")) {
        return true;
      }
      const matcher = matcherCache.get(rootPath);
      if (!matcher) {
        continue;
      }
      return matcher.toChokidarIgnored()(testPath);
    }
    return false;
  };
}

// Without an `error` listener, chokidar's underlying EventEmitter throws
// synchronously when an "error" event fires — taking the host process down.
// Real-world failures we have seen include `EINVAL` from a `watch` syscall
// against `.git/index.lock` after git unlinks it. The contract here is
// "process does not crash"; logging policy is intentionally minimal.
export function attachWatcherCrashGuard(emitter: NodeJS.EventEmitter): void {
  emitter.on("error", err => {
    const code =
      err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string"
        ? ` (${(err as NodeJS.ErrnoException).code})`
        : "";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`uatu: watcher error${code}: ${message}`);
  });
}

export function createWatchSession(
  entries: WatchEntry[],
  initialFollow: boolean,
  options: WatchSessionOptions = {},
) {
  const respectGitignore = options.respectGitignore ?? DEFAULT_RESPECT_GITIGNORE;
  const startupMode = options.startupMode;
  let roots: RootGroup[] = [];
  let repositories: RepositoryReviewSnapshot[] = [];
  // The unscoped index holds every viewable doc under the watched roots,
  // ignoring the current pin. Server-side direct-link dispatch consults this
  // so a navigation to `/guides/setup.md` while pinned to `README.md` still
  // returns the SPA shell — the SPA then renders a "session pinned" message
  // (see design D4) instead of the request looking like a 404.
  let unscopedRoots: RootGroup[] = [];
  let stateFingerprint = "";
  let scope: Scope = { kind: "folder" };
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingChangedId: string | null = null;
  const subscribers = new Set<EventController>();
  const matcherCache = new Map<string, IgnoreMatcher>();

  const watchPaths = entries.map(entry => entry.absolutePath);
  const dirRoots = entries.filter(entry => entry.kind === "dir").map(entry => entry.absolutePath);

  const isPathIgnored = buildWatcherIgnorePredicate(dirRoots, matcherCache);

  let watcher: ReturnType<typeof chokidar.watch> | null = null;

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
    const nextRoots = await scanRoots(entries, { respectGitignore, matcherCache });
    const nextRepositories = await collectRepositorySnapshots(entries, nextRoots).catch(error => {
      console.error(`uatu: failed to refresh git review data: ${error instanceof Error ? error.message : String(error)}`);
      return repositories;
    });

    if (scope.kind === "file" && !hasDocument(nextRoots, scope.documentId)) {
      scope = { kind: "folder" };
    }

    const visibleRoots = applyScope(nextRoots);
    const nextFingerprint = createStateFingerprint(visibleRoots, nextRepositories);
    const changedDoc = changedId ? findDocument(visibleRoots, changedId) : undefined;
    const changedDocumentId =
      changedDoc && changedDoc.kind !== "binary" ? changedId : null;
    const shouldBroadcast = nextFingerprint !== stateFingerprint || changedDocumentId !== null;

    roots = visibleRoots;
    unscopedRoots = nextRoots;
    repositories = nextRepositories;
    stateFingerprint = nextFingerprint;

    if (shouldBroadcast) {
      broadcast(createStatePayload(roots, initialFollow, changedDocumentId, scope, repositories, startupMode));
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

  const handleWatcherEvent = (eventName: string, filePath: string) => {
    const absolutePath = path.resolve(filePath);

    // A root's `.uatuignore`/`.gitignore` itself just changed — drop the cached
    // matcher so the upcoming scanRoots call rebuilds it from the new rules.
    const baseName = path.basename(absolutePath);
    if (baseName === ".uatuignore" || baseName === ".gitignore") {
      const parentDir = path.dirname(absolutePath);
      if (dirRoots.includes(parentDir)) {
        matcherCache.delete(parentDir);
      }
    }

    if (scope.kind === "file" && eventName === "unlink" && absolutePath === scope.documentId) {
      scope = { kind: "folder" };
      scheduleRefresh(null);
      return;
    }

    if (scope.kind === "file" && absolutePath !== scope.documentId) {
      return;
    }

    // Eligibility for follow is decided after the upcoming refresh — by then
    // the rescanned roots tell us whether the path is text or binary.
    const changedId = eventName !== "unlink" ? absolutePath : null;
    scheduleRefresh(changedId);
  };

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
      // Pre-load matchers so the chokidar `ignored` predicate has something to
      // consult during the watcher's very first stat sweep. The cache is also
      // threaded into every subsequent scanRoots call so we don't re-read
      // `.uatuignore` / `.gitignore` on every refresh.
      for (const rootPath of dirRoots) {
        const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore });
        matcherCache.set(rootPath, matcher);
      }

      watcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        usePolling: options.usePolling ?? false,
        interval: 100,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 25,
        },
        ignored: isPathIgnored,
      });

      const watcherReady = new Promise<void>(resolve => {
        watcher!.once("ready", () => {
          resolve();
        });
      });

      watcher.on("all", handleWatcherEvent);
      attachWatcherCrashGuard(watcher);

      await watcherReady;
      const scanned = await scanRoots(entries, { respectGitignore, matcherCache });
      repositories = await collectRepositorySnapshots(entries, scanned).catch(error => {
        console.error(`uatu: failed to initialize git review data: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      unscopedRoots = scanned;
      roots = applyScope(scanned);
      stateFingerprint = createStateFingerprint(roots, repositories);
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
      return watcher ? watcher.close() : Promise.resolve();
    },
    getRoots() {
      return roots;
    },
    getUnscopedRoots() {
      return unscopedRoots;
    },
    getScope() {
      return scope;
    },
    getRepositories() {
      return repositories;
    },
    // Test-only handle: lets the regression suite emit synthetic chokidar
    // errors against the real underlying watcher to verify the crash guard.
    // Not part of the production API surface.
    _internalWatcher(): NodeJS.EventEmitter | null {
      return watcher;
    },
    setScope,
    getStatePayload(changedId: string | null = null) {
      return createStatePayload(roots, initialFollow, changedId, scope, repositories, startupMode);
    },
    eventsResponse() {
      let currentSubscriber: EventController | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          currentSubscriber = controller;
          subscribers.add(controller);
          controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(createStatePayload(roots, initialFollow, null, scope, repositories, startupMode))}\n\n`));
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

type WalkResult = { docs: DocumentMeta[]; hiddenCount: number };

async function walkAllFiles(
  rootPath: string,
  currentPath: string,
  matcher: IgnoreMatcher,
): Promise<WalkResult> {
  const dirEntries = await fs.readdir(currentPath, { withFileTypes: true });
  const docs: DocumentMeta[] = [];
  let hiddenCount = 0;

  for (const entry of dirEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (shouldIgnoreEntry(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentPath, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    const relativeFromRoot = path
      .relative(rootPath, absolutePath)
      .split(path.sep)
      .join("/");

    if (matcher.shouldIgnore(relativeFromRoot)) {
      // Count files we filter out via the user-controlled matcher. Directories
      // count as one (we don't recurse to count their contents — that would
      // defeat the point of the matcher's perf benefit).
      hiddenCount += 1;
      continue;
    }

    if (entry.isDirectory()) {
      const sub = await walkAllFiles(rootPath, absolutePath, matcher);
      docs.push(...sub.docs);
      hiddenCount += sub.hiddenCount;
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const stat = await fs.stat(absolutePath);
    const kind = await classifyFile(absolutePath, entry.name);
    docs.push({
      id: absolutePath,
      name: entry.name,
      relativePath: relativeFromRoot,
      mtimeMs: stat.mtimeMs,
      rootId: rootPath,
      kind,
    });
  }

  return { docs, hiddenCount };
}

function shouldIgnoreEntry(name: string): boolean {
  if (ignoredNames.has(name)) {
    return true;
  }

  return hiddenFileSuffixes.some(suffix => name.endsWith(suffix)) || isSecretName(name);
}

function shouldDenyPath(relativePath: string): boolean {
  return relativePath.split("/").some(part => shouldIgnoreEntry(part));
}

function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    secretFileNames.has(lower) ||
    lower.startsWith(".env.") ||
    lower.endsWith("-credentials.json") ||
    lower.endsWith("_credentials.json") ||
    lower.includes("private-key") ||
    lower.includes("private_key") ||
    secretFileSuffixes.some(suffix => lower.endsWith(suffix))
  );
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Pull the title from the FIRST `<h1>` in the rendered HTML rather than from
// the raw Markdown source. Two reasons:
//   1) The previous source-side regex was unaware of fenced code blocks, so a
//      `# Lockfiles` comment inside a fenced ` ```gitignore ` block would win
//      over the actual document heading.
//   2) Working off rendered HTML lets us pick up GitHub-style centered hero
//      headings (`<h1 align="center">…</h1>`), which Markdown source regex
//      can't see.
// The HTML is already sanitized — `<h1>` survives, `<script>`/etc. don't.
function extractTitle(html: string, fallbackName: string): string {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (match?.[1]) {
    const text = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, "")).trim();
    if (text) {
      return text;
    }
  }

  return fallbackName.replace(/\.(md|markdown|adoc|asciidoc)$/i, "");
}

function fingerprintRoots(roots: RootGroup[]): string {
  return JSON.stringify(
    roots.map(root => ({
      id: root.id,
      docs: root.docs.map(doc => ({
        id: doc.id,
        relativePath: doc.relativePath,
        mtimeMs: doc.mtimeMs,
        kind: doc.kind,
      })),
    })),
  );
}

function createStateFingerprint(roots: RootGroup[], repositories: RepositoryReviewSnapshot[]): string {
  return `${fingerprintRoots(roots)}\n${fingerprintRepositories(repositories)}`;
}

function fingerprintRepositories(repositories: RepositoryReviewSnapshot[]): string {
  return JSON.stringify(
    repositories.map(repository => ({
      id: repository.id,
      rootPath: repository.rootPath,
      watchedRootIds: repository.watchedRootIds,
      metadata: repository.metadata,
      reviewLoad: repository.reviewLoad,
      commitLog: repository.commitLog.map(commit => ({
        sha: commit.sha,
        subject: commit.subject,
        message: commit.message,
        author: commit.author,
      })),
    })),
  );
}
