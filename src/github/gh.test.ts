// The `gh api` transport against a fake `gh` executable (design D15): a shell
// script in a temporary directory that records its argv and stdin and
// replays canned stdout, stderr, an exit code or a delay. The real `gh` is
// never run: every transport here names the fake explicitly, except the
// missing-binary case, whose PATH is an empty directory.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { GitHubApi } from "./api";
import { GitHubFailure } from "./classify";
import { GhTransport, ghArgs, parseIncludeOutput, REST_API_VERSION, type GitHubRequest } from "./gh";

const root = mkdtempSync(path.join(os.tmpdir(), "uatu-fake-gh-"));
const bin = path.join(root, "bin");
const state = path.join(root, "state");
const ghPath = path.join(bin, "gh");
mkdirSync(bin);
mkdirSync(state);
writeFileSync(ghPath, `#!/bin/sh
PATH=/usr/bin:/bin
d="$FAKE_GH_DIR"
if [ "$1" = "--version" ]; then cat "$d/version"; exit 0; fi
for a in "$@"; do printf '%s\\n' "$a" >> "$d/argv"; done
printf -- '--\\n' >> "$d/argv"
cat > "$d/stdin"
if [ -f "$d/sleep" ]; then exec sleep "$(cat "$d/sleep")"; fi
if [ -f "$d/stdout" ]; then cat "$d/stdout"; fi
if [ -f "$d/stderr" ]; then cat "$d/stderr" >&2; fi
exit "$(cat "$d/exit" 2>/dev/null || echo 0)"
`);
chmodSync(ghPath, 0o755);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function script(options: { stdout?: string; stderr?: string; exit?: number; sleep?: number; version?: string }) {
  for (const name of ["argv", "stdin", "stdout", "stderr", "exit", "sleep"]) rmSync(path.join(state, name), { force: true });
  writeFileSync(path.join(state, "version"), options.version ?? "gh version 2.105.0 (2026-11-18)\nhttps://github.com/cli/cli/releases/tag/v2.105.0\n");
  if (options.stdout !== undefined) writeFileSync(path.join(state, "stdout"), options.stdout);
  if (options.stderr !== undefined) writeFileSync(path.join(state, "stderr"), options.stderr);
  if (options.exit !== undefined) writeFileSync(path.join(state, "exit"), String(options.exit));
  if (options.sleep !== undefined) writeFileSync(path.join(state, "sleep"), String(options.sleep));
}

function transport(extra: Partial<ConstructorParameters<typeof GhTransport>[0]> = {}) {
  return new GhTransport({ ghPath, env: { FAKE_GH_DIR: state, PATH: bin }, ...extra });
}

function recordedArgv(): string[][] {
  const text = existsSync(path.join(state, "argv")) ? readFileSync(path.join(state, "argv"), "utf8") : "";
  return text.split("--\n").filter(Boolean).map(block => block.split("\n").filter(Boolean));
}

function include(status: string, headers: Record<string, string>, body: unknown): string {
  return `HTTP/2.0 ${status}\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n${JSON.stringify(body)}`;
}

const graphql = (variables: Record<string, unknown> = {}): GitHubRequest => ({
  kind: "graphql", host: "github.com", operation: "UatuTest", query: "query UatuTest { viewer { login } }", variables,
});

beforeEach(() => script({ stdout: include("200 OK", { "X-Ratelimit-Remaining": "4999" }, { data: { viewer: { login: "octo" } } }) }));

describe("GhTransport invocation", () => {
  test("runs `gh api graphql` with --hostname, --include and the variables on stdin only", async () => {
    const body = "@/etc/passwd\n-F x=@secret `rm -rf /` $(whoami) ; | & \"quoted\"";
    const response = await transport().request(graphql({ input: { body } }));
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ data: { viewer: { login: "octo" } } });
    const [argv] = recordedArgv();
    expect(argv).toEqual(["api", "graphql", "--hostname", "github.com", "--method", "POST", "--include", "--input", "-"]);
    // The body never reaches argv; it arrives byte-for-byte on stdin.
    expect(argv!.join(" ")).not.toContain("passwd");
    const stdin = JSON.parse(readFileSync(path.join(state, "stdin"), "utf8"));
    expect(stdin.variables.input.body).toBe(body);
    expect(stdin.query).toContain("query UatuTest");
  });

  test("REST reads name the host and the API version, with no stdin", async () => {
    await transport().request({ kind: "rest", host: "github.com", operation: "UatuPullRequestFiles", path: "repos/acme/widgets/pulls/42/files?per_page=100&page=1" });
    expect(recordedArgv()[0]).toEqual([
      "api", "repos/acme/widgets/pulls/42/files?per_page=100&page=1", "--hostname", "github.com", "--method", "GET", "--include",
      "-H", "Accept: application/vnd.github+json", "-H", `X-GitHub-Api-Version: ${REST_API_VERSION}`,
    ]);
    expect(readFileSync(path.join(state, "stdin"), "utf8")).toBe("");
  });

  test("GitHub Enterprise Server keeps gh's default API version", () => {
    expect(ghArgs({ kind: "rest", host: "ghe.example.com", operation: "x", path: "repos/a/b/pulls/1/files" })).not.toContain(`X-GitHub-Api-Version: ${REST_API_VERSION}`);
    expect(ghArgs({ kind: "rest", host: "acme.ghe.com", operation: "x", path: "repos/a/b/pulls/1/files" })).toContain(`X-GitHub-Api-Version: ${REST_API_VERSION}`);
    expect(() => ghArgs({ kind: "rest", host: "github.com", operation: "x", path: "--paginate" })).toThrow();
  });

  test("parses stdout whatever the exit code: an HTTP 404 still answers", async () => {
    script({ stdout: include("404 Not Found", {}, { message: "Not Found" }), stderr: "gh: Not Found (HTTP 404)\n", exit: 1 });
    const response = await transport().request(graphql());
    expect(response.status).toBe(404);
    expect(response.json).toEqual({ message: "Not Found" });
  });

  test("a GraphQL partial answer (HTTP 200, exit 1) keeps its data and errors", async () => {
    script({
      stdout: include("200 OK", {}, { data: { repository: { pullRequest: { number: 1 } } }, errors: [{ type: "FORBIDDEN", path: ["repository", "pullRequest", "lastCommit"], message: "Resource not accessible by personal access token" }] }),
      stderr: "gh: Resource not accessible by personal access token\n",
      exit: 1,
    });
    const answer = await new GitHubApi(transport()).graphql<{ repository: unknown }>("github.com", { name: "UatuTest", query: "query UatuTest { x }" }, {});
    expect(answer.data.repository).toEqual({ pullRequest: { number: 1 } });
    expect(answer.errors[0]?.type).toBe("FORBIDDEN");
    expect(new GitHubApi(transport()).sectionFailure(answer, ["repository", "pullRequest", "lastCommit"])?.kind).toBe("forbidden");
  });
});

describe("GhTransport failures", () => {
  test("a missing gh is gh-missing", async () => {
    const empty = path.join(root, "empty");
    mkdirSync(empty, { recursive: true });
    const missing = new GhTransport({ env: { PATH: empty } });
    expect(missing.executable()).toBeNull();
    await expect(missing.request(graphql())).rejects.toMatchObject({ kind: "gh-missing" });
  });

  test("a gh older than the floor is refused before any request", async () => {
    script({ version: "gh version 1.14.0 (2021-08-04)\n" });
    await expect(transport().request(graphql())).rejects.toMatchObject({ kind: "gh-too-old" });
    expect(recordedArgv()).toEqual([]);
  });

  test("the version is checked once per transport", async () => {
    const shared = transport();
    await shared.request(graphql());
    script({ version: "gh version 1.0.0\n", stdout: include("200 OK", {}, { data: {} }) });
    await expect(shared.request(graphql())).resolves.toMatchObject({ status: 200 });
  });

  test("no login (exit 4, nothing on stdout) is no-credential, and stderr never surfaces", async () => {
    script({ stderr: "To get started with GitHub CLI, please run:  gh auth login\nghp_SECRET_TOKEN /home/me/.config/gh\n", exit: 4 });
    const error = await transport().request(graphql()).catch(caught => caught) as GitHubFailure;
    expect(error).toBeInstanceOf(GitHubFailure);
    expect(error.kind).toBe("no-credential");
    expect(error.message).not.toContain("ghp_SECRET_TOKEN");
    expect(error.message).not.toContain(".config");
  });

  test("a network failure (exit 1, nothing on stdout) is unavailable", async () => {
    script({ stderr: "error connecting to api.github.com\n", exit: 1 });
    await expect(transport().request(graphql())).rejects.toMatchObject({ kind: "unavailable" });
  });

  test("a request past its timeout is killed and classified", async () => {
    script({ sleep: 5 });
    const started = Date.now();
    await expect(transport({ timeouts: { readMs: 200 } }).request(graphql())).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("output over the cap is refused", async () => {
    script({ stdout: include("200 OK", {}, { data: { blob: "x".repeat(10_000) } }) });
    await expect(transport({ maxOutputBytes: 1_000 }).request(graphql())).rejects.toMatchObject({ kind: "unavailable" });
  });

  test("an unreadable answer is unavailable", async () => {
    script({ stdout: "not http at all" });
    await expect(transport().request(graphql())).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("rate limits from headers", () => {
  const api = () => new GitHubApi(transport(), () => 1_000_000);

  test("GraphQL's 200 with RATE_LIMITED carries the reset time", async () => {
    script({ stdout: include("200 OK", { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": "2000" }, { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), exit: 1 });
    await expect(api().graphql("github.com", { name: "UatuTest", query: "q" }, {})).rejects.toMatchObject({ kind: "rate-limited", retryAt: 2_000_000 });
  });

  test("REST's 403 with remaining 0 is the primary limit", async () => {
    script({ stdout: include("403 Forbidden", { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": "1600" }, { message: "API rate limit exceeded for user ID 1." }), exit: 1 });
    await expect(api().rest("github.com", "UatuPullRequestFiles", "repos/a/b/pulls/1/files")).rejects.toMatchObject({ kind: "rate-limited", retryAt: 1_600_000 });
  });

  test("a secondary limit waits for retry-after", async () => {
    script({ stdout: include("403 Forbidden", { "Retry-After": "90" }, { message: "You have exceeded a secondary rate limit." }), exit: 1 });
    await expect(api().graphql("github.com", { name: "UatuTest", query: "q" }, {})).rejects.toMatchObject({ kind: "rate-limited", retryAt: 1_090_000 });
  });

  test("SSO refusals name SSO; 401 is no credential; 5xx is unavailable", async () => {
    script({ stdout: include("403 Forbidden", { "X-Github-Sso": "required; url=https://github.com/orgs/acme/sso?x=1" }, { message: "Resource protected by organization SAML enforcement." }), exit: 1 });
    await expect(api().graphql("github.com", { name: "UatuTest", query: "q" }, {})).rejects.toMatchObject({ kind: "sso" });
    script({ stdout: include("401 Unauthorized", {}, { message: "Bad credentials" }), exit: 1 });
    await expect(api().graphql("github.com", { name: "UatuTest", query: "q" }, {})).rejects.toMatchObject({ kind: "no-credential" });
    script({ stdout: include("502 Bad Gateway", {}, { message: "Server Error" }), exit: 1 });
    await expect(api().graphql("github.com", { name: "UatuTest", query: "q" }, {})).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("Enterprise host check", () => {
  test("`gh auth status --hostname` decides, once per host", async () => {
    script({ exit: 0 });
    const shared = transport();
    expect(await shared.authenticated("ghe.example.com")).toBe(true);
    expect(await shared.authenticated("ghe.example.com")).toBe(true);
    expect(recordedArgv()).toEqual([["auth", "status", "--hostname", "ghe.example.com"]]);
    script({ exit: 1 });
    expect(await transport().authenticated("other.example.com")).toBe(false);
  });
});

describe("parseIncludeOutput", () => {
  test("reads the status, lowercased headers and the JSON body", () => {
    expect(parseIncludeOutput("HTTP/1.1 201 Created\nX-Thing: a: b\n\n{\"ok\":true}")).toEqual({ status: 201, headers: { "x-thing": "a: b" }, json: { ok: true } });
    expect(parseIncludeOutput("HTTP/2.0 204 No Content\r\n\r\n")).toEqual({ status: 204, headers: {}, json: null });
    expect(parseIncludeOutput("{\"data\":{}}")).toBeNull();
  });
});
