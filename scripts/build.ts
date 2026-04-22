#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_VERSION, readGitBuildInfo, type BuildInfo } from "../src/version";

const git = readGitBuildInfo(PACKAGE_VERSION);
const buildInfo: BuildInfo = {
  ...git,
  release: true,
};

const root = path.resolve(import.meta.dir, "..");
const outDir = path.join(root, "dist");
await mkdir(outDir, { recursive: true });

const result = Bun.spawnSync({
  cmd: [
    "bun",
    "build",
    "--compile",
    `--define=__UATU_BUILD__=${JSON.stringify(buildInfo)}`,
    path.join(root, "src/cli.ts"),
    "--outfile",
    path.join(outDir, "uatu"),
  ],
  stdout: "inherit",
  stderr: "inherit",
  cwd: root,
});

if (result.exitCode !== 0) {
  process.exit(result.exitCode ?? 1);
}

console.log(`built dist/uatu (v${buildInfo.version} · ${buildInfo.commitShort})`);
