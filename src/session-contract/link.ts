// Session contract: the session link, the Hub's handle to one running
// workspace session. Every request the Hub sends to a session is addressed
// and trusted through its link: the link holds the loopback endpoint and the
// session token, shapes the headers that cross the hop, and signs chat policy
// while policy trust is ready. Hub code never reads the token or the policy
// key; both live in this closure.

import { HOP_BY_HOP_HEADERS, isHubHeader } from "./headers";
import { sessionPath } from "./paths";
import type { ChildPolicyRequest, PolicyAuthority, VerifiedChatPolicy } from "./policy";

export type SessionEndpoint = {
  hostname: string;
  port: number;
};

export type SessionLink = {
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly basePath: string;
  readonly endpoint: SessionEndpoint;
  // The session's own loopback origin, which its origin gate accepts.
  readonly origin: string;
  // "ready" once the session answered the readiness proof; "unavailable"
  // otherwise and after withdraw(). The session token is never policy
  // authority.
  readonly policyTrust: "ready" | "unavailable";
  // The session URL for a session-relative path (which may carry a query),
  // or for a browser request URL whose path and query are kept verbatim.
  // The Hub-held token is applied as `t`. Applied means OVERWRITTEN, not
  // merely filled in: a browser-supplied `?t=` is at best a stale value the
  // SPA captured earlier and at worst arbitrary — preserving it would make
  // the session reject credentials the Hub is supposed to broker, stranding
  // the user at a token prompt for a token that is never exposed to them.
  url(target: string | URL): URL;
  // Headers for a request the HUB ITSELF originates (the live broker's
  // upstream subscriptions, worker evidence, account-change notices): the
  // same loopback shaping a proxied browser request gets, without a browser
  // request to copy from. Identity encoding keeps the session's bytes as-is.
  requestHeaders(accept?: string): Headers;
  // Headers for a proxied browser request.
  forwardHeaders(request: Request): Headers;
  // The signed policy envelope for a policy action, or null when policy
  // trust is unavailable or the request is out of scope.
  sign(request: ChildPolicyRequest, policy: VerifiedChatPolicy): string | null;
  // Called by the backend when the session stops or exits: trust becomes
  // unavailable and the policy key is disposed.
  withdraw(): void;
};

export function createSessionLink(options: {
  workspaceId: string;
  instanceId: string;
  basePath: string;
  endpoint: SessionEndpoint;
  // Null when the ready line carried no token.
  token: string | null;
  // The policy authority whose readiness proof the session answered. Omitted
  // when policy trust was not established.
  authority?: PolicyAuthority | null;
}): SessionLink {
  const { workspaceId, instanceId, basePath, endpoint, token } = options;
  const host = `${endpoint.hostname}:${endpoint.port}`;
  const origin = `http://${host}`;
  let authority = options.authority ?? null;

  return {
    workspaceId,
    instanceId,
    basePath,
    endpoint,
    origin,
    get policyTrust() {
      return authority ? "ready" : "unavailable";
    },
    url(target) {
      const url = typeof target === "string"
        ? new URL(sessionPath(basePath, target), origin)
        : new URL(target.pathname + target.search, origin);
      if (token) {
        url.searchParams.set("t", token);
      }
      return url;
    },
    requestHeaders(accept = "text/event-stream") {
      const headers = new Headers();
      headers.set("host", host);
      headers.set("accept", accept);
      headers.set("accept-encoding", "identity");
      headers.set("origin", origin);
      return headers;
    },
    forwardHeaders(request) {
      const headers = new Headers();
      for (const [name, value] of request.headers) {
        if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
        if (isHubHeader(name)) continue;
        headers.set(name, value);
      }
      headers.set("host", host);
      // Identity encoding from the session: the loopback hop gains nothing
      // from compression, and an unencoded upstream body means its
      // Content-Length stays truthful after fetch() — which the Hub then
      // passes through, so fronting proxies (tailscale serve, Caddy, nginx)
      // see length-known responses instead of unknown-length chunked streams.
      headers.set("accept-encoding", "identity");
      // Loopback-shape the Origin so the session's localhost origin gate
      // holds; the Hub validated the caller's real Origin (when present)
      // before proxying. Injected even when absent: browsers always send
      // Origin on cross-origin and mutating requests, so an Origin-less
      // request is a native client the Hub has already authenticated —
      // mirroring the WebSocket bridge, which injects the loopback Origin
      // unconditionally.
      headers.set("origin", origin);
      return headers;
    },
    sign(request, policy) {
      try {
        return authority?.sign(request, policy) ?? null;
      } catch {
        return null;
      }
    },
    withdraw() {
      authority?.dispose();
      authority = null;
    },
  };
}
