import { afterEach, describe, expect, it } from "bun:test";
import { randomInt } from "node:crypto";
import { createServer, type Server } from "node:net";

import { canBind, findFreePort } from "./port-probe";

const occupiedServers = new Set<Server>();

afterEach(async () => {
  await Promise.all([...occupiedServers].map(release));
});

function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      occupiedServers.add(server);
      resolve(server);
    });
    server.listen(port, "127.0.0.1");
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a listening TCP socket");
  return address.port;
}

function release(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => {
    occupiedServers.delete(server);
    if (error) reject(error);
    else resolve();
  }));
}

// Reserve an unprivileged range below Linux/macOS's default ephemeral ranges,
// so concurrent port-0 listeners do not claim a released scan candidate.
// No slot is assumed free: retry only setup collisions, never assertions.
async function reserveRange(count: number): Promise<Server[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const start = randomInt(1024, 32768 - count + 1);
    const servers: Server[] = [];
    try {
      for (let offset = 0; offset < count; offset++) servers.push(await occupy(start + offset));
      return servers;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
    await Promise.all(servers.map(release));
  }
  throw new Error(`Could not reserve ${count} consecutive TCP ports`);
}

describe("canBind", () => {
  it("returns true when the port is free", async () => {
    const [server] = await reserveRange(1), port = portOf(server!);
    await release(server!);
    expect(await canBind(port)).toBe(true);
  });

  it("returns false when the port is in use", async () => {
    const [server] = await reserveRange(1);
    expect(await canBind(portOf(server!))).toBe(false);
  });

  it("releases the probe socket after a successful bind", async () => {
    const [server] = await reserveRange(1), port = portOf(server!);
    await release(server!);
    expect(await canBind(port)).toBe(true);
    // Should still be free immediately after, since the probe closes itself.
    expect(await canBind(port)).toBe(true);
    // Prove reuse with a retained listener as well as another probe.
    await occupy(port);
    expect(await canBind(port)).toBe(false);
  });
});

describe("findFreePort", () => {
  it("returns the start port when it's free", async () => {
    const [server] = await reserveRange(1), start = portOf(server!);
    await release(server!);
    expect(await findFreePort(start, 4)).toBe(start);
  });

  it("walks upward to the first free port when start is taken", async () => {
    const servers = await reserveRange(2), start = portOf(servers[0]!);
    await release(servers[1]!);
    expect(await findFreePort(start, 4)).toBe(start + 1);
  });

  it("skips multiple consecutively-occupied ports", async () => {
    const servers = await reserveRange(4), start = portOf(servers[0]!);
    await release(servers[3]!);
    expect(await findFreePort(start, 8)).toBe(start + 3);
  });

  it("falls back to the start port when no free port found within limit", async () => {
    const [server] = await reserveRange(1), start = portOf(server!);
    // Tight limit of 1 means we only try `start`. If it's occupied, the
    // helper returns `start` so the caller's later bind can surface the
    // real EADDRINUSE.
    expect(await findFreePort(start, 1)).toBe(start);
  });

  it("does not scan beyond the limit even when the next port is free", async () => {
    const servers = await reserveRange(4), start = portOf(servers[0]!);
    await release(servers[3]!);
    expect(await findFreePort(start, 3)).toBe(start);
    expect(await findFreePort(start, 4)).toBe(start + 3);
  });
});
