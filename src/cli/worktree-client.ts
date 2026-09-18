// `uatu worktree …` — the thin Hub client (task 6.2).
//
// This module is deliberately incapable of doing the work itself. It reads
// the Hub context the workspace's terminal carries, calls one published JSON
// route, and renders what came back. It imports no process spawner, runs no
// Git, and has no offline or "local" path: a Hub it cannot reach or is not
// authorized against is an actionable error and a non-zero exit, never a
// repository mutation made on its own authority.
//
// Secret hygiene is structural, not incidental. The token is read from a
// file the Hub wrote, put in exactly one place (the Authorization header of
// one request), and never interpolated into any message this module can
// print. `worktree-client.test.ts` asserts that for every code path.

import { promises as fs } from "node:fs";

import {
  isWorktreeHubContextExpired,
  parseWorktreeHubContext,
  WORKTREE_API_PATH,
  WORKTREE_CONTEXT_ENV,
  WorktreeContextError,
  type WorktreeHubContext,
} from "../shared/worktree-context";
import {
  parseWorktreeInventory,
  parseWorktreeOperationResult,
  sanitizeWorktreeMessage,
  type WorktreeCheckout,
  type WorktreeInventory,
  type WorktreeOperationResult,
} from "../shared/worktree-contract";
import type { WorktreeCommand } from "./worktree-parse";
import { worktreeUsageText } from "./worktree-parse";

// 0 success · 1 the operation was refused · 2 invalid usage ·
// 3 no usable Hub context. A refusal and a missing context are different
// problems with different fixes, so they are different codes.
export const WORKTREE_EXIT_OK = 0;
export const WORKTREE_EXIT_REFUSED = 1;
export const WORKTREE_EXIT_USAGE = 2;
export const WORKTREE_EXIT_NO_CONTEXT = 3;

export type WorktreeCliOutcome = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type WorktreeCliDeps = {
  readonly env?: Record<string, string | undefined>;
  readonly readFile?: (path: string) => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

// The one sentence a user can act on when there is no context. It names the
// cause and the fix, and never guesses at a Hub to talk to instead.
const CONTEXT_HELP = `uatu worktree needs the Hub context of the workspace it runs in.
Run it from a terminal inside an Uatu workspace. If you are in one, the
workspace may need restarting from the Hub so it gets a current context.`;

function contextFailure(reason: string): WorktreeCliOutcome {
  return { exitCode: WORKTREE_EXIT_NO_CONTEXT, stdout: "", stderr: `uatu worktree: ${reason}\n\n${CONTEXT_HELP}\n` };
}

export async function loadWorktreeHubContext(
  deps: WorktreeCliDeps = {},
): Promise<{ ok: true; context: WorktreeHubContext } | { ok: false; outcome: WorktreeCliOutcome }> {
  const env = deps.env ?? process.env;
  const contextPath = env[WORKTREE_CONTEXT_ENV];
  if (typeof contextPath !== "string" || contextPath.trim() === "") {
    return { ok: false, outcome: contextFailure(`${WORKTREE_CONTEXT_ENV} is not set`) };
  }
  let raw: string;
  try {
    raw = await (deps.readFile ?? ((path: string) => fs.readFile(path, "utf8")))(contextPath);
  } catch {
    // The path, not its contents: a context file that is gone is the
    // ordinary "this session ended" case.
    return { ok: false, outcome: contextFailure("the Hub context file could not be read") };
  }
  let context: WorktreeHubContext;
  try {
    context = parseWorktreeHubContext(JSON.parse(raw));
  } catch (error) {
    return {
      ok: false,
      outcome: contextFailure(error instanceof WorktreeContextError ? error.message : "the Hub context file is not valid JSON"),
    };
  }
  if (isWorktreeHubContextExpired(context, (deps.now ?? Date.now)())) {
    return { ok: false, outcome: contextFailure("the Hub context has expired") };
  }
  return { ok: true, context };
}

type HubCall =
  | { ok: true; body: unknown }
  | { ok: false; outcome: WorktreeCliOutcome };

async function callHub(
  context: WorktreeHubContext,
  deps: WorktreeCliDeps,
  request: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown },
): Promise<HubCall> {
  const url = new URL(`${context.hubOrigin}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url, {
      method: request.method,
      headers: {
        // The ONE place the token appears. Nothing this module can print
        // reads this header back.
        authorization: `Bearer ${context.token}`,
        accept: "application/json",
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
  } catch {
    return { ok: false, outcome: contextFailure("the Hub could not be reached") };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      outcome: contextFailure(
        response.status === 401
          ? "the Hub did not accept this workspace's context; it may have been revoked or the Hub restarted"
          : "this workspace's context does not authorize that operation",
      ),
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not a Uatu Hub answering, or not answering JSON: the context points
    // somewhere that is not the Hub that issued it.
    return { ok: false, outcome: contextFailure("the configured Hub did not answer as a Uatu Hub") };
  }
  if (!response.ok) {
    const message = typeof (body as { error?: unknown })?.error === "string"
      ? sanitizeWorktreeMessage((body as { error: string }).error)
      : `the Hub refused the request (${response.status})`;
    return { ok: false, outcome: { exitCode: WORKTREE_EXIT_REFUSED, stdout: "", stderr: `uatu worktree: ${message}\n` } };
  }
  return { ok: true, body };
}

// --- rendering -------------------------------------------------------------

function checkoutLine(checkout: WorktreeCheckout): string {
  const name = checkout.main ? "(main checkout)" : checkout.branch ?? "(detached)";
  const state = checkout.availability !== "present"
    ? checkout.availability
    : checkout.running ? "running" : "stopped";
  const origin = checkout.sourceRef === undefined ? "" : ` · from ${checkout.sourceRef}`;
  const id = checkout.workspaceId === undefined ? " · not registered" : ` · ${checkout.workspaceId}`;
  return `  ${name}  [${checkout.ownership}/${state}]${id}${origin}`;
}

function renderInventory(inventory: WorktreeInventory): string {
  const lines: string[] = [];
  if (inventory.status === "error") {
    lines.push(`This listing is stale: ${inventory.error?.message ?? "the inventory is unavailable."}`);
  }
  if (inventory.checkouts.length === 0) {
    lines.push("No checkouts are known for this repository.");
  }
  for (const checkout of [...inventory.checkouts].sort((a, b) => Number(b.main) - Number(a.main))) {
    lines.push(checkoutLine(checkout));
  }
  return `${lines.join("\n")}\n`;
}

function renderResult(command: "create" | "open" | "remove", result: WorktreeOperationResult): string {
  if (!result.ok) return "";
  const lines: string[] = [];
  const checkout = result.checkout;
  if (command === "remove") {
    lines.push("Worktree deleted. The branch was kept.");
  } else if (command === "create") {
    lines.push(`Created ${checkout?.branch ?? "the worktree"}.`);
  } else {
    lines.push(`${checkout?.branch ?? "The worktree"} is ${result.started ? "running" : "stopped"}.`);
  }
  if (checkout?.workspaceId !== undefined) lines.push(`  workspace: ${checkout.workspaceId}`);
  if (result.startError) lines.push(`  not started: ${result.startError.message}`);
  else if (command !== "remove" && !result.started) lines.push("  stopped; start it with --start or from the Hub");
  return `${lines.join("\n")}\n`;
}

function failedResult(command: string, result: WorktreeOperationResult): WorktreeCliOutcome {
  if (result.ok) throw new Error("not a failure");
  const lines = [`uatu worktree ${command}: ${result.error.message}`];
  if (result.error.retry !== "none") lines.push(`  suggested next step: ${result.error.retry.replace(/-/g, " ")}`);
  if (result.error.phase !== undefined) lines.push(`  reached phase: ${result.error.phase}`);
  if (result.retainedCheckout) {
    lines.push("  the checkout and its branch were kept; retry rather than creating another one");
  }
  return { exitCode: WORKTREE_EXIT_REFUSED, stdout: "", stderr: `${lines.join("\n")}\n` };
}

// --- dispatch --------------------------------------------------------------

// Defence in depth. Nothing this module composes quotes the token, but a
// message could in principle arrive from elsewhere carrying it — so the one
// place every byte leaves the process strips it unconditionally. The
// property is then structural rather than a discipline every new message has
// to remember.
function withoutToken(outcome: WorktreeCliOutcome, token: string): WorktreeCliOutcome {
  if (!outcome.stdout.includes(token) && !outcome.stderr.includes(token)) return outcome;
  return {
    exitCode: outcome.exitCode,
    stdout: outcome.stdout.replaceAll(token, "[redacted]"),
    stderr: outcome.stderr.replaceAll(token, "[redacted]"),
  };
}

export async function runWorktreeCommand(
  command: WorktreeCommand,
  deps: WorktreeCliDeps = {},
): Promise<WorktreeCliOutcome> {
  if (command.kind === "help") {
    return { exitCode: WORKTREE_EXIT_OK, stdout: worktreeUsageText(), stderr: "" };
  }
  const loaded = await loadWorktreeHubContext(deps);
  if (!loaded.ok) return loaded.outcome;
  const context = loaded.context;
  return withoutToken(await runAgainstHub(command, context, deps), context.token);
}

async function runAgainstHub(
  command: Exclude<WorktreeCommand, { kind: "help" }>,
  context: WorktreeHubContext,
  deps: WorktreeCliDeps,
): Promise<WorktreeCliOutcome> {
  if (command.kind === "list") {
    const call = await callHub(context, deps, {
      method: "GET",
      path: WORKTREE_API_PATH,
      query: { source: context.workspaceId },
    });
    if (!call.ok) return call.outcome;
    let inventory: WorktreeInventory;
    try {
      inventory = parseWorktreeInventory((call.body as { inventory?: unknown }).inventory);
    } catch {
      return contextFailure("the Hub answered with an inventory this version does not understand");
    }
    return command.json
      ? { exitCode: WORKTREE_EXIT_OK, stdout: `${JSON.stringify({ ok: true, command: "list", inventory }, null, 2)}\n`, stderr: "" }
      : { exitCode: WORKTREE_EXIT_OK, stdout: renderInventory(inventory), stderr: "" };
  }

  const request = command.kind === "create"
    ? {
      action: "create",
      body: {
        sourceWorkspaceId: context.workspaceId,
        mode: command.mode,
        ...(command.branch === undefined ? {} : { branch: command.branch }),
        ...(command.base === undefined ? {} : { base: command.base }),
        ...(command.baseRef === undefined ? {} : { baseRef: command.baseRef }),
        start: command.start,
      },
    }
    : command.kind === "open"
      ? {
        action: "open",
        body: { sourceWorkspaceId: context.workspaceId, reference: command.reference, start: command.start },
      }
      : {
        action: "delete",
        body: {
          sourceWorkspaceId: context.workspaceId,
          reference: command.reference,
          // The flag IS the authorization, and it is required by the parser
          // before this point — there is no implicit confirmation here.
          confirm: true,
          stop: command.stop,
        },
      };

  const call = await callHub(context, deps, {
    method: "POST",
    path: `${WORKTREE_API_PATH}/${request.action}`,
    body: request.body,
  });
  if (!call.ok) return call.outcome;
  let result: WorktreeOperationResult;
  try {
    result = parseWorktreeOperationResult(call.body);
  } catch {
    return contextFailure("the Hub answered with a result this version does not understand");
  }
  const label = command.kind;
  if (command.json) {
    return {
      exitCode: result.ok ? WORKTREE_EXIT_OK : WORKTREE_EXIT_REFUSED,
      stdout: `${JSON.stringify({ ok: result.ok, command: label, result }, null, 2)}\n`,
      stderr: "",
    };
  }
  if (!result.ok) return failedResult(label, result);
  return { exitCode: WORKTREE_EXIT_OK, stdout: renderResult(label, result), stderr: "" };
}
