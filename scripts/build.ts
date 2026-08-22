#!/usr/bin/env bun
// Compiles the single-file uatu binary. With no arguments this is a host
// build to `dist/uatu`; the release workflow passes `--target` /
// `--outfile` to cross-compile the four published platforms from one
// Linux runner (no native deps, so `bun build --compile --target` is all
// it takes).
//
//   bun run scripts/build.ts
//   bun run scripts/build.ts --target=bun-darwin-arm64 --outfile=dist/uatu-darwin-arm64
//
// `--version` overrides the embedded version string (default: package.json) —
// the edge workflow stamps `<base>-edge.<timestamp>.<shortsha>` so nightly
// binaries self-identify and the uatu-edge formula's self-test passes.
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_VERSION, readGitBuildInfo, type BuildInfo } from "../src/shared/version";

function readFlag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error(`${name} requires a value`);
        process.exit(1);
      }
      return value;
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

const argv = process.argv.slice(2);
const target = readFlag(argv, "--target");
const outfileArg = readFlag(argv, "--outfile");
const versionOverride = readFlag(argv, "--version");

const git = readGitBuildInfo(versionOverride ?? PACKAGE_VERSION);
const buildInfo: BuildInfo = {
  ...git,
  release: true,
};

const root = path.resolve(import.meta.dir, "..");
const outfile = path.resolve(root, outfileArg ?? "dist/uatu");
await mkdir(path.dirname(outfile), { recursive: true });

const result = Bun.spawnSync({
  cmd: [
    "bun",
    "build",
    "--compile",
    // Minify the bundle — the SPA's client chunk carries bundled syntax
    // grammars and is size-critical for hub-served (remote) sessions.
    "--minify",
    ...(target ? [`--target=${target}`] : []),
    `--define=__UATU_BUILD__=${JSON.stringify(buildInfo)}`,
    path.join(root, "src/cli.ts"),
    "--outfile",
    outfile,
  ],
  stdout: "inherit",
  stderr: "inherit",
  cwd: root,
});

if (result.exitCode !== 0) {
  process.exit(result.exitCode ?? 1);
}

// Bun 1.4.0 emits macOS binaries whose embedded signature does not match the
// bytes it wrote — `codesign -v` reports "code or signature have been
// modified" — and the arm64 kernel SIGKILLs those on exec: exit 137, no
// output, nothing on stderr. That is what broke the Edge nightly, whose smoke
// step could only report that the server never came up.
//
// Re-signing ad-hoc writes a valid signature over the finished binary.
//
// `codesign` is macOS-only, so a darwin target cross-compiled from Linux
// cannot be repaired here and is warned about loudly instead. Nothing later
// in the CLI pipeline signs it: release.yml's macOS job signs the UatuCode
// Desktop .app bundles, not these binaries.
const targetsDarwin = target ? target.includes("darwin") : process.platform === "darwin";
if (targetsDarwin) {
  if (process.platform === "darwin") {
    const signed = Bun.spawnSync({
      cmd: ["codesign", "--force", "--sign", "-", outfile],
      stdout: "inherit",
      stderr: "inherit",
    });
    if (signed.exitCode !== 0) {
      console.error(`codesign failed for ${path.relative(root, outfile)} — the binary would be killed on launch`);
      process.exit(signed.exitCode ?? 1);
    }
  } else {
    console.error(
      `warning: ${path.relative(root, outfile)} targets darwin but was built on ${process.platform}, ` +
        "where codesign is unavailable. Bun 1.4.0 emits an invalid signature that macOS arm64 " +
        "SIGKILLs on exec, so this artifact must be signed on a macOS host before it is shipped.",
    );
  }
}

const label = target ? ` [${target}]` : "";
console.log(`built ${path.relative(root, outfile)}${label} (v${buildInfo.version} · ${buildInfo.commitShort})`);
