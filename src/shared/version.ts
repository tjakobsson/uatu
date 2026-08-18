import { version as packageJsonVersion } from "../../package.json";

export type BuildInfo = {
  version: string;
  branch: string;
  commitSha: string;
  commitShort: string;
  buildTime: string;
  release: boolean;
};

declare const __UATU_BUILD__: BuildInfo | undefined;

const INJECTED_BUILD: BuildInfo | undefined =
  typeof __UATU_BUILD__ === "undefined" ? undefined : __UATU_BUILD__;

// Single source of truth for the version is package.json — the release
// workflow's tag guard checks package.json, so deriving from it here keeps
// the embedded version incapable of drifting from the released tag.
export const PACKAGE_VERSION: string = packageJsonVersion;

// Hand-bumped integer marking contract breaks between the workspace server
// and the web assets bundled with the same product build. This is only part
// of the stale-web-client handshake; external clients use the independent
// public API revisions below.
export const BUNDLED_WEB_REVISION = 1;

// Public wire-contract compatibility identities. Breaking changes increment
// only the affected domain; product and bundled-web changes do not.
export const HUB_API_REVISION = 1;
export const WORKSPACE_API_REVISION = 4;

function runGit(args: string[]): string | null {
  try {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      stdout: "pipe",
      stderr: "ignore",
    });

    if (result.exitCode !== 0) {
      return null;
    }

    const output = result.stdout.toString().trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

export function readGitBuildInfo(version: string = PACKAGE_VERSION): BuildInfo {
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "main";
  const commitSha = runGit(["rev-parse", "HEAD"]) ?? "unknown";
  const commitShort = commitSha === "unknown" ? "unknown" : commitSha.slice(0, 7);

  return {
    version,
    branch,
    commitSha,
    commitShort,
    buildTime: new Date().toISOString(),
    release: false,
  };
}

export const BUILD: BuildInfo = INJECTED_BUILD ?? readGitBuildInfo();

export const VERSION = BUILD.version;

export function formatBuildIdentifier(build: BuildInfo): string {
  if (build.release) {
    return `v${build.version} · ${build.commitShort}`;
  }

  if (build.commitSha === "unknown") {
    return `${build.branch}@unknown`;
  }

  return `${build.branch}@${build.commitShort}`;
}
