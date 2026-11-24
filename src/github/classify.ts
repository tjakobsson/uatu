// What a GitHub answer means (design D2), decided from the status line, the
// headers `gh api --include` prints and GraphQL's `errors[].type`, never from
// `gh`'s stderr. One failure class per request: the service scopes it to the
// section or action that made the request, so a token that can read the pull
// request but not its checks loses the checks, not the pull request.
//
// The classes map onto the summary statuses the UI already explains
// (`statusForFailure`) and onto HTTP statuses for a refused action
// (`httpStatusForFailure`). Only GitHub's own `message`, length-bounded,
// ever reaches a client.

import type { GithubStatus } from "../shared/github-contract";

export type GitHubFailureKind =
  // `gh` isn't on the session's path, or is older than the floor.
  | "gh-missing"
  | "gh-too-old"
  // 401, or `gh` has no login for the host.
  | "no-credential"
  // Primary limit (remaining 0, GraphQL RATE_LIMITED) or a secondary limit
  // (retry-after, "secondary rate limit").
  | "rate-limited"
  // Organization single sign-on (SAML) not authorized for this token.
  | "sso"
  | "forbidden"
  | "not-found"
  // GitHub refused the input (422, GraphQL UNPROCESSABLE and friends).
  | "invalid"
  // GitHub doesn't know a field a pinned query asks for (an older GitHub
  // Enterprise Server, or a removed field).
  | "schema"
  // 5xx, network failure, a malformed answer.
  | "unavailable"
  | "timeout";

export const GITHUB_MESSAGE_MAX = 300;

export class GitHubFailure extends Error {
  constructor(
    readonly kind: GitHubFailureKind,
    message: string,
    readonly details: { retryAt?: number; httpStatus?: number; operation?: string; githubType?: string } = {},
  ) {
    super(message);
  }
  get retryAt(): number | undefined {
    return this.details.retryAt;
  }
}

export type GitHubResponse = { status: number; headers: Record<string, string>; json: unknown };

export type GraphqlError = { type?: string; message: string; path?: (string | number)[]; code?: string };

// Retry a secondary limit after this when GitHub names no time (its docs: wait
// at least a minute).
const SECONDARY_WAIT_MS = 60_000;

export function boundedMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > GITHUB_MESSAGE_MAX ? `${text.slice(0, GITHUB_MESSAGE_MAX - 1)}…` : text;
}

export function graphqlErrors(json: unknown): GraphqlError[] {
  const errors = (json as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap(error => {
    if (!error || typeof error !== "object") return [];
    const record = error as Record<string, unknown>;
    const extensions = record.extensions as Record<string, unknown> | undefined;
    return [{
      type: typeof record.type === "string" ? record.type : undefined,
      message: boundedMessage(record.message) ?? "GitHub refused the request.",
      path: Array.isArray(record.path) ? record.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number") : undefined,
      code: typeof extensions?.code === "string" ? extensions.code : undefined,
    }];
  });
}

function header(response: GitHubResponse, name: string): string | undefined {
  return response.headers[name];
}

// When the limit lifts: `retry-after` (seconds) wins, then
// `x-ratelimit-reset` (epoch seconds), else a minute from now.
export function rateLimitResetAt(response: GitHubResponse, now: number): number {
  const retryAfter = Number(header(response, "retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000;
  const reset = Number(header(response, "x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0 && reset * 1000 > now) return reset * 1000;
  return now + SECONDARY_WAIT_MS;
}

function restMessage(json: unknown): string | undefined {
  return boundedMessage((json as { message?: unknown } | null)?.message);
}

// The SSO header GitHub sends with a SAML refusal:
// `x-github-sso: required; url=https://github.com/orgs/acme/sso?...`.
function ssoRefusal(response: GitHubResponse, message: string | undefined): boolean {
  return header(response, "x-github-sso")?.startsWith("required") === true || /\bSAML\b|single sign-on/i.test(message ?? "");
}

function isRateLimited(response: GitHubResponse, message: string | undefined): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403 && response.status !== 200) return false;
  return header(response, "x-ratelimit-remaining") === "0" || header(response, "retry-after") !== undefined || /rate limit/i.test(message ?? "");
}

// A non-2xx REST or GraphQL answer, as a failure. Answers null for a 2xx.
export function classifyHttp(response: GitHubResponse, now: number, operation?: string): GitHubFailure | null {
  if (response.status >= 200 && response.status < 300) return null;
  const message = restMessage(response.json) ?? graphqlErrors(response.json)[0]?.message;
  const details = { httpStatus: response.status, operation };
  if (response.status === 401) return new GitHubFailure("no-credential", message ?? "GitHub didn't accept the credential.", details);
  if (isRateLimited(response, message)) {
    return new GitHubFailure("rate-limited", message ?? "GitHub's API rate limit is exhausted.", { ...details, retryAt: rateLimitResetAt(response, now) });
  }
  if (response.status === 403) {
    if (ssoRefusal(response, message)) return new GitHubFailure("sso", message ?? "Single sign-on authorization is required for this organization.", details);
    return new GitHubFailure("forbidden", message ?? "GitHub refused access.", details);
  }
  if (response.status === 404 || response.status === 410) return new GitHubFailure("not-found", message ?? "GitHub found nothing there.", details);
  if (response.status >= 500) return new GitHubFailure("unavailable", message ?? `GitHub answered ${response.status}.`, details);
  return new GitHubFailure("invalid", message ?? `GitHub refused the request (${response.status}).`, details);
}

// A GraphQL error, as a failure. GraphQL's primary rate limit comes back as
// HTTP 200 with a RATE_LIMITED error, so the headers still decide the time.
export function classifyGraphqlError(error: GraphqlError, response: GitHubResponse, now: number, operation?: string): GitHubFailure {
  const details = { httpStatus: response.status, operation, githubType: error.type ?? error.code };
  switch (error.type) {
    case "RATE_LIMITED":
      return new GitHubFailure("rate-limited", error.message, { ...details, retryAt: rateLimitResetAt(response, now) });
    case "FORBIDDEN":
      return new GitHubFailure(ssoRefusal(response, error.message) ? "sso" : "forbidden", error.message, details);
    case "NOT_FOUND":
      return new GitHubFailure("not-found", error.message, details);
    case "INTERNAL":
    case "SERVICE_UNAVAILABLE":
    case "TIMEOUT":
      return new GitHubFailure("unavailable", error.message, details);
  }
  if (error.code === "undefinedField" || error.code === "argumentNotAccepted" || error.code === "undefinedType") {
    return new GitHubFailure("schema", error.message, details);
  }
  if (/rate limit/i.test(error.message)) return new GitHubFailure("rate-limited", error.message, { ...details, retryAt: rateLimitResetAt(response, now) });
  return new GitHubFailure("invalid", error.message, details);
}

// The summary status a failure leaves the repository in.
export function statusForFailure(failure: GitHubFailure): GithubStatus {
  switch (failure.kind) {
    case "gh-missing":
    case "gh-too-old":
      return "gh-missing";
    case "no-credential":
      return "no-credential";
    case "sso":
    case "forbidden":
    case "not-found":
      return "no-access";
    case "rate-limited":
      return "rate-limited";
    case "invalid":
    case "schema":
    case "unavailable":
    case "timeout":
      return "unavailable";
  }
}

// The HTTP status a refused action answers the browser with.
export function httpStatusForFailure(failure: GitHubFailure): number {
  switch (failure.kind) {
    case "no-credential":
      return 401;
    case "sso":
    case "forbidden":
      return 403;
    case "not-found":
      return 404;
    case "invalid":
      return 422;
    case "rate-limited":
      return 429;
    case "gh-missing":
    case "gh-too-old":
    case "schema":
    case "unavailable":
    case "timeout":
      return 503;
  }
}

// What a person reads for a failure: GitHub's own (bounded) message where it
// helps, otherwise uatu's words. Never stderr.
export function failureMessage(failure: GitHubFailure, host: string, now = Date.now()): string {
  switch (failure.kind) {
    case "gh-missing":
      return "The GitHub CLI (gh) isn't on this workspace's path. Install gh 2.0 or newer, then restart the workspace.";
    case "gh-too-old":
      return `${failure.message} uatu needs gh 2.0 or newer.`;
    case "no-credential":
      return `The GitHub CLI isn't signed in to ${host}. Outside a Hub, run gh auth login --hostname ${host}; in a Hub, assign a GitHub CLI credential to this workspace and restart it.`;
    case "sso":
      return `GitHub requires single sign-on authorization for this credential: ${failure.message}`;
    case "forbidden":
      return `GitHub refused access: ${failure.message}`;
    case "not-found":
      return `GitHub found nothing there, or this credential can't see it: ${failure.message}`;
    case "rate-limited": {
      if (!failure.retryAt || failure.retryAt <= now) return "GitHub's API rate limit is exhausted.";
      const minutes = Math.max(1, Math.ceil((failure.retryAt - now) / 60_000));
      return `GitHub's API rate limit is exhausted; it resets in ${minutes} min.`;
    }
    case "schema":
      return "GitHub doesn't recognize part of uatu's query (an older GitHub Enterprise Server?). Open the pull request on GitHub.";
    case "timeout":
      return "GitHub didn't answer in time.";
    case "invalid":
      return failure.message;
    case "unavailable":
      return failure.message || "GitHub didn't answer.";
  }
}
