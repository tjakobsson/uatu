// HTTP adapter for the `/api/github/*` routes. src/server/routes.ts owns the
// route table (keys and methods); each entry delegates to one handler here,
// which validates the request, calls the GithubService seam, and maps a
// GithubError to its status. With no service configured every handler
// answers 404, so a session that did not opt in exposes nothing.

import { renderMarkdownToHtml } from "../render/markdown";
import {
  GITHUB_BODY_MAX_LENGTH,
  isGithubFakeScenario,
  type DiffSide,
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
};

// Bodies are bounded before parsing: the largest legitimate one is a comment
// at GitHub's 65,536-character limit, JSON-escaped.
const MAX_REQUEST_BYTES = GITHUB_BODY_MAX_LENGTH * 6 + 4096;
const NO_STORE = { "cache-control": "no-store" };

class BadRequest extends Error {}

export function githubRouteHandlers(
  getService: () => GithubService | null,
  // Answers a Response when a write must be refused (credentials, origin).
  authorizeWrite: (request: Request) => Response | null,
): GithubRouteHandlers {
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
