import { describe, expect, test } from "bun:test";

import { testSessionLink } from "../../tests/contracts/session-link";
import { CHILD_POLICY_HEADER } from "./policy";

const request = { method: "POST", pathname: "/s/project/api/chat/conversations/opencode%3Aparent/prompts", body: '{"text":"steer"}' };
const policy = { principal: "alice", revision: 2, autoBackgroundOnSteer: true };

describe("session link addressing", () => {
  test("a session-relative path is joined under the base path with the Hub-held token", () => {
    const { link } = testSessionLink({ port: 4711, token: "session-secret" });
    expect(link.origin).toBe("http://127.0.0.1:4711");
    expect(link.url("/api/terminal/sessions").href).toBe("http://127.0.0.1:4711/s/project/api/terminal/sessions?t=session-secret");
    expect(link.url("/api/events?cursor=7").href).toBe("http://127.0.0.1:4711/s/project/api/events?cursor=7&t=session-secret");
  });

  test("a request URL keeps its path and query, and a caller's t is overwritten", () => {
    const { link } = testSessionLink({ port: 4711, token: "session-secret" });
    const target = link.url(new URL("https://hub.example/s/project/api/state?t=browser-value&x=1"));
    expect(target.href).toBe("http://127.0.0.1:4711/s/project/api/state?t=session-secret&x=1");
  });

  test("a link without a token adds none", () => {
    const { link } = testSessionLink({ port: 4711, token: null });
    expect(link.url(new URL("https://hub.example/s/project/api/state?t=browser-value")).search).toBe("?t=browser-value");
    expect(link.url("/api/state").search).toBe("");
  });

  test("Hub-originated requests are loopback-shaped", () => {
    const { link } = testSessionLink({ port: 4711 });
    expect(Object.fromEntries(link.requestHeaders())).toEqual({
      host: "127.0.0.1:4711",
      accept: "text/event-stream",
      "accept-encoding": "identity",
      origin: "http://127.0.0.1:4711",
    });
    expect(link.requestHeaders("application/json").get("accept")).toBe("application/json");
  });

  test("forwarded requests drop hop-by-hop and caller-supplied Hub headers and always carry a loopback Origin", () => {
    const { link } = testSessionLink({ port: 4711 });
    const headers = link.forwardHeaders(new Request("https://hub.example/s/project/api/state", { headers: {
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "accept-encoding": "gzip",
      origin: "https://hub.example",
      [CHILD_POLICY_HEADER]: "forged",
      "X-Uatu-Hub-Principal": "forged",
      "x-normal": "preserved",
    } }));
    expect(Object.fromEntries(headers)).toEqual({
      host: "127.0.0.1:4711",
      "accept-encoding": "identity",
      origin: "http://127.0.0.1:4711",
      "x-normal": "preserved",
    });
    expect(link.forwardHeaders(new Request("https://hub.example/s/project/")).get("origin")).toBe("http://127.0.0.1:4711");
  });
});

describe("session link policy trust", () => {
  test("a trusted link signs an envelope the session's verifier accepts", () => {
    const { link, verifier } = testSessionLink({ trusted: true });
    expect(link.policyTrust).toBe("ready");
    const envelope = link.sign(request, policy);
    expect(typeof envelope).toBe("string");
    expect(verifier!.verify(request, envelope!)).toEqual(policy);
    expect(verifier!.instanceId).toBe(link.instanceId);
  });

  test("a request outside the policy-signed actions is not signed", () => {
    const { link } = testSessionLink({ trusted: true });
    expect(link.sign({ ...request, pathname: "/s/project/api/chat/conversations/x/background" }, policy)).toBeNull();
    expect(link.sign({ ...request, pathname: "/s/other/api/chat/conversations/x/prompts" }, policy)).toBeNull();
  });

  test("an untrusted link signs nothing", () => {
    const { link, verifier } = testSessionLink();
    expect(link.policyTrust).toBe("unavailable");
    expect(verifier).toBeNull();
    expect(link.sign(request, policy)).toBeNull();
  });

  test("a withdrawn link reports trust unavailable and signs nothing further", () => {
    const { link } = testSessionLink({ trusted: true });
    expect(link.sign(request, policy)).not.toBeNull();
    link.withdraw();
    expect(link.policyTrust).toBe("unavailable");
    expect(link.sign(request, policy)).toBeNull();
    link.withdraw();
    expect(link.policyTrust).toBe("unavailable");
  });

  test("trust is read-only", () => {
    const { link } = testSessionLink();
    expect(() => { (link as { policyTrust: string }).policyTrust = "ready"; }).toThrow();
    expect(link.policyTrust).toBe("unavailable");
  });
});
