import { describe, expect, test } from "bun:test";

import { RedirectRefusedError, classifyCompletion, confineRedirect, deliverRedirect, loopbackRedirectOf } from "./agent-account-redirect";

const CALLBACK = { protocol: "http:" as const, hostname: "localhost", port: "1455", pathname: "/auth/callback" };

describe("completion classification", () => {
  test("a code method is a code login whatever its URL", () => {
    expect(classifyCompletion("https://x.test/a?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb", "code")).toEqual({ completion: "code", callback: null });
  });

  test("an auto method whose redirect is loopback is a redirect login; any other auto method is a device login", () => {
    expect(classifyCompletion("https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback", "auto")).toEqual({ completion: "redirect", callback: CALLBACK });
    expect(classifyCompletion("https://github.com/login/device", "auto")).toEqual({ completion: "device", callback: null });
    // Claude's manual flow redirects to a public page that shows the code: not loopback.
    expect(classifyCompletion("https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback", "auto").completion).toBe("device");
  });

  test("loopback detection takes every loopback spelling and refuses userinfo and https", () => {
    expect(loopbackRedirectOf("https://a.test/?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A8080%2Fcb")).toEqual({ protocol: "http:", hostname: "[::1]", port: "8080", pathname: "/cb" });
    expect(loopbackRedirectOf("https://a.test/?redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb")?.port).toBe("80");
    expect(loopbackRedirectOf("https://a.test/?redirect_uri=http%3A%2F%2Fuser%3Apw%40localhost%3A1%2Fcb")).toBeNull();
    expect(loopbackRedirectOf("https://a.test/?redirect_uri=https%3A%2F%2Flocalhost%3A1%2Fcb")).toBeNull();
    expect(loopbackRedirectOf("not a url")).toBeNull();
  });
});

describe("confinement", () => {
  test("another loopback spelling of the same port and path is delivered on the recorded host", () => {
    expect(confineRedirect("http://[::1]:1455/auth/callback?code=a&state=b", CALLBACK).toString()).toBe("http://localhost:1455/auth/callback?code=a&state=b");
  });

  test("refusals never repeat the pasted address", () => {
    for (const pasted of ["http://localhost:1455/other?code=s3cret", "garbage s3cret", "http://user:s3cret@localhost:1455/auth/callback"]) {
      try {
        confineRedirect(pasted, CALLBACK);
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(RedirectRefusedError);
        expect((error as Error).message).not.toContain("s3cret");
      }
    }
  });
});

describe("delivery", () => {
  test("requests once without following redirects and discards the body", async () => {
    let cancelled = false;
    const calls: Array<[string, RequestInit]> = [];
    await deliverRedirect(new URL("http://localhost:1455/auth/callback?code=a"), async (input, init) => {
      calls.push([input, init]);
      const body = new ReadableStream({ cancel() { cancelled = true; } });
      return new Response(body, { status: 302, headers: { location: "https://elsewhere.test/" } });
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.[1].redirect).toBe("manual");
    expect(calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(cancelled).toBe(true);
  });
});
