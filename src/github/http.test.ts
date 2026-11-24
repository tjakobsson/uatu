import { describe, expect, test } from "bun:test";

import { FakeGithubService } from "./fake";
import { githubRouteHandlers, repositoryKey } from "./http";

const allow = () => null;

function post(path: string, body: unknown, params?: Record<string, string>) {
  const request = new Request(`http://127.0.0.1/api/github${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as Request & { params?: Record<string, string> };
  request.params = params;
  return request;
}

describe("githubRouteHandlers", () => {
  test("every route answers 404 when no service is configured", async () => {
    const handlers = githubRouteHandlers(() => null, allow);
    const response = await handlers.summary(new Request("http://127.0.0.1/api/github/summary?repository=r"));
    expect(response.status).toBe(404);
    expect((await handlers.comment(post("/comments", { repository: "r", number: 642, body: "x" }))).status).toBe(404);
  });

  test("reads validate their parameters", async () => {
    const handlers = githubRouteHandlers(() => new FakeGithubService(), allow);
    expect((await handlers.summary(new Request("http://127.0.0.1/api/github/summary"))).status).toBe(400);
    expect((await handlers.pullRequest(new Request("http://127.0.0.1/api/github/pull-request?repository=r&number=abc"))).status).toBe(400);
    const ok = await handlers.pullRequest(new Request("http://127.0.0.1/api/github/pull-request?repository=r&number=642"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await ok.json()).summary.number).toBe(642);
    expect((await handlers.pullRequest(new Request("http://127.0.0.1/api/github/pull-request?repository=r&number=9"))).status).toBe(404);
  });

  test("writes are refused before the service runs when the guard says so", async () => {
    const service = new FakeGithubService();
    const handlers = githubRouteHandlers(() => service, () => new Response("Forbidden", { status: 403 }));
    expect((await handlers.comment(post("/comments", { repository: "r", number: 642, body: "x" }))).status).toBe(403);
    expect((await service.pullRequest("r", 642)).timeline.some(item => item.kind === "comment" && item.comment.body === "x")).toBe(false);
  });

  test("writes validate bodies and map service refusals to statuses", async () => {
    const handlers = githubRouteHandlers(() => new FakeGithubService(), allow);
    expect((await handlers.comment(post("/comments", { repository: "r", number: 642, body: "  " }))).status).toBe(400);
    expect((await handlers.comment(post("/comments", { repository: "r", number: 642, body: "x".repeat(70_000) }))).status).toBe(400);
    expect((await handlers.submitReview(post("/review/submit", { repository: "r", number: 642, event: "SHIP_IT" }))).status).toBe(400);
    expect((await handlers.createThread(post("/review/threads", { repository: "r", number: 642, headOid: "stale", path: "README.md", line: 1, side: "RIGHT", body: "x" }))).status).toBe(409);
    const reply = await handlers.reply(post("/review/threads/x/replies", { repository: "r", number: 642, body: "hi" }, { threadId: "thread-checks-source" }));
    expect(reply.status).toBe(200);
    expect((await reply.json()).pendingReview.comments[0].threadId).toBe("thread-checks-source");
  });

  test("the composer preview renders through the sanitized Markdown renderer", async () => {
    const handlers = githubRouteHandlers(() => new FakeGithubService(), allow);
    const response = await handlers.markdown(post("/markdown", { body: "# Hi\n<img src=x onerror=alert(1)>" }));
    const { html } = await response.json();
    expect(html).toContain("<h1");
    expect(html).not.toContain("onerror");
  });

  test("the scenario switch validates its input", async () => {
    const handlers = githubRouteHandlers(() => new FakeGithubService(), allow);
    expect((await handlers.devScenario(post("/dev/scenario", { scenario: "nope" }))).status).toBe(400);
    expect((await handlers.devScenario(post("/dev/scenario", { scenario: "no-credential" }))).status).toBe(200);
  });

  test("a pull request's file renders at its head through the document pipeline", async () => {
    const handlers = githubRouteHandlers(() => new FakeGithubService(), allow);
    const response = await handlers.pullRequestFile(new Request("http://127.0.0.1/api/github/pull-request/file?repository=r&number=639&path=docs/terminal.md"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.kind).toBe("markdown");
    expect(payload.view).toBe("rendered");
    expect(payload.mock).toBe(true);
    expect(payload.id).toBe("pr:639@c0ffee1234567890abcdef1234567890abcdef12:docs/terminal.md");
    expect(payload.html).toContain("language-mermaid");
    expect(payload.html).toContain("./images/reflow.svg");
    expect(payload.revision).toEqual({ number: 639, rev: "head", oid: "c0ffee1234567890abcdef1234567890abcdef12",
      blobBase: `api/github/pr-blob/${repositoryKey("r")}/639/c0ffee1234567890abcdef1234567890abcdef12/` });
    const source = await (await handlers.pullRequestFile(new Request("http://127.0.0.1/api/github/pull-request/file?repository=r&number=639&path=docs/terminal.md&view=source"))).json();
    expect(source.view).toBe("source");
    expect(source.html).toContain("uatu-source-pre");
    const adoc = await (await handlers.pullRequestFile(new Request("http://127.0.0.1/api/github/pull-request/file?repository=r&number=639&path=docs/terminal-links.adoc"))).json();
    expect(adoc.kind).toBe("asciidoc");
    expect(adoc.title).toBe("Terminal links");
    // Base: the old side of a changed file; an added file has none.
    const base = await (await handlers.pullRequestFile(new Request("http://127.0.0.1/api/github/pull-request/file?repository=r&number=639&path=docs/terminal.md&rev=base&view=source"))).json();
    expect(base.revision.oid).toBe("7dd6e40b5a1f9c3e2d4b6a8f0c1e3d5b7a9f1c2e");
    expect(base.html).not.toContain("mermaid");
    expect((await handlers.pullRequestFile(new Request("http://127.0.0.1/api/github/pull-request/file?repository=r&number=639&path=docs/terminal-links.adoc&rev=base"))).status).toBe(404);
  });

  test("the file route refuses unsafe paths, binaries and missing files", async () => {
    const handlers = githubRouteHandlers(() => new FakeGithubService(), allow);
    const status = async (query: string) => (await handlers.pullRequestFile(new Request(`http://127.0.0.1/api/github/pull-request/file?repository=r&number=639&${query}`))).status;
    expect(await status("path=../etc/passwd")).toBe(400);
    expect(await status("path=/etc/passwd")).toBe(400);
    expect(await status("path=docs//terminal.md")).toBe(400);
    expect(await status("path=.git/config")).toBe(404);
    expect(await status("path=docs/nope.md")).toBe(404);
    expect(await status("path=docs/terminal.md&rev=tip")).toBe(400);
    const binary = await handlers.pullRequestFile(new Request("http://127.0.0.1/api/github/pull-request/file?repository=r&number=639&path=docs/images/reflow.svg"));
    expect(binary.status).toBe(415);
    expect((await binary.json()).state).toBe("binary");
  });

  test("a head that isn't fetched answers 409 until the explicit fetch", async () => {
    const service = new FakeGithubService({ scenario: "head-not-fetched" });
    const handlers = githubRouteHandlers(() => service, allow);
    const file = () => handlers.pullRequestFile(new Request("http://127.0.0.1/api/github/pull-request/file?repository=r&number=639&path=docs/terminal.md"));
    const refused = await file();
    expect(refused.status).toBe(409);
    expect((await refused.json()).state).toBe("not-fetched");
    expect((await handlers.pullRequestTree(new Request("http://127.0.0.1/api/github/pull-request/tree?repository=r&number=639"))).status).toBe(409);
    // The checked-out branch's head is local already.
    expect((await handlers.pullRequestFile(new Request("http://127.0.0.1/api/github/pull-request/file?repository=r&number=642&path=docs/pr-review.md"))).status).toBe(200);
    const fetched = await handlers.fetchRefs(post("/fetch-refs", { repository: "r", number: 639 }));
    expect(await fetched.json()).toEqual({ mock: true, headOid: "c0ffee1234567890abcdef1234567890abcdef12" });
    expect((await file()).status).toBe(200);
  });

  test("the fetch is a write: refused before the service runs when the guard says so", async () => {
    const service = new FakeGithubService({ scenario: "head-not-fetched" });
    const handlers = githubRouteHandlers(() => service, () => new Response("Forbidden", { status: 403 }));
    expect((await handlers.fetchRefs(post("/fetch-refs", { repository: "r", number: 639 }))).status).toBe(403);
    expect("state" in await service.pullRequestBlob("r", 639, { path: "docs/terminal.md", rev: "head" })).toBe(true);
  });

  test("the tree lists the head's paths", async () => {
    const handlers = githubRouteHandlers(() => new FakeGithubService(), allow);
    const tree = await (await handlers.pullRequestTree(new Request("http://127.0.0.1/api/github/pull-request/tree?repository=r&number=639"))).json();
    expect(tree.headOid).toBe("c0ffee1234567890abcdef1234567890abcdef12");
    expect(tree.truncated).toBe(false);
    expect(tree.paths).toContain("docs/images/reflow.svg");
    expect(tree.paths).toContain("src/terminal/links.ts");
    expect(tree.paths).toContain("ARCHITECTURE.md");
  });

  test("blobs are served by commit, never as HTML, under a sandbox CSP", async () => {
    const handlers = githubRouteHandlers(() => new FakeGithubService(), allow, { repositoryIds: () => ["/repo"] });
    const key = repositoryKey("/repo");
    const blob = (rest: string) => handlers.pullRequestBlob(new Request(`http://127.0.0.1/s/uatu/api/github/pr-blob/${key}/639/${rest}`));
    const svg = await blob("c0ffee1234567890abcdef1234567890abcdef12/docs/images/reflow.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    expect(svg.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(svg.headers.get("cache-control")).toContain("immutable");
    expect(await svg.text()).toContain("<svg");
    const markdown = await blob("c0ffee1234567890abcdef1234567890abcdef12/docs/terminal.md");
    expect(markdown.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // Only the pull request's head or base commit; a known repository; no
    // parent segments or VCS metadata.
    expect((await blob("0123456789abcdef0123456789abcdef01234567/docs/terminal.md")).status).toBe(404);
    expect((await handlers.pullRequestBlob(new Request(`http://127.0.0.1/api/github/pr-blob/000000000000/639/c0ffee1234567890abcdef1234567890abcdef12/docs/terminal.md`))).status).toBe(404);
    expect((await blob("c0ffee1234567890abcdef1234567890abcdef12/docs%2F..%2F..%2Fsecret")).status).toBe(404);
    expect((await blob("c0ffee1234567890abcdef1234567890abcdef12/.git/config")).status).toBe(404);
    expect((await blob("7dd6e40b5a1f9c3e2d4b6a8f0c1e3d5b7a9f1c2e/docs/terminal.md")).status).toBe(200);
  });

  test("the file view's routes answer 404 without a service", async () => {
    const handlers = githubRouteHandlers(() => null, allow);
    expect((await handlers.pullRequestFile(new Request("http://127.0.0.1/api/github/pull-request/file?repository=r&number=639&path=a.md"))).status).toBe(404);
    expect((await handlers.pullRequestTree(new Request("http://127.0.0.1/api/github/pull-request/tree?repository=r&number=639"))).status).toBe(404);
    expect((await handlers.pullRequestBlob(new Request("http://127.0.0.1/api/github/pr-blob/k/639/c0ffee1/a.md"))).status).toBe(404);
    expect((await handlers.fetchRefs(post("/fetch-refs", { repository: "r", number: 639 }))).status).toBe(404);
  });
});
