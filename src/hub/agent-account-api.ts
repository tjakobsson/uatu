/**
 * HTTP surface of Agent accounts: `GET /api/hub/agent-accounts` and the POST
 * mutations under it (design D5). The server routes here after its
 * authentication gate, and for POSTs after its same-origin check.
 *
 * Request bodies carry secrets (keys, codes, pasted addresses). They are
 * parsed here, handed to the service, and never logged or echoed: an error
 * names the field it concerns, never the value.
 */

import { AccountOperationError } from "./agent-account-adapter";
import { RedirectRefusedError } from "./agent-account-redirect";
import { AgentNotReadyError, AttemptNotFoundError, type AgentAccountsApi } from "./agent-account-service";
import type { AccountAgentId, AgentAccountsSnapshot } from "./agent-account-types";

export const AGENT_ACCOUNTS_PATH = "/api/hub/agent-accounts";

const NO_STORE = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 96 * 1024;

class RequestError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE });
}

function failure(status: number, message: string, field?: string): Response {
  return respond(status, field ? { error: message, field } : { error: message });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new RequestError("The request is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new RequestError("The request is too large.");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestError("The request body is not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RequestError("The request body must be an object.");
  return parsed as Record<string, unknown>;
}

function allowOnly(body: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(body)) if (!keys.includes(key)) throw new RequestError(`Unexpected field ${JSON.stringify(key).slice(0, 80)}.`);
}

function requiredString(body: Record<string, unknown>, key: string, maxBytes: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new RequestError(`${key} is required.`, key);
  if (new TextEncoder().encode(value).byteLength > maxBytes) throw new RequestError(`${key} is too long.`, key);
  return value;
}

function agentOf(body: Record<string, unknown>): AccountAgentId {
  const agent = body.agent;
  if (agent !== "opencode" && agent !== "claude") throw new RequestError("agent must be opencode or claude.", "agent");
  return agent;
}

function answersOf(body: Record<string, unknown>): Record<string, string> {
  const answers = body.answers;
  if (answers === undefined) return {};
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new RequestError("answers must be an object.", "answers");
  const entries = Object.entries(answers as Record<string, unknown>);
  if (entries.length > 32) throw new RequestError("Too many answers.", "answers");
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "string") throw new RequestError("Every answer must be text.", key);
    if (new TextEncoder().encode(value).byteLength > 4096) throw new RequestError("An answer is too long.", key);
    result[key] = value;
  }
  return result;
}

/**
 * Handles an authenticated request under `/api/hub/agent-accounts`, or
 * returns null for any other path. POST requests must already have passed
 * the server's same-origin check.
 */
export async function handleAgentAccountRequest(request: Request, pathname: string, service: AgentAccountsApi): Promise<Response | null> {
  if (pathname !== AGENT_ACCOUNTS_PATH && !pathname.startsWith(`${AGENT_ACCOUNTS_PATH}/`)) return null;
  if (pathname === AGENT_ACCOUNTS_PATH) {
    if (request.method !== "GET") return failure(405, "method not allowed");
    return respond(200, await service.read());
  }
  if (request.method !== "POST") return failure(405, "method not allowed");
  const action = pathname.slice(AGENT_ACCOUNTS_PATH.length + 1);
  try {
    const body = await readBody(request);
    let snapshot: AgentAccountsSnapshot;
    const attempt = /^attempts\/([^/]+)\/(code|redirect|cancel)$/.exec(action);
    if (attempt) {
      const attemptId = decodeURIComponent(attempt[1]!);
      if (attempt[2] === "code") {
        allowOnly(body, ["code"]);
        snapshot = await service.submitCode(attemptId, requiredString(body, "code", 8192));
      } else if (attempt[2] === "redirect") {
        allowOnly(body, ["address"]);
        snapshot = await service.submitRedirect(attemptId, requiredString(body, "address", 8192));
      } else {
        allowOnly(body, []);
        snapshot = await service.cancel(attemptId);
      }
    } else if (action === "key") {
      allowOnly(body, ["agent", "target", "method", "key", "answers"]);
      snapshot = await service.connectKey(agentOf(body), requiredString(body, "target", 256), requiredString(body, "method", 256), requiredString(body, "key", 65536), answersOf(body));
    } else if (action === "login") {
      allowOnly(body, ["agent", "target", "method", "answers"]);
      snapshot = await service.startLogin(agentOf(body), requiredString(body, "target", 256), requiredString(body, "method", 256), answersOf(body));
    } else if (action === "logout") {
      allowOnly(body, ["agent", "target", "credential"]);
      snapshot = await service.logout(agentOf(body), requiredString(body, "target", 256), requiredString(body, "credential", 256));
    } else if (action === "activate") {
      allowOnly(body, ["agent", "credential"]);
      snapshot = await service.activate(agentOf(body), requiredString(body, "credential", 256));
    } else {
      return failure(404, "not found");
    }
    return respond(200, snapshot);
  } catch (error) {
    if (error instanceof RequestError) return failure(400, error.message, error.field);
    if (error instanceof RedirectRefusedError) return failure(400, error.message, "address");
    if (error instanceof AttemptNotFoundError) return failure(404, error.message);
    if (error instanceof AgentNotReadyError) return failure(409, error.message);
    if (error instanceof AccountOperationError) return failure(400, error.message, error.field);
    // Unexpected: the message could carry anything, so only a generic one leaves.
    console.error(`uatu hub: agent accounts ${action} failed: ${error instanceof Error ? error.name : "error"}`);
    return failure(500, "The agent accounts request failed.");
  }
}
