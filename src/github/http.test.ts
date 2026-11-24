import { describe, expect, test } from "bun:test";

import { FakeGithubService } from "./fake";
import { githubRouteHandlers } from "./http";

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
});
