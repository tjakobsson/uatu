// Retirement check for `.uatuignore`. The file is no longer parsed (see
// ignore-engine.ts and the `replace-tree-with-pierre` OpenSpec change); this
// module emits a one-line stderr warning per session per watched root that has
// one, telling users to move its patterns into `.uatu.json tree.exclude`. The
// warning MUST NOT repeat on refreshes and MUST NOT prevent the session from
// starting.

import { promises as fs } from "node:fs";
import path from "node:path";

const warnedPaths = new Set<string>();

export type WarnUatuignoreOptions = {
  // Sink for the warning. Defaults to `console.warn`. Override in tests.
  log?: (message: string) => void;
};

// Emit at-most-once-per-session warnings for any watch root that still has a
// `.uatuignore` file. Safe to call multiple times — subsequent calls are no-ops
// for already-warned absolute paths.
export async function warnAboutRetiredUatuignore(
  rootPaths: readonly string[],
  options: WarnUatuignoreOptions = {},
): Promise<void> {
  const log = options.log ?? (message => console.warn(message));

  await Promise.all(
    rootPaths.map(async rootPath => {
      const filePath = path.join(rootPath, ".uatuignore");
      if (warnedPaths.has(filePath)) {
        return;
      }

      const exists = await fs
        .stat(filePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        return;
      }

      warnedPaths.add(filePath);
      log(
        `[uatu] ${filePath} is no longer honored. Move its patterns into .uatu.json tree.exclude.`,
      );
    }),
  );
}

// Test-only hook so suites can re-run the warning against the same paths
// without leaking the suppress-once cache across tests.
export function __resetUatuignoreWarningCacheForTests(): void {
  warnedPaths.clear();
}
