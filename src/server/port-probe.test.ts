import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";

import { canBind, findFreePort } from "./port-probe";

let occupiedServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    occupiedServers.map(server => new Promise<void>(resolve => server.close(() => resolve()))),
  );
  occupiedServers = [];
});

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      occupiedServers.push(server);
      resolve();
    });
    server.listen(port, "127.0.0.1");
  });
}

// Ports in the IANA dynamic / private range to minimize the chance of bumping
// into a real service. Each test uses its own port so retries don't collide.
const TEST_PORT_BASE = 49_000;

describe("canBind", () => {
  it("returns true when the port is free", async () => {
    expect(await canBind(TEST_PORT_BASE + 0)).toBe(true);
  });

  it("returns false when the port is in use", async () => {
    const port = TEST_PORT_BASE + 1;
    await occupy(port);
    expect(await canBind(port)).toBe(false);
  });

  it("releases the probe socket after a successful bind", async () => {
    const port = TEST_PORT_BASE + 2;
    expect(await canBind(port)).toBe(true);
    // Should still be free immediately after — the probe must close itself.
    expect(await canBind(port)).toBe(true);
  });
});

describe("findFreePort", () => {
  it("returns the start port when it's free", async () => {
    const start = TEST_PORT_BASE + 10;
    expect(await findFreePort(start, 4)).toBe(start);
  });

  it("walks upward to the first free port when start is taken", async () => {
    const start = TEST_PORT_BASE + 20;
    await occupy(start);
    expect(await findFreePort(start, 4)).toBe(start + 1);
  });

  it("skips multiple consecutively-occupied ports", async () => {
    const start = TEST_PORT_BASE + 30;
    await occupy(start);
    await occupy(start + 1);
    await occupy(start + 2);
    expect(await findFreePort(start, 8)).toBe(start + 3);
  });

  it("falls back to the start port when no free port found within limit", async () => {
    const start = TEST_PORT_BASE + 40;
    // Tight limit of 1 means we only try `start`. If it's occupied, the
    // helper returns `start` so the caller's later bind can surface the
    // real EADDRINUSE.
    await occupy(start);
    expect(await findFreePort(start, 1)).toBe(start);
  });
});
