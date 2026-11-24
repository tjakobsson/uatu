// HTTP adapter for the `/api/github/*` routes. src/server/routes.ts owns the
// route table (keys and methods); each entry delegates to one handler here,
// which validates the request, calls the GithubService seam, and maps a
// GithubError to its status. With no service configured every handler
// answers 404, so a session that did not opt in exposes nothing.
//
// The pull request file view (design D5) reads bytes through the seam and
// classifies and renders them here, with the workspace preview's own
// pipeline (renderDocumentSource): one renderer, one sanitizer. Its relative
// images and links resolve against the path-based blob route
// (`pr-blob/<repoKey>/<n>/<oid>/<path>`), which serves only the pull request's
// current head or base commit, never HTML, under a sandbox CSP.

import { createHash } from "node:crypto";
import path from "node:path";

import { classifyBytes } from "../document/classify";
import { shouldDenyPath } from "../ignore/exposure";
import { renderMarkdownToHtml, SYNTAX_HIGHLIGHT_BYTES_LIMIT } from "../render/markdown";
import { renderDocumentSource, type RenderedDocument } from "../server/render-dispatch";
import {
  GITHUB_BODY_MAX_LENGTH,
  isGithubFakeScenario,
  type DiffSide,
  type PullRequestFileFacts,
  type PullRequestFileRefusal,
  type PullRequestFileRevision,
  type PullRequestRevision,
  type ReviewEvent,
} from "../shared/github-contract";
import { GithubError } from "./error";
import type { GithubService } from "./service";

type RouteRequest = Request & { params?: Record<string, string> };
type Handler = (request: RouteRequest) => Promise<Response>;

export type GithubRouteHandlers = {
  summary: Handler;
  refresh: Handler;
  pullRequest: Handler;
  pullRequests: Handler;
  markdown: Handler;
  comment: Handler;
  createThread: Handler;
  reply: Handler;
  resolve: Handler;
  editPendingComment: Handler;
  deletePendingComment: Handler;
  submitReview: Handler;
  discardReview: Handler;
  devScenario: Handler;
  fetchRefs: Handler;
  pullRequestFile: Handler;
  pullRequestTree: Handler;
  pullRequestBlob: Handler;
};

export type GithubRouteOptions = {
  // The session's repository ids, to map a blob URL's repoKey back to one.
  repositoryIds?: () => readonly string[];
};

// The blob route's short, stable name for a repository (its id is a root
// path, which doesn't belong in a URL).
export function repositoryKey(repositoryId: string): string {
  return createHash("sha256").update(repositoryId).digest("hex").slice(0, 12);
}

// "All files" lists at most this many paths.
export const PULL_REQUEST_TREE_LIMIT = 50_000;
// Rendered payloads keyed by commit, path and view never go stale: a small
// LRU spares re-rendering while a reviewer steps back and forth.
const FILE_CACHE_LIMIT = 200;
// Matched after the session's base path, which the pathname still carries.
const BLOB_PREFIX = "api/github/pr-blob/";
const BLOB_HEADERS = {
  "cache-control": "private, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
};
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp", ".svg": "image/svg+xml",
};

// Bodies are bounded before parsing: the largest legitimate one is a comment
// at GitHub's 65,536-character limit, JSON-escaped.
const MAX_REQUEST_BYTES = GITHUB_BODY_MAX_LENGTH * 6 + 4096;
const NO_STORE = { "cache-control": "no-store" };

class BadRequest extends Error {}

// A file the view can't show from local Git, and why (the client words it).
// A binary or too-large file still names its revision, so the view can
// show an image from the blob route.
class FileRefused extends Error {
  constructor(readonly httpStatus: number, readonly state: PullRequestFileRefusal, message: string, readonly revision?: PullRequestFileRevision) {
    super(message);
  }
}

type FilePayload = RenderedDocument & PullRequestFileFacts;

export function githubRouteHandlers(
  getService: () => GithubService | null,
  // Answers a Response when a write must be refused (credentials, origin).
  authorizeWrite: (request: Request) => Response | null,
  options: GithubRouteOptions = {},
): GithubRouteHandlers {
  // repoKey → repository id, learned from every request naming one, else
  // from the session's repositories.
  const knownKeys = new Map<string, string>();
  const keyOf = (repositoryId: string) => {
    const key = repositoryKey(repositoryId);
    knownKeys.set(key, repositoryId);
    return key;
  };
  const repositoryForKey = (key: string): string | null =>
    knownKeys.get(key) ?? options.repositoryIds?.().find(id => repositoryKey(id) === key) ?? null;
  const fileCache = new Map<string, FilePayload>();
  const remember = (key: string, payload: FilePayload) => {
    fileCache.delete(key);
    fileCache.set(key, payload);
    if (fileCache.size > FILE_CACHE_LIMIT) fileCache.delete(fileCache.keys().next().value!);
  };

  const read = (run: (service: GithubService, url: URL) => Promise<unknown>): Handler => async request => {
    const service = getService();
    if (!service) return notEnabled();
    return respond(() => run(service, new URL(request.url)));
  };
  const write = (run: (service: GithubService, body: Record<string, unknown>, request: RouteRequest) => Promise<unknown>): Handler =>
    async request => {
      const service = getService();
      if (!service) return notEnabled();
      const refused = authorizeWrite(request);
      if (refused) return refused;
      return respond(async () => run(service, await readBody(request), request));
    };

  return {
    summary: read((service, url) => service.summary(repositoryParam(url.searchParams.get("repository")))),
    pullRequest: read((service, url) => service.pullRequest(
      repositoryParam(url.searchParams.get("repository")), numberParam(url.searchParams.get("number")))),
    pullRequests: read((service, url) => service.pullRequests(repositoryParam(url.searchParams.get("repository")))),
    refresh: write((service, body) => service.refresh(repositoryParam(body.repository))),
    // The composer's Preview tab: the same sanitized renderer as posted bodies.
    markdown: write(async (_service, body) => ({ html: renderMarkdownToHtml(bodyText(body.body, true)).html })),
    comment: write((service, body) => service.addComment(repositoryParam(body.repository), numberParam(body.number), bodyText(body.body))),
    createThread: write((service, body) => service.addReviewThread(repositoryParam(body.repository), numberParam(body.number), {
      headOid: stringParam(body.headOid, "headOid"),
      path: stringParam(body.path, "path"),
      line: numberParam(body.line),
      side: sideParam(body.side),
      body: bodyText(body.body),
    })),
    reply: write((service, body, request) => service.replyToThread(
      repositoryParam(body.repository), numberParam(body.number), pathParam(request, "threadId"), bodyText(body.body))),
    resolve: write((service, body, request) => {
      if (typeof body.resolved !== "boolean") throw new BadRequest("resolved must be a boolean");
      return service.setThreadResolved(repositoryParam(body.repository), numberParam(body.number), pathParam(request, "threadId"), body.resolved);
    }),
    editPendingComment: write((service, body, request) => service.editPendingComment(
      repositoryParam(body.repository), numberParam(body.number), pathParam(request, "commentId"), bodyText(body.body))),
    deletePendingComment: write((service, body, request) => service.deletePendingComment(
      repositoryParam(body.repository), numberParam(body.number), pathParam(request, "commentId"))),
    submitReview: write((service, body) => service.submitReview(repositoryParam(body.repository), numberParam(body.number), {
      event: eventParam(body.event),
      body: typeof body.body === "string" ? bodyText(body.body, true) : "",
    })),
    discardReview: write((service, body) => service.discardReview(repositoryParam(body.repository), numberParam(body.number))),
    // The explicit, narrow fetch of a pull request's head (design D7): a
    // credentialed Git write, so it is a write here too.
    fetchRefs: write(async (service, body) => {
      const repositoryId = repositoryParam(body.repository);
      const answer = await service.fetchPullRequestHead(repositoryId, numberParam(body.number));
      keyOf(repositoryId);
      return { mock: service.mock, headOid: answer.headOid };
    }),
    pullRequestTree: read(async (service, url) => {
      const repositoryId = repositoryParam(url.searchParams.get("repository"));
      const number = numberParam(url.searchParams.get("number"));
      const tree = await service.pullRequestTree(repositoryId, number);
      if ("state" in tree) throw new FileRefused(409, "not-fetched", `#${number}'s head isn't fetched yet.`);
      const paths = tree.paths.filter(candidate => !shouldDenyPath(candidate));
      return {
        mock: service.mock,
        headOid: tree.headOid,
        paths: paths.slice(0, PULL_REQUEST_TREE_LIMIT),
        truncated: tree.truncated || paths.length > PULL_REQUEST_TREE_LIMIT,
      };
    }),
    pullRequestFile: read(async (service, url) => {
      const repositoryId = repositoryParam(url.searchParams.get("repository"));
      const number = numberParam(url.searchParams.get("number"));
      const filePath = filePathParam(url.searchParams.get("path"));
      const rev = revParam(url.searchParams.get("rev"));
      const view = url.searchParams.get("view") === "source" ? "source" : "rendered";
      const blob = await service.pullRequestBlob(repositoryId, number, { path: filePath, rev });
      if ("state" in blob) throw new FileRefused(409, "not-fetched", `#${number}'s head isn't fetched yet.`);
      const cacheKey = `${repositoryId}\n${blob.oid}\n${filePath}\n${view}`;
      const cached = fileCache.get(cacheKey);
      if (cached) {
        remember(cacheKey, cached);
        return cached;
      }
      const revision: PullRequestFileRevision = { number, rev, oid: blob.oid, blobBase: `api/github/pr-blob/${keyOf(repositoryId)}/${number}/${blob.oid}/` };
      const name = path.posix.basename(filePath);
      const kind = classifyBytes(name, blob.bytes);
      if (kind === "binary") throw new FileRefused(415, "binary", `${filePath} is a binary file.`, revision);
      if (blob.bytes.length > SYNTAX_HIGHLIGHT_BYTES_LIMIT) throw new FileRefused(413, "too-large", `${filePath} is too large to show here.`, revision);
      const source = new TextDecoder().decode(blob.bytes);
      const lfsPointer = source.startsWith("version https://git-lfs.github.com/spec/v1");
      const rendered = await renderDocumentSource({
        id: `pr:${number}@${blob.oid}:${filePath}`,
        name,
        relativePath: filePath,
        kind: lfsPointer ? "text" : kind,
        source,
      }, view);
      const payload: FilePayload = {
        ...rendered,
        mock: service.mock,
        bytes: blob.bytes.length,
        lfsPointer,
        revision,
      };
      remember(cacheKey, payload);
      return payload;
    }),
    // Raw bytes for a rendered file's images and assets. Only the pull
    // request's current head or base commit is served, never as HTML.
    pullRequestBlob: async request => {
      const service = getService();
      if (!service) return notEnabled();
      try {
        const pathname = new URL(request.url).pathname;
        const at = pathname.indexOf(`/${BLOB_PREFIX}`);
        if (at < 0) throw new GithubError(404, "not found");
        const [key = "", numberText = "", oid = "", ...rest] = pathname.slice(at + BLOB_PREFIX.length + 1).split("/");
        let filePath: string;
        try {
          filePath = filePathParam(rest.map(segment => decodeURIComponent(segment)).join("/"));
        } catch {
          throw new GithubError(404, "not found");
        }
        const repositoryId = repositoryForKey(key);
        if (!repositoryId || !/^[0-9a-f]{7,64}$/i.test(oid)) throw new GithubError(404, "not found");
        const number = numberParam(numberText);
        const pr = (await service.pullRequest(repositoryId, number)).summary;
        const rev: PullRequestRevision | null = oid === pr.headRefOid ? "head" : oid === pr.baseRefOid ? "base" : null;
        if (!rev) throw new GithubError(404, "not found");
        const blob = await service.pullRequestBlob(repositoryId, number, { path: filePath, rev });
        if ("state" in blob) return new Response("Not fetched", { status: 409, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } });
        const extension = path.posix.extname(filePath).toLowerCase();
        const kind = classifyBytes(path.posix.basename(filePath), blob.bytes);
        const type = IMAGE_TYPES[extension] ?? (kind === "binary" ? "application/octet-stream" : "text/plain; charset=utf-8");
        return new Response(blob.bytes as Uint8Array<ArrayBuffer>, { headers: { ...BLOB_HEADERS, "content-type": type } });
      } catch (error) {
        const status = error instanceof GithubError ? error.httpStatus : error instanceof BadRequest ? 404 : 500;
        return new Response(status === 500 ? "GitHub request failed." : "Not found", { status, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } });
      }
    },
    // Dev-only: exists only on the fake, so the real service answers 404.
    devScenario: write(async (service, body) => {
      if (!service.setScenario || !service.reset) throw new GithubError(404, "not found");
      if (body.reset === true) service.reset();
      if (body.scenario !== undefined) {
        if (!isGithubFakeScenario(body.scenario)) throw new BadRequest("unknown scenario");
        service.setScenario(body.scenario);
      }
      return { ok: true };
    }),
  };
}

function notEnabled(): Response {
  return Response.json({ error: "GitHub pull requests are not enabled for this session." }, { status: 404, headers: NO_STORE });
}

async function respond(run: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await run(), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof BadRequest) return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
    if (error instanceof FileRefused) return Response.json({ error: error.message, state: error.state, ...(error.revision ? { revision: error.revision } : {}) }, { status: error.httpStatus, headers: NO_STORE });
    if (error instanceof GithubError) return Response.json({ error: error.message }, { status: error.httpStatus, headers: NO_STORE });
    return Response.json({ error: "GitHub request failed." }, { status: 500, headers: NO_STORE });
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_REQUEST_BYTES) throw new BadRequest("request body too large");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequest("request body is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest("request body must be an object");
  return parsed as Record<string, unknown>;
}

function repositoryParam(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096) throw new BadRequest("missing repository");
  return value;
}

function numberParam(value: unknown): number {
  const number = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new BadRequest("invalid number");
  return number;
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 1024) throw new BadRequest(`invalid ${name}`);
  return value;
}

function bodyText(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string") throw new BadRequest("invalid body");
  if (!allowEmpty && value.trim() === "") throw new BadRequest("The comment is empty.");
  if (value.length > GITHUB_BODY_MAX_LENGTH) throw new BadRequest(`Comments are limited to ${GITHUB_BODY_MAX_LENGTH} characters.`);
  return value;
}

// A repository-relative file path: no absolute or parent segments, and never
// one the exposure deny list hides (VCS metadata, OS litter).
function filePathParam(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > 4096 || value.includes("\0") || value.includes("\\")) throw new BadRequest("invalid path");
  if (value.split("/").some(segment => segment === "" || segment === "." || segment === "..")) throw new BadRequest("invalid path");
  if (shouldDenyPath(value)) throw new GithubError(404, "not found");
  return value;
}

function revParam(value: string | null): PullRequestRevision {
  if (value === null || value === "head") return "head";
  if (value === "base") return "base";
  throw new BadRequest("invalid rev");
}

function sideParam(value: unknown): DiffSide {
  if (value !== "LEFT" && value !== "RIGHT") throw new BadRequest("invalid side");
  return value;
}

function eventParam(value: unknown): ReviewEvent {
  if (value !== "COMMENT" && value !== "APPROVE" && value !== "REQUEST_CHANGES") throw new BadRequest("Choose Comment, Approve or Request changes.");
  return value;
}

function pathParam(request: RouteRequest, name: string): string {
  const value = request.params?.[name];
  if (!value || value.length > 256) throw new BadRequest(`missing ${name}`);
  return value;
}
