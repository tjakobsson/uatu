// Session contract: how the Hub starts a workspace session and how the
// session says it is ready.
//
//   spawn  `uatu serve <folder> --no-open --exit-on-stdin-close
//          --hub-policy-bootstrap --port 0 --base-path /s/<id>/
//          --manifest-scope origin`, with stdin, stdout and stderr as pipes,
//          descriptor 3 as a private socket for the policy bootstrap, and an
//          explicitly passed environment
//   ready  the first complete stdout line containing an `http://` URL:
//          `http://127.0.0.1:<port><basePath>?t=<token>`
//   exit   the Hub holds the session's stdin open for its whole life; EOF
//          (including by Hub death) is the session's signal to exit
//   stop   SIGTERM is the clean stop; SIGKILL follows SIGTERM_GRACE_MS later

// INACTIVITY timeout, not a startup deadline: the session emits periodic
// progress lines while preparing (a large tree's watcher setup alone can
// take minutes — chokidar attaches at roughly 5ms per file on macOS), so
// any stdout output re-arms the timer and only a silent session — hung, or an
// old build that predates the heartbeat AND takes longer than this — is
// killed. The session's heartbeat is itself capped (its
// STARTUP_HEARTBEAT_MAX_DURATION_SECONDS), so a session that wedges without
// exiting stops re-arming this timer and is reaped one inactivity window
// after that cap.
export const SESSION_STARTUP_INACTIVITY_MS = 30_000;

// How long a session has between the Hub's SIGTERM and its SIGKILL. A
// session's own shutdown work must fit well inside it (the Claude provider's
// shutdown budget is held to it by a test).
export const SIGTERM_GRACE_MS = 3_000;

// stdin stays a pipe the Hub holds open; descriptor 3 carries the policy
// bootstrap (see bootstrap.ts).
export const SESSION_STDIO = ["pipe", "pipe", "pipe", "socket-fd"] as const;

export const POLICY_BOOTSTRAP_FLAG = "--hub-policy-bootstrap";
// Marks a session the Hub supervises: it exits when its stdin reaches EOF,
// and it is what admits `serve` outside a source run.
export const EXIT_ON_STDIN_CLOSE_FLAG = "--exit-on-stdin-close";

// How the process was started. A source run (`bun run src/cli.ts …`: the dev
// Hub's sessions, the stdin-close test, the base-path e2e) has the script
// path in Bun.argv[1]; a compiled binary has its extensionless virtual entry
// (`/$bunfs/root/uatu`) there.
export function isSourceRun(scriptPath: string | null = Bun.argv[1] ?? null): boolean {
  return scriptPath !== null && /\.(ts|js)$/.test(scriptPath);
}

// How to invoke the uatu CLI again from the current process: a compiled
// binary is its own entry point, a source run needs the script path.
export function resolveUatuArgv(): string[] {
  const scriptPath = typeof Bun.argv[1] === "string" ? Bun.argv[1] : "";
  return isSourceRun(scriptPath) ? [process.execPath, scriptPath] : [process.execPath];
}

export function sessionServeArgv(uatuArgv: readonly string[], folder: string, basePath: string): string[] {
  return [
    ...uatuArgv,
    "serve",
    folder,
    "--no-open",
    EXIT_ON_STDIN_CLOSE_FLAG,
    POLICY_BOOTSTRAP_FLAG,
    "--port",
    "0",
    "--base-path",
    basePath,
    // The Hub owns its origin root, so its sessions declare the whole
    // origin as PWA scope — an installed webapp treats the dashboard,
    // login, and sibling sessions as in-app (no iOS browser chrome).
    "--manifest-scope",
    "origin",
  ];
}

// Session side: whether this `serve` invocation was started by the Hub with
// a policy bootstrap on descriptor 3. Removes the flag, which the CLI parser
// does not know.
export function takePolicyBootstrapFlag(argv: string[]): boolean {
  if (argv[0] !== "serve" || !argv.includes(POLICY_BOOTSTRAP_FLAG)) return false;
  argv.splice(argv.indexOf(POLICY_BOOTSTRAP_FLAG), 1);
  return true;
}

// The ready line: the session URL, carrying the base path so the Hub can
// load the session without reconstructing the prefix. At the default "/" the
// output stays exactly what it always was — including the slashless
// origin-only form when no token is given.
export function formatReadyLine(port: number, basePath: string, token?: string): string {
  const origin = `http://127.0.0.1:${port}`;
  if (typeof token === "string") {
    return `${origin}${basePath}?t=${encodeURIComponent(token)}`;
  }
  return basePath === "/" ? origin : `${origin}${basePath}`;
}

export type ReadyLine = {
  // The URL exactly as printed.
  text: string;
  url: URL;
  endpoint: { hostname: string; port: number };
  // Null when the line carries no `t` (the untrusted E2E harness mode).
  token: string | null;
};

// Reads the ready line out of COMPLETE stdout lines: the first `http://` URL
// in them, or null when there is none yet. Throws when that URL is malformed.
export function parseReadyLine(lines: string): ReadyLine | null {
  const match = lines.match(/http:\/\/\S+/);
  if (!match) return null;
  const url = new URL(match[0]);
  return {
    text: match[0],
    url,
    endpoint: { hostname: url.hostname, port: Number.parseInt(url.port, 10) },
    token: url.searchParams.get("t"),
  };
}

// Feeds stdout chunks to the parser, complete lines only. Matching the raw
// buffer would accept a chunk-split fragment ("http://127" parses as host
// 0.0.0.127 with a NaN port) and register an unreachable session. Scanned
// lines are dropped so the buffer stays bounded.
export function createReadyLineScanner(): { push(chunk: string): ReadyLine | null } {
  let buffered = "";
  return {
    push(chunk) {
      buffered += chunk;
      const lastNewline = buffered.lastIndexOf("\n");
      if (lastNewline < 0) return null;
      const ready = parseReadyLine(buffered.slice(0, lastNewline));
      if (!ready) buffered = buffered.slice(lastNewline + 1);
      return ready;
    },
  };
}
