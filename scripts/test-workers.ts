// How many workers the unit (`bun run test:ci`) and e2e (`playwright test`)
// runners start: one per available core, from 1 up to MAX_WORKERS.
// UATU_TEST_WORKERS sets the count exactly, past the ceiling too.
//
// CI's four-core runners get the four workers they always had. The ceiling is
// a resource limit, not a port limit: each e2e worker drives a browser and its
// own servers, and CI measures only four, so eight is a cautious step past
// that. Ports allow far more: playwright.config.ts refuses any count whose
// port ranges would collide (checkPortLayout in tests/e2e/ports.ts).

import os from "node:os";

export const MAX_WORKERS = 8;

export function availableCores(): number {
  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
}

export function testWorkers(
  env: Record<string, string | undefined> = process.env,
  cores: number = availableCores(),
): number {
  const override = env.UATU_TEST_WORKERS;
  if (override !== undefined && override !== "") {
    if (!/^[1-9]\d*$/.test(override)) {
      throw new Error(`UATU_TEST_WORKERS must be a positive integer, not ${JSON.stringify(override)}`);
    }
    return Number(override);
  }
  return Math.min(MAX_WORKERS, Math.max(1, cores));
}
