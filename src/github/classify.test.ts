import { describe, expect, test } from "bun:test";

import { classifyGraphqlError, classifyHttp, failureMessage, GitHubFailure, httpStatusForFailure, statusForFailure, type GitHubFailureKind } from "./classify";
import type { GithubStatus } from "../shared/github-contract";

const NOW = 1_000_000;
const response = (status: number, headers: Record<string, string> = {}, json: unknown = null) => ({ status, headers, json });

describe("classifyHttp", () => {
  test.each<[number, Record<string, string>, unknown, GitHubFailureKind | null]>([
    [200, {}, {}, null],
    [401, {}, { message: "Bad credentials" }, "no-credential"],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" }, { message: "API rate limit exceeded" }, "rate-limited"],
    [403, { "retry-after": "30" }, { message: "secondary" }, "rate-limited"],
    [403, {}, { message: "You have exceeded a secondary rate limit." }, "rate-limited"],
    [429, {}, { message: "Too many" }, "rate-limited"],
    [403, { "x-github-sso": "required; url=https://github.com/orgs/a/sso" }, { message: "SSO" }, "sso"],
    [403, {}, { message: "Resource not accessible by integration" }, "forbidden"],
    [404, {}, { message: "Not Found" }, "not-found"],
    [422, {}, { message: "Validation Failed" }, "invalid"],
    [502, {}, { message: "Server Error" }, "unavailable"],
  ])("HTTP %i %j", (status, headers, json, kind) => {
    expect(classifyHttp(response(status, headers, json), NOW)?.kind ?? null).toBe(kind);
  });

  test("reset times: retry-after wins, then x-ratelimit-reset, else a minute", () => {
    expect(classifyHttp(response(403, { "retry-after": "30", "x-ratelimit-reset": "5000" }), NOW)?.retryAt).toBe(NOW + 30_000);
    expect(classifyHttp(response(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "5000" }), NOW)?.retryAt).toBe(5_000_000);
    expect(classifyHttp(response(429), NOW)?.retryAt).toBe(NOW + 60_000);
  });
});

describe("classifyGraphqlError", () => {
  test.each<[string | undefined, string | undefined, GitHubFailureKind]>([
    ["RATE_LIMITED", undefined, "rate-limited"],
    ["FORBIDDEN", undefined, "forbidden"],
    ["NOT_FOUND", undefined, "not-found"],
    ["SERVICE_UNAVAILABLE", undefined, "unavailable"],
    [undefined, "undefinedField", "schema"],
    ["UNPROCESSABLE", undefined, "invalid"],
  ])("%s %s", (type, code, kind) => {
    expect(classifyGraphqlError({ type, code, message: "m" }, response(200), NOW).kind).toBe(kind);
  });

  test("a FORBIDDEN that names SAML is an SSO refusal", () => {
    expect(classifyGraphqlError({ type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement." }, response(200), NOW).kind).toBe("sso");
  });
});

describe("statuses and words", () => {
  test.each<[GitHubFailureKind, GithubStatus, number]>([
    ["gh-missing", "gh-missing", 503],
    ["gh-too-old", "gh-missing", 503],
    ["no-credential", "no-credential", 401],
    ["sso", "no-access", 403],
    ["forbidden", "no-access", 403],
    ["not-found", "no-access", 404],
    ["rate-limited", "rate-limited", 429],
    ["invalid", "unavailable", 422],
    ["schema", "unavailable", 503],
    ["unavailable", "unavailable", 503],
    ["timeout", "unavailable", 503],
  ])("%s", (kind, status, http) => {
    const failure = new GitHubFailure(kind, "GitHub said this.");
    expect(statusForFailure(failure)).toBe(status);
    expect(httpStatusForFailure(failure)).toBe(http);
    expect(failureMessage(failure, "github.com", NOW).length).toBeGreaterThan(0);
  });

  test("the words name the host, the floor and the reset", () => {
    expect(failureMessage(new GitHubFailure("no-credential", ""), "ghe.example.com")).toContain("gh auth login --hostname ghe.example.com");
    expect(failureMessage(new GitHubFailure("gh-missing", ""), "github.com")).toContain("gh 2.0 or newer");
    expect(failureMessage(new GitHubFailure("rate-limited", "", { retryAt: NOW + 4 * 60_000 }), "github.com", NOW)).toContain("resets in 4 min");
  });
});
