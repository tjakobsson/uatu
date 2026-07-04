// CLI argument parsing and help/version text. Side-effect-free on import so
// the unit suite can exercise `parseCommand` directly — the executable
// entrypoint (`src/cli.ts`) imports from here and owns all process wiring.

import { DEFAULT_RESPECT_GITIGNORE } from "../server/roots";
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
};

export type ParsedCommand =
  | { kind: "watch"; options: WatchOptions }
  | { kind: "help" }
  | { kind: "version" };

export function usageText(build: BuildInfo = BUILD): string {
  return `uatu ${formatBuildIdentifier(build)}

Usage:
  uatu [serve] [PATH...] [--force] [--no-open] [--no-follow] [--no-gitignore] [--port <PORT>] [--debug]
  uatu --help
  uatu --version

The 'serve' command is the default: 'uatu docs' and 'uatu serve docs' are
equivalent. 'uatu watch' is a deprecated alias for 'uatu serve'.

Options:
  --no-open               Do not open a browser automatically
  --no-follow             Start with follow mode disabled
  --no-gitignore          Do not honor .gitignore patterns when indexing files
  --force                 Serve non-git paths anyway; indexing may be slow
  -p, --port              Bind the local server to a specific port
  --debug                 Record verbose 1Hz counter history under \$XDG_CACHE_HOME/uatu (or ~/.cache/uatu)
  --no-watchdog           Suppress the companion watchdog subprocess (escape hatch — leaves no recovery on freeze)
  --watchdog-timeout <ms> Override the heartbeat staleness threshold (default: 30000)
  -h, --help              Show help
  -V, --version           Show version
`;
}

export function versionText(build: BuildInfo = BUILD): string {
  return formatBuildIdentifier(build);
}

export function parseCommand(
  argv: string[],
  warn: (message: string) => void = message => process.stderr.write(message),
): ParsedCommand {
  if (argv[0] === "-h" || argv[0] === "--help") {
    return { kind: "help" };
  }

  if (argv[0] === "-V" || argv[0] === "--version") {
    return { kind: "version" };
  }

  // Command dispatch: `serve` is canonical. `watch` forwards with a one-line
  // deprecation warning (stderr only, so piped-stdout consumers capturing the
  // URL are unaffected). Anything else — flags, paths, or nothing at all — is
  // the bare-invocation default and behaves exactly as `serve`.
  let rest = argv;
  if (argv[0] === "serve") {
    rest = argv.slice(1);
  } else if (argv[0] === "watch") {
    warn("warning: 'uatu watch' is deprecated; use 'uatu serve'\n");
    rest = argv.slice(1);
  }

  let openBrowser = true;
  let follow = true;
  let port = DEFAULT_PORT;
  let portExplicit = false;
  let respectGitignore = DEFAULT_RESPECT_GITIGNORE;
  let force = false;
  let debug = false;
  let watchdogEnabled = true;
  let watchdogTimeoutMs: number | undefined;
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
    },
  };
}
