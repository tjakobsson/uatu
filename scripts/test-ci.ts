#!/usr/bin/env bun
// `bun run test:ci`: the unit suite in parallel, one worker per available
// core (scripts/test-workers.ts), the committed timings starting the slowest
// files first. Extra arguments pass through, e.g. `--update-timings`.

import { testWorkers } from "./test-workers";

export function unitTestCommand(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  cores?: number,
): string[] {
  return [
    process.execPath, "test", `--parallel=${testWorkers(env, cores)}`,
    "--timings=tests/unit-timings.json", ...args,
  ];
}

if (import.meta.main) {
  const command = unitTestCommand(process.argv.slice(2));
  console.error(`$ bun ${command.slice(1).join(" ")}`);
  const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await child.exited);
}
