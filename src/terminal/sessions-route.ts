// REST surface for the terminal session inventory, shared verbatim by
// cli.ts (prod) and tests/e2e/server.ts. Lives beside the terminal server
// rather than in server/routes.ts because it needs the TerminalServer
// instance and method-dependent handling, matching the /api/auth
// fetch-fallback style rather than Bun's static route table.
//
//   GET    /api/terminal/sessions       → { sessions: TerminalSessionInfo[] }
//   DELETE /api/terminal/sessions/<id>  → 204, or 404 for an unknown id
//
// Both are gated by the same credentials as the terminal upgrade. Responses
// are `no-store`: the inventory is a live view, and a cached 401/200 would
// confuse the picker after a token rotation.

import { hasValidTerminalCredentials } from "./auth";
import type { TerminalServer } from "./server";

const SESSIONS_PATH = "/api/terminal/sessions";
const SESSION_PATH_PREFIX = `${SESSIONS_PATH}/`;

// Returns null when the request is not for this route family, so callers can
// fall through to their remaining handlers.
export function handleTerminalSessionsRoute(
  request: Request,
  requestUrl: URL,
  terminalServer: TerminalServer | null,
  getExpectedToken: () => string,
): Response | Promise<Response> | null {
  const path = requestUrl.pathname;
  if (path !== SESSIONS_PATH && !path.startsWith(SESSION_PATH_PREFIX)) {
    return null;
  }
  if (!terminalServer) {
    return new Response("terminal disabled", { status: 503 });
  }
  if (!hasValidTerminalCredentials(request, requestUrl, getExpectedToken())) {
    return new Response("unauthorized", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }

  if (path === SESSIONS_PATH && request.method === "GET") {
    return terminalServer.listSessions().then(sessions =>
      Response.json({ sessions }, { headers: { "cache-control": "no-store" } }),
    );
  }

  if (path.startsWith(SESSION_PATH_PREFIX) && request.method === "DELETE") {
    const id = decodeURIComponent(path.slice(SESSION_PATH_PREFIX.length));
    if (terminalServer.killSession(id)) {
      return new Response(null, { status: 204 });
    }
    return new Response("unknown session", { status: 404 });
  }

  return new Response("method not allowed", { status: 405 });
}
