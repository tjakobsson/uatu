// Port allocation for the e2e servers each Playwright worker spawns.
//
// Ports come from the worker's `parallelIndex` (its slot, 0..workers-1),
// never from `workerIndex`: that one grows every time Playwright replaces a
// worker after a failure, so a run with a few failures walked the ports into
// whatever else listens on the machine — a developer's real `uatu hub` on
// 4700, the fixed ports of src/hub/main.integration.test.ts (4795–4799).
// A slot's replacement worker starts only after its predecessor exited, and
// every e2e server exits when the stdin pipe from its parent closes, so the
// ports are normally free again; `waitForPortsFree` covers the moment a
// force-killed predecessor's children take to notice.
//
// Both ranges sit above 10080, the highest port on the Fetch spec's
// bad-port list that WebKit and Chromium refuse to load (a range starting at
// 4173 once put a worker on 4190), and below macOS's ephemeral range (49152).
// UATU_E2E_BASE_PORT / UATU_E2E_HUB_BASE_PORT move them, e.g. to run two
// suites side by side.

import net from "node:net";

// The worker harness (fixtures.ts) takes one port per slot.
export const BASE_PORT = Number.parseInt(process.env.UATU_E2E_BASE_PORT ?? "20000", 10);
// A hub worker (hub-fixtures.ts) takes a block per slot: the hub, then its
// children on consecutive ports.
export const HUB_BASE_PORT = Number.parseInt(process.env.UATU_E2E_HUB_BASE_PORT ?? "21000", 10);
// With the defaults the harness family (20000 + slot) stays below the hub
// family (21000 + 10 × slot) for any worker count under 1000.
export const HUB_PORTS_PER_WORKER = 10;

export function workerServerPort(parallelIndex: number): number {
  return BASE_PORT + parallelIndex;
}

export function hubPortBlock(parallelIndex: number): { hubPort: number; end: number } {
  const hubPort = HUB_BASE_PORT + parallelIndex * HUB_PORTS_PER_WORKER;
  return { hubPort, end: hubPort + HUB_PORTS_PER_WORKER };
}

const PORT_WAIT_MS = 15_000;

// Resolves once nothing accepts connections on any of `ports` at 127.0.0.1;
// rejects, naming the port, if one stays taken for PORT_WAIT_MS.
export async function waitForPortsFree(ports: number[]): Promise<void> {
  const deadline = Date.now() + PORT_WAIT_MS;
  for (const port of ports) {
    while (await isListening(port)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `e2e port ${port} is still in use after ${PORT_WAIT_MS / 1000}s — another process holds it; ` +
            "set UATU_E2E_BASE_PORT / UATU_E2E_HUB_BASE_PORT to move the e2e port ranges",
        );
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
