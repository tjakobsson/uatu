// TTY startup output: the ASCII banner and the transient indexing status.
// Both are TTY-gated so piped stdout receives only the URL line.

import type { WatchEntry } from "../server/roots";

export const STARTUP_BANNER = `\
██╗   ██╗ █████╗ ████████╗██╗   ██╗
██║   ██║██╔══██╗╚══██╔══╝██║   ██║
██║   ██║███████║   ██║   ██║   ██║
██║   ██║██╔══██║   ██║   ██║   ██║
╚██████╔╝██║  ██║   ██║   ╚██████╔╝
 ╚═════╝ ╚═╝  ╚═╝   ╚═╝    ╚═════╝

I observe. I follow. I render.`;

// The one line every consumer of piped stdout parses (the desktop wrapper,
// the hub's local backend): the session URL, carrying the base path so a
// supervisor can load the session without reconstructing the prefix. At the
// default "/" the output stays exactly what it always was — including the
// slashless origin-only form when the terminal is unavailable.
export function formatSessionUrl(port: number, basePath: string, token?: string): string {
  const origin = `http://127.0.0.1:${port}`;
  if (typeof token === "string") {
    return `${origin}${basePath}?t=${encodeURIComponent(token)}`;
  }
  return basePath === "/" ? origin : `${origin}${basePath}`;
}

// Direct `uatu serve` is deprecated as a public command — `uatu hub` is the
// way to run uatu. serve lives on as the internal session child the hub
// spawns.
export const SERVE_DEPRECATION_WARNING =
  "'uatu serve' is deprecated as a public command and will be removed in a future release — run 'uatu hub' instead (see docs/SELF-HOSTING.md)";

// Whether a serve/watch invocation is user-shaped and should see the
// deprecation line. Internal invocations stay quiet: hub-spawned session
// children carry --exit-on-stdin-close (the supervising-wrapper contract —
// the hub controls the child argv), and source runs (`bun run src/cli.ts`,
// i.e. `bun run dev`) are the repository's own harness, detected the same
// way the watchdog re-exec detects them.
export function shouldWarnServeDeprecation(
  options: { exitOnStdinClose: boolean },
  scriptPath: string | null = typeof Bun.argv[1] === "string" ? Bun.argv[1] : null,
): boolean {
  if (options.exitOnStdinClose) {
    return false;
  }
  if (scriptPath !== null && /\.(ts|js)$/.test(scriptPath)) {
    return false;
  }
  return true;
}

export function printStartupBanner(
  stream: { isTTY?: boolean; write(chunk: string): unknown } = process.stdout,
): void {
  if (!stream.isTTY) {
    return;
  }

  stream.write(`\n${STARTUP_BANNER}\n\n`);
}

function indexingLabel(entries: WatchEntry[]): string {
  return entries.length === 1 ? entries[0]!.absolutePath : `${entries.length} roots`;
}

export function printIndexingStatus(
  entries: WatchEntry[],
  stream: { isTTY?: boolean; write(chunk: string): unknown } = process.stdout,
): () => void {
  if (!stream.isTTY) {
    return () => undefined;
  }

  const message = `Indexing ${indexingLabel(entries)}...`;
  let cleared = false;
  stream.write(message);

  return () => {
    if (cleared) {
      return;
    }
    cleared = true;
    stream.write(`\r${" ".repeat(message.length)}\r`);
  };
}

export const STARTUP_HEARTBEAT_INTERVAL_SECONDS = 5;

// Absolute ceiling on how long the helper keeps re-arming the supervisor's
// inactivity timer. A start still preparing past this point is treated as
// wedged: the heartbeat stops and the supervisor's inactivity timeout takes
// over. Generous on purpose — at ~5ms per watched file this covers trees an
// order of magnitude larger than the slowest observed start (~55s).
export const STARTUP_HEARTBEAT_MAX_DURATION_SECONDS = 15 * 60;

// The heartbeat loop as sh argv. printf (not echo) so an arbitrary root
// path in $0 is emitted verbatim, and the label/interval/cap/pid travel as
// positional parameters — never interpolated into the script string.
//
// The loop is self-limiting in two ways so no JS-side cleanup path is
// load-bearing: it stops after $2 iterations (the absolute duration cap),
// and it probes the serving process — its PID passed in $3, because $PPID
// discovered inside the helper is wrong when the parent dies before the
// shell starts and it launches already reparented — with kill -0 before
// every line, so a parent that dies without calling the stop callback
// (SIGKILL, the hub's terminate() signaling only the child PID) orphans
// the helper for at most one interval.
export function startupHeartbeatArgv(
  label: string,
  intervalSeconds: number,
  maxIterations: number,
  parentPid: number = process.pid,
): string[] {
  return [
    "sh",
    "-c",
    'i=0; while [ "$i" -lt "$2" ] && kill -0 "$3" 2>/dev/null; do printf \'uatu: starting — indexing %s\\n\' "$0"; sleep "$1"; i=$((i+1)); done',
    label,
    String(intervalSeconds),
    String(maxIterations),
    String(parentPid),
  ];
}

// Supervised starts announce progress periodically so the supervising hub
// can tell a slow start — a large tree's cold watcher setup can take
// minutes — from a hung child, which its startup inactivity timeout must
// still catch. Supervision is detected by the same marker as
// shouldWarnServeDeprecation: the hub always passes --exit-on-stdin-close.
// A merely redirected direct `uatu serve` keeps its exact stdout contract
// (the URL line and nothing else). The lines never contain a URL, so every
// supervisor's URL-line scan (which drops non-matching lines by contract)
// skips them; TTY starts keep the inline indexing status instead.
//
// The heartbeat is a helper PROCESS inheriting our stdout pipe, not an
// in-process timer: watcher setup attaches Bun's fs.watch synchronously per
// directory entry and starves the event loop for the whole preparation
// window (observed: 5 timer ticks in 47s on a 4k-file tree), so a timer
// here would fire exactly never while it is needed most. Each printf line
// is one atomic pipe write well under PIPE_BUF, so it can interleave with
// the URL line only between lines, never inside one.
export function startSupervisedStartupHeartbeat(
  entries: WatchEntry[],
  options: { exitOnStdinClose: boolean },
  stream: { isTTY?: boolean } = process.stdout,
  intervalSeconds: number = STARTUP_HEARTBEAT_INTERVAL_SECONDS,
  spawner: (argv: string[], options: { stdout: "inherit"; stderr: "ignore"; stdin: "ignore" }) => { kill(): void } = (argv, options) => Bun.spawn(argv, options),
): () => void {
  // Windows deliberately keeps the pre-heartbeat behavior: the supervisor's
  // inactivity window is the whole startup budget there. The sh helper has
  // no portable Windows equivalent, and with no Windows CI or release
  // binaries (README: source installs only) a cmd/powershell keepalive
  // would ship unverifiable; revisit when a Windows runner exists.
  if (!options.exitOnStdinClose || stream.isTTY || process.platform === "win32") {
    return () => undefined;
  }

  const maxIterations = Math.max(1, Math.ceil(STARTUP_HEARTBEAT_MAX_DURATION_SECONDS / intervalSeconds));
  let helper: { kill(): void } | undefined;
  try {
    helper = spawner(startupHeartbeatArgv(indexingLabel(entries), intervalSeconds, maxIterations), {
      // fd 1 is the supervisor's pipe; the helper writes to it directly.
      // The stop callback is the fast path; the loop's own parent probe
      // and iteration cap bound the helper when no cleanup here runs.
      stdout: "inherit",
      stderr: "ignore",
      stdin: "ignore",
    });
  } catch {
    // Best-effort: a start without heartbeats degrades to the supervisor's
    // plain inactivity timeout, exactly the pre-heartbeat behavior.
    return () => undefined;
  }
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      helper?.kill();
    } catch {
      // Already exited.
    }
  };
}
