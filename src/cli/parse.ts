// CLI argument parsing and help/version text. Side-effect-free on import so
// the unit suite can exercise `parseCommand` directly — the executable
// entrypoint (`src/cli.ts`) imports from here and owns all process wiring.

import { DEFAULT_HUB_PORT, defaultHubConfigPath } from "../hub/config";
import { DEFAULT_RESPECT_GITIGNORE } from "../server/roots";
import { normalizeBasePath } from "../shared/base-path";
import { BUILD, formatBuildIdentifier, type BuildInfo } from "../shared/version";

// Stable default so the eventual PWA install identity (origin =
// http://127.0.0.1:<port>) is consistent across restarts. If 4711 is taken,
// cli.ts walks upward to the first free port — but only when the user did NOT
// pass `--port`, which is a deliberate choice. An explicit port is honored
// strictly so that a user binding to a fixed port doesn't get silently rolled.
export const DEFAULT_PORT = 4711;

export type WatchOptions = {
  rootPaths: string[];
  openBrowser: boolean;
  follow: boolean;
  port: number;
  // True when the user passed `-p` / `--port`. Roll-on-conflict is only
  // applied to the default port (false). An explicit `--port 0` keeps this
  // true so we don't double-roll an already-ephemeral request.
  portExplicit: boolean;
  respectGitignore: boolean;
  force: boolean;
  // Diagnostic flags — see `watch-freeze-diagnostics` capability.
  debug: boolean;
  watchdogEnabled: boolean;
  // Undefined means "use the watchdog's default (30s) or whatever
  // UATU_HEARTBEAT_TIMEOUT_MS is set to in the env"; a number forces that
  // value over the env.
  watchdogTimeoutMs?: number;
  // Exit cleanly when stdin reaches EOF. For supervising wrapper processes
  // (e.g. the desktop app) holding our stdin pipe: if the supervisor dies —
  // even by crash — the pipe closes and the server shuts itself down instead
  // of running orphaned.
  exitOnStdinClose: boolean;
  // Absolute path prefix the whole session is served under. Always normalized
  // to lead and trail with "/" ("/" itself for the default). Non-default
  // values are how the hub mounts a session at /s/<workspace-id>/.
  basePath: string;
  // Who owns the origin, for the PWA manifest's `scope`. "base-path" (the
  // default) confines scope to the base path; "origin" widens it to "/" —
  // passed by the hub, which owns its origin root, so installed webapps
  // treat the whole hub as in-app.
  manifestScope: "base-path" | "origin";
};

export type HubOptions = {
  // Path to the hub config file; undefined means the loader's default
  // location ($XDG_CONFIG_HOME/uatu/hub.json or ~/.config/uatu/hub.json).
  configPath?: string;
  // Overrides the listen port; 0 requests an ephemeral port.
  port?: number;
  // Shut down when stdin reaches EOF (supervising-wrapper orphan backstop).
  exitOnStdinClose: boolean;
};

export type ParsedCommand =
  // The session child (hub spawn or source run) — see parseCommand.
  | { kind: "watch"; options: WatchOptions }
  // A user-shaped serve/watch invocation: cli.ts prints serveRemovedText()
  // to stderr and exits non-zero.
  | { kind: "serve-removed" }
  | { kind: "hub"; options: HubOptions }
  // `uatu hub hash-password` — reads the password from stdin and prints the
  // hash to paste into the config's users list.
  | { kind: "hub-hash-password" }
  | { kind: "help" }
  | { kind: "version" };

const SELF_HOSTING_URL = "https://github.com/tjakobsson/uatu/blob/main/docs/SELF-HOSTING.md";

export function usageText(build: BuildInfo = BUILD): string {
  return `uatu ${formatBuildIdentifier(build)}

Usage:
  uatu hub [--config <PATH>] [--port <PORT>] [--exit-on-stdin-close]
  uatu hub hash-password
  uatu --help
  uatu --version

'uatu hub' runs uatu: a daemon that serves a login-gated dashboard, runs
one session per workspace folder, and serves each session under
/s/<workspace-id>/. Every interface requires login against the config's
users list. 'uatu hub hash-password' reads a password from stdin and
prints the hash for a user entry.

Options:
  --config <PATH>         Hub config file (default: \$XDG_CONFIG_HOME/uatu/hub.json, or ~/.config/uatu/hub.json)
  -p, --port <PORT>       Listen on this port instead of the config's (0 picks a free port)
  --exit-on-stdin-close   Shut down when stdin reaches EOF (for supervising wrappers, so a crashed supervisor cannot orphan the hub)
  -h, --help              Show help
  -V, --version           Show version

Setup guide: ${SELF_HOSTING_URL}
`;
}

export function versionText(build: BuildInfo = BUILD): string {
  return formatBuildIdentifier(build);
}

// What a user-shaped serve/watch invocation prints (stderr) before exiting
// non-zero. `uatu serve` was deprecated as a public command in v0.5.0 and
// removed with the hub-brokered live stream. The steps mirror the quick
// start in docs/SELF-HOSTING.md, short enough to follow from a terminal.
export function serveRemovedText(
  configPath: string = defaultHubConfigPath(),
  port: number = DEFAULT_HUB_PORT,
): string {
  return `uatu: 'uatu serve' and 'uatu watch' were removed. uatu runs as a hub now,
and you add folders from its dashboard.

To start:
  1. printf '%s' '<password>' | uatu hub hash-password
  2. Put the printed hash in ${configPath}:
       { "users": [{ "name": "<your-name>", "passwordHash": "<hash from step 1>" }] }
  3. uatu hub
  4. Open http://127.0.0.1:${port}/, sign in, and choose Add Folder.

Remote access, TLS, and running the hub as a service:
${SELF_HOSTING_URL}
`;
}

export { normalizeBasePath };

function parseHubCommand(rest: string[]): ParsedCommand {
  if (rest[0] === "hash-password") {
    if (rest.length > 1) {
      throw new Error("hub hash-password takes no arguments (the password is read from stdin)");
    }
    return { kind: "hub-hash-password" };
  }

  let configPath: string | undefined;
  let port: number | undefined;
  let exitOnStdinClose = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "-h" || arg === "--help") {
      return { kind: "help" };
    }
    if (arg === "--config" || arg.startsWith("--config=")) {
      let value: string | undefined;
      if (arg === "--config") {
        value = rest[index + 1];
        if (!value) {
          throw new Error("missing value for --config");
        }
        index += 1;
      } else {
        value = arg.slice("--config=".length);
      }
      configPath = value;
      continue;
    }
    if (arg === "--exit-on-stdin-close") {
      exitOnStdinClose = true;
      continue;
    }
    if (arg === "-p" || arg === "--port" || arg.startsWith("--port=")) {
      let value: string | undefined;
      if (arg === "-p" || arg === "--port") {
        value = rest[index + 1];
        if (value === undefined) {
          throw new Error(`missing value for ${arg}`);
        }
        index += 1;
      } else {
        value = arg.slice("--port=".length);
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`invalid port: ${value}`);
      }
      port = parsed;
      continue;
    }
    throw new Error(`unknown hub argument: ${arg}`);
  }
  return { kind: "hub", options: { configPath, port, exitOnStdinClose } };
}

// How the process was started, which tells the repository's own harness
// apart from a user. A source run (`bun run src/cli.ts …`: the dev hub's
// children, the stdin-close test, the base-path e2e) has the script path in
// Bun.argv[1]; a compiled binary has its extensionless virtual entry
// (`/$bunfs/root/uatu`) there. The watchdog re-exec and the hub backend's
// resolveUatuArgv detect source runs the same way.
export type ParseContext = { sourceRun: boolean };

export function isSourceRun(scriptPath: string | null = Bun.argv[1] ?? null): boolean {
  return scriptPath !== null && /\.(ts|js)$/.test(scriptPath);
}

export function parseCommand(
  argv: string[],
  context: ParseContext = { sourceRun: isSourceRun() },
): ParsedCommand {
  if (argv[0] === "-h" || argv[0] === "--help") {
    return { kind: "help" };
  }

  if (argv[0] === "-V" || argv[0] === "--version") {
    return { kind: "version" };
  }

  if (argv[0] === "hub") {
    return parseHubCommand(argv.slice(1));
  }

  // `serve` is no longer a user command. It survives as the session child
  // the hub spawns (`serve <folder> --no-open --exit-on-stdin-close …`, see
  // hub/backend.ts; --exit-on-stdin-close is the supervisor contract) and as
  // the repository's source-run harness. Everything else that used to reach
  // serve (`uatu serve`, the removed `watch` alias, a bare `uatu` or
  // `uatu <path>`) gets the hub bootstrap steps, whatever flags follow, so
  // an old habit ends in instructions rather than a flag-parsing error.
  const internal = argv[0] === "serve" && (context.sourceRun || argv.includes("--exit-on-stdin-close"));
  if (!internal) {
    return { kind: "serve-removed" };
  }
  const rest = argv.slice(1);

  let openBrowser = true;
  let follow = true;
  let port = DEFAULT_PORT;
  let portExplicit = false;
  let respectGitignore = DEFAULT_RESPECT_GITIGNORE;
  let force = false;
  let debug = false;
  let watchdogEnabled = true;
  let watchdogTimeoutMs: number | undefined;
  let exitOnStdinClose = false;
  let basePath = "/";
  let manifestScope: "base-path" | "origin" = "base-path";
  const rootPaths: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--no-open") {
      openBrowser = false;
      continue;
    }

    if (arg === "--no-follow") {
      follow = false;
      continue;
    }

    if (arg === "--no-gitignore") {
      respectGitignore = false;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      return { kind: "help" };
    }

    if (arg === "-V" || arg === "--version") {
      return { kind: "version" };
    }

    if (arg === "-p" || arg === "--port") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("missing value for --port");
      }

      const parsed = Number.parseInt(value, 10);
      // 0 = "ask the kernel for an ephemeral port". Anything <0 is invalid.
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`invalid port: ${value}`);
      }

      port = parsed;
      portExplicit = true;
      index += 1;
      continue;
    }

    if (arg === "--debug") {
      debug = true;
      continue;
    }

    if (arg === "--no-watchdog") {
      watchdogEnabled = false;
      continue;
    }

    if (arg === "--exit-on-stdin-close") {
      exitOnStdinClose = true;
      continue;
    }

    if (arg === "--base-path" || arg.startsWith("--base-path=")) {
      let value: string | undefined;
      if (arg === "--base-path") {
        value = rest[index + 1];
        if (!value) {
          throw new Error("missing value for --base-path");
        }
        index += 1;
      } else {
        value = arg.slice("--base-path=".length);
      }
      basePath = normalizeBasePath(value);
      continue;
    }

    if (arg === "--manifest-scope" || arg.startsWith("--manifest-scope=")) {
      let value: string | undefined;
      if (arg === "--manifest-scope") {
        value = rest[index + 1];
        if (!value) {
          throw new Error("missing value for --manifest-scope");
        }
        index += 1;
      } else {
        value = arg.slice("--manifest-scope=".length);
      }
      if (value !== "base-path" && value !== "origin") {
        throw new Error(`invalid --manifest-scope: ${value} (expected base-path or origin)`);
      }
      manifestScope = value;
      continue;
    }

    if (arg === "--watchdog-timeout" || arg.startsWith("--watchdog-timeout=")) {
      let value: string | undefined;
      if (arg === "--watchdog-timeout") {
        value = rest[index + 1];
        if (!value) {
          throw new Error("missing value for --watchdog-timeout");
        }
        index += 1;
      } else {
        value = arg.slice("--watchdog-timeout=".length);
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`invalid --watchdog-timeout value: '${value}'`);
      }
      watchdogTimeoutMs = parsed;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    }

    rootPaths.push(arg);
  }

  // UATU_DEBUG=1 (or any non-empty value) is equivalent to passing --debug.
  // The flag wins on conflict — if --debug is passed, debug stays true; if
  // it isn't, the env var can still enable it.
  if (!debug) {
    const envDebug = process.env.UATU_DEBUG;
    if (typeof envDebug === "string" && envDebug.length > 0) {
      debug = true;
    }
  }

  return {
    kind: "watch",
    options: {
      rootPaths: rootPaths.length > 0 ? rootPaths : ["."],
      openBrowser,
      follow,
      port,
      portExplicit,
      respectGitignore,
      force,
      debug,
      watchdogEnabled,
      watchdogTimeoutMs,
      exitOnStdinClose,
      basePath,
      manifestScope,
    },
  };
}
