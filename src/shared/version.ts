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

export const PACKAGE_VERSION = "0.1.0";

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
