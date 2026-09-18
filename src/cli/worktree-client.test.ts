import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { WORKTREE_CAPABILITY_PREFIX, WORKTREE_CONTEXT_ENV } from "../shared/worktree-context";
import { parseWorktreeCommand } from "./worktree-parse";
import {
  runWorktreeCommand,
  WORKTREE_EXIT_NO_CONTEXT,
  WORKTREE_EXIT_OK,
  WORKTREE_EXIT_REFUSED,
  type WorktreeCliDeps,
} from "./worktree-client";

const TOKEN = `${WORKTREE_CAPABILITY_PREFIX}handle.super-secret-value`;
const CONTEXT_PATH = "/run/uatu/hub-context.json";

function context(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    hubOrigin: "http://127.0.0.1:4700",
    workspaceId: "atlas",
    token: TOKEN,
    expiresAt: 10_000,
    ...overrides,
  });
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function harness(options: {
  file?: string | Error;
  respond?: (call: Call) => Response;
  env?: Record<string, string | undefined>;
  now?: number;
} = {}): { deps: WorktreeCliDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: WorktreeCliDeps = {
    env: options.env ?? { [WORKTREE_CONTEXT_ENV]: CONTEXT_PATH },
    now: () => options.now ?? 1_000,
    async readFile() {
      const file = options.file ?? context();
      if (file instanceof Error) throw file;
      return file;
    },
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return options.respond?.(call) ?? Response.json({ inventory: inventory() });
    }) as unknown as typeof fetch,
  };
  return { deps, calls };
}

function inventory(checkouts: unknown[] = []) {
  return {
    repositoryId: "repo-1",
    sourceWorkspaceId: "atlas",
    status: "ready",
    checkouts,
    refs: { local: ["main"], remote: [], fetchedAt: null },
  };
}

const child = {
  checkoutId: "checkout-2",
  repositoryId: "repo-1",
  workspaceId: "feature-login",
  path: "/src/atlas.worktrees/feature-login",
  branch: "feature/login",
  detached: false,
  main: false,
  ownership: "uatu",
  availability: "present",
  registered: true,
  running: false,
  locked: false,
  sourceRef: "main",
};

describe("uatu worktree Hub context", () => {
  test("an absent, unreadable, malformed or expired context is actionable and exits 3", async () => {
    const cases: Array<[string, Parameters<typeof harness>[0]]> = [
      ["not set", { env: {} }],
      ["could not be read", { file: new Error("ENOENT") }],
      ["not valid JSON", { file: "{" }],
      ["unsupported version", { file: context({ version: 9 }) }],
      ["expired", { file: context({ expiresAt: 500 }) }],
      // A Hub session id in the file is refused: it is not least privilege.
      ["session id", { file: context({ token: "an-ordinary-hub-session-id" }) }],
    ];
    for (const [, options] of cases) {
      const { deps, calls } = harness(options);
      const outcome = await runWorktreeCommand(parseWorktreeCommand(["list"]), deps);
      expect(outcome.exitCode).toBe(WORKTREE_EXIT_NO_CONTEXT);
      expect(outcome.stderr).toContain("Run it from a terminal inside an Uatu workspace");
      // No request was made, so no operation could have happened anywhere.
      expect(calls).toEqual([]);
    }
  });

  test("a revoked or unauthorized context reports the fix, not a fallback", async () => {
    for (const [status, expected] of [[401, "revoked or the Hub restarted"], [403, "does not authorize"]] as const) {
      const { deps } = harness({ respond: () => Response.json({ error: "nope" }, { status }) });
      const outcome = await runWorktreeCommand(parseWorktreeCommand(["list"]), deps);
      expect(outcome.exitCode).toBe(WORKTREE_EXIT_NO_CONTEXT);
      expect(outcome.stderr).toContain(expected);
    }
  });

  test("an unreachable or non-Hub origin never falls back to acting locally", async () => {
    const unreachable = harness({
      respond: () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect((await runWorktreeCommand(parseWorktreeCommand(["list"]), unreachable.deps)).exitCode)
      .toBe(WORKTREE_EXIT_NO_CONTEXT);
    const notAHub = harness({ respond: () => new Response("<html>a different server</html>") });
    const outcome = await runWorktreeCommand(parseWorktreeCommand(["list"]), notAHub.deps);
    expect(outcome.exitCode).toBe(WORKTREE_EXIT_NO_CONTEXT);
    expect(outcome.stderr).toContain("did not answer as a Uatu Hub");
  });

  test("the token travels in one header and reaches the context's origin only", async () => {
    const { deps, calls } = harness();
    await runWorktreeCommand(parseWorktreeCommand(["list"]), deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4700/api/hub/worktrees?source=atlas");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("uatu worktree operations", () => {
  test("list renders the repository's checkouts and, with --json, the contract DTO", async () => {
    const respond = () => Response.json({ inventory: inventory([{ ...child, main: false }]) });
    const text = await runWorktreeCommand(parseWorktreeCommand(["list"]), harness({ respond }).deps);
    expect(text.exitCode).toBe(WORKTREE_EXIT_OK);
    expect(text.stdout).toContain("feature/login");
    expect(text.stdout).toContain("from main");
    const structured = await runWorktreeCommand(parseWorktreeCommand(["list", "--json"]), harness({ respond }).deps);
    expect(JSON.parse(structured.stdout)).toMatchObject({ ok: true, command: "list" });
    expect(JSON.parse(structured.stdout).inventory.checkouts).toHaveLength(1);
  });

  test("create posts the approved mode and leaves the destination to the Hub", async () => {
    const { deps, calls } = harness({
      respond: () => Response.json({
        ok: true, operationId: "op-1", kind: "create", phase: "complete",
        checkout: child, registered: true, started: false,
      }),
    });
    const outcome = await runWorktreeCommand(
      parseWorktreeCommand(["create", "--new-branch", "feature/login", "--from", "main"]),
      deps,
    );
    expect(outcome.exitCode).toBe(WORKTREE_EXIT_OK);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4700/api/hub/worktrees/create");
    expect(calls[0]!.body).toEqual({
      sourceWorkspaceId: "atlas", mode: "new-branch", branch: "feature/login", baseRef: "main", start: false,
    });
    // No destination, folder or path is ever sent.
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/path|folder|destination/i);
    expect(outcome.stdout).toContain("Created feature/login");
    expect(outcome.stdout).toContain("start it with --start");
  });

  test("a refusal is structured, carries its phase and retry, and exits 1", async () => {
    const respond = () => Response.json({
      ok: false, operationId: "op-2", kind: "create", phase: "registering",
      error: { code: "registration-failed", message: "The checkout was kept.", retry: "retry-registration", phase: "registering" },
      retainedCheckout: child,
    });
    const text = await runWorktreeCommand(
      parseWorktreeCommand(["create", "--branch", "release"]),
      harness({ respond }).deps,
    );
    expect(text.exitCode).toBe(WORKTREE_EXIT_REFUSED);
    expect(text.stderr).toContain("The checkout was kept.");
    expect(text.stderr).toContain("retry registration");
    expect(text.stderr).toContain("reached phase: registering");
    const structured = await runWorktreeCommand(
      parseWorktreeCommand(["create", "--branch", "release", "--json"]),
      harness({ respond }).deps,
    );
    expect(structured.exitCode).toBe(WORKTREE_EXIT_REFUSED);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: false,
      command: "create",
      result: { error: { code: "registration-failed", retry: "retry-registration", phase: "registering" } },
    });
  });

  test("open reports without starting, and reports a failed explicit start", async () => {
    const reporting = harness({
      respond: () => Response.json({
        ok: true, operationId: "op-open", kind: "start", phase: "complete", checkout: child, registered: true, started: false,
      }),
    });
    const reported = await runWorktreeCommand(parseWorktreeCommand(["open", "feature/login"]), reporting.deps);
    expect(reported.exitCode).toBe(WORKTREE_EXIT_OK);
    expect(reporting.calls[0]!.body).toEqual({ sourceWorkspaceId: "atlas", reference: "feature/login", start: false });
    expect(reported.stdout).toContain("is stopped");

    const failing = harness({
      respond: () => Response.json({
        ok: true, operationId: "op-open", kind: "start", phase: "complete", checkout: child, registered: true, started: false,
        startError: { code: "start-failed", message: "The workspace could not be started.", retry: "retry-start" },
      }),
    });
    const failed = await runWorktreeCommand(parseWorktreeCommand(["open", "feature/login", "--start"]), failing.deps);
    // A failed explicit start does not fail the operation; it reports why.
    expect(failed.exitCode).toBe(WORKTREE_EXIT_OK);
    expect(failed.stdout).toContain("not started: The workspace could not be started.");
  });

  test("remove always sends the explicit confirmation and never a force", async () => {
    const { deps, calls } = harness({
      respond: () => Response.json({
        ok: true, operationId: "op-3", kind: "delete", phase: "complete", registered: false, started: false,
      }),
    });
    const outcome = await runWorktreeCommand(
      parseWorktreeCommand(["remove", "feature/login", "--confirm-delete", "--stop"]),
      deps,
    );
    expect(outcome.exitCode).toBe(WORKTREE_EXIT_OK);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4700/api/hub/worktrees/delete");
    expect(calls[0]!.body).toEqual({
      sourceWorkspaceId: "atlas", reference: "feature/login", confirm: true, stop: true,
    });
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/force/i);
    expect(outcome.stdout).toContain("The branch was kept.");
  });

  test("a result this version cannot parse is a context error, not a guess", async () => {
    const { deps } = harness({ respond: () => Response.json({ ok: true, kind: "sideways" }) });
    const outcome = await runWorktreeCommand(parseWorktreeCommand(["open", "x"]), deps);
    expect(outcome.exitCode).toBe(WORKTREE_EXIT_NO_CONTEXT);
    expect(outcome.stderr).toContain("this version does not understand");
  });
});

describe("uatu worktree secret and fallback discipline", () => {
  test("no output on any path can contain the token", async () => {
    const responses: Array<() => Response> = [
      () => Response.json({ inventory: inventory([child]) }),
      () => Response.json({ error: `unauthorized ${TOKEN}` }, { status: 400 }),
      () => Response.json({ ok: false, operationId: "op-x", kind: "create", error: { code: "internal", message: `failed for ${TOKEN}`, retry: "none" } }),
      () => new Response("not json"),
      () => Response.json({ error: "nope" }, { status: 401 }),
    ];
    const commands = [["list"], ["list", "--json"], ["create", "--branch", "main"], ["open", "x"], ["remove", "x", "--confirm-delete"]];
    for (const respond of responses) {
      for (const argv of commands) {
        const { deps } = harness({ respond });
        const outcome = await runWorktreeCommand(parseWorktreeCommand(argv), deps);
        expect(outcome.stdout).not.toContain(TOKEN);
        expect(outcome.stderr).not.toContain(TOKEN);
        expect(outcome.stdout).not.toContain("super-secret-value");
        expect(outcome.stderr).not.toContain("super-secret-value");
      }
    }
  });

  test("the client cannot run Git or spawn anything, and has no fallback path", () => {
    // Structural, not behavioral: the modules must not even be able to.
    for (const file of ["worktree-client.ts", "worktree-parse.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/Bun\.spawn|child_process|execFile|spawnSync|\bexecSync\b/);
      // "git" appears only inside prose, never as a command being built.
      expect(source).not.toMatch(/["'`]git["'`]|\[\s*["'`]git["'`]/);
      expect(source).not.toMatch(/\.git\b/);
    }
  });
});
