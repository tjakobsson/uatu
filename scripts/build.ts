#!/usr/bin/env bun
// Compiles the single-file uatu binary. With no arguments this is a host
// build to `dist/uatu`; the release workflow passes `--target` /
// `--outfile` to cross-compile the four published platforms from one
// Linux runner (no native deps, so `bun build --compile --target` is all
// it takes).
//
//   bun run scripts/build.ts
//   bun run scripts/build.ts --target=bun-darwin-arm64 --outfile=dist/uatu-darwin-arm64
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

const git = readGitBuildInfo(PACKAGE_VERSION);
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

const label = target ? ` [${target}]` : "";
console.log(`built ${path.relative(root, outfile)}${label} (v${buildInfo.version} · ${buildInfo.commitShort})`);
