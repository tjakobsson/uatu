// Port-availability probe used by `cli.ts` to walk upward from the default
// port until it finds a free one. Pulled out so it's testable in isolation
// (the cli.ts module has top-level side effects and can't be unit-imported).
//
// There's a tiny TOCTOU window between probe and the eventual `Bun.serve`
// bind — for a single-user local-dev tool that's acceptable; the alternative
// would be a full retry loop around Bun.serve, which complicates closures.

import { createServer as createNetServer } from "node:net";

export const DEFAULT_PORT_SCAN_LIMIT = 32;

export async function findFreePort(start: number, limit: number = DEFAULT_PORT_SCAN_LIMIT): Promise<number> {
  for (let i = 0; i < limit; i++) {
    const candidate = start + i;
    if (candidate > 65535) break;
    if (await canBind(candidate)) return candidate;
  }
  // Fall through to the original port and let the caller's bind produce the
  // real EADDRINUSE — the runtime error is more informative than ours.
  return start;
}

export function canBind(port: number, hostname = "127.0.0.1"): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    try {
      probe.listen(port, hostname);
    } catch {
      resolve(false);
    }
  });
}
