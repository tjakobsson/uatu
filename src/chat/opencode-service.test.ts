import { describe, expect, test } from "bun:test";

import { OpenCodeService, type SpawnedOpenCode } from "./opencode-service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function stream(text = ""): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function fixture(overrides: Record<string, unknown> = {}) {
  const exit = deferred<number | null>();
  const signals: Array<NodeJS.Signals | 0> = [];
  const calls: Array<{ argv: string[]; options: Record<string, unknown> }> = [];
  const child: SpawnedOpenCode = {
    pid: 42,
    exited: exit.promise,
    stderr: stream(),
    kill: signal => signals.push(signal),
  };
  const service = new OpenCodeService({
    workspacePath: "/workspace",
    env: { PATH: "/bin", HOME: "/home/user" },
    discoverExecutable: async () => "/bin/opencode",
    allocatePort: async () => 43210,
    randomPassword: () => "secret-password",
    spawn(argv, options) {
      calls.push({ argv, options: options as Record<string, unknown> });
      return child;
    },
    fetch: async () => Response.json({ healthy: true, version: "1.18.18" }),
    killGroup(_pid, signal) {
      signals.push(signal);
      exit.resolve(signal === "SIGTERM" ? 143 : 137);
    },
    sleep: async () => undefined,
    termGraceMs: 1,
    ...overrides,
  });
  return { service, exit, signals, calls, child };
}

describe("OpenCodeService startup", () => {
  test("reports missing OpenCode without spawning", async () => {
    const { service, calls } = fixture({ discoverExecutable: async () => null });
    expect(await service.status()).toEqual(expect.objectContaining({ state: "unavailable", reason: "not-installed" }));
    expect(calls).toHaveLength(0);
  });

  test("joins concurrent starts and uses authenticated no-shell loopback arguments", async () => {
    let authorization = "";
    const { service, calls } = fixture({
      fetch: async (_url: string | URL | Request, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ healthy: true, version: "1.18.18" });
      },
    });
    const [first, second] = await Promise.all([service.status(), service.status()]);

    expect(first).toEqual({ state: "ready", version: "1.18.18" });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(["/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", "43210"]);
    expect(calls[0]?.options.cwd).toBe("/workspace");
    expect(calls[0]?.options).not.toHaveProperty("shell");
    expect((calls[0]?.options.env as Record<string, string>).OPENCODE_SERVER_PASSWORD).toBe("secret-password");
    expect(calls[0]?.argv).not.toContain("secret-password");
    expect(authorization).toBe(`Basic ${Buffer.from("opencode:secret-password").toString("base64")}`);
    expect(service.currentConnection()).toEqual({ endpoint: "http://127.0.0.1:43210", password: "secret-password" });
  });

  test("retries a bind race with a fresh port and password", async () => {
    let spawnCount = 0;
    const ports = [41000, 41001];
    const passwords = ["first-secret", "second-secret"];
    const exits = [Promise.resolve(1), deferred<number | null>().promise];
    const service = new OpenCodeService({
      workspacePath: "/workspace",
      discoverExecutable: async () => "/bin/opencode",
      allocatePort: async () => ports.shift() as number,
      randomPassword: () => passwords.shift() as string,
      spawn() {
        const index = spawnCount++;
        return { pid: 50 + index, exited: exits[index]!, stderr: stream(index === 0 ? "EADDRINUSE" : ""), kill() {} };
      },
      fetch: async url => String(url).includes("41001")
        ? Response.json({ healthy: true, version: "1.18.18" })
        : Promise.reject(new Error("not ready")),
      killGroup() {},
      sleep: async () => undefined,
      termGraceMs: 0,
    });

    expect(await service.status()).toEqual({ state: "ready", version: "1.18.18" });
    expect(spawnCount).toBe(2);
    expect(service.currentConnection()).toEqual({ endpoint: "http://127.0.0.1:41001", password: "second-secret" });
  });

  test("bounds startup diagnostics", async () => {
    const exit = Promise.resolve(1);
    const { service } = fixture({
      spawn: () => ({ pid: 42, exited: exit, stderr: stream(`prefix-${"x".repeat(200)}-tail`), kill() {} }),
      fetch: async () => Promise.reject(new Error("not ready")),
      stderrLimitBytes: 32,
      bindAttempts: 1,
      killGroup() {},
    });
    const status = await service.status();
    expect(status).toEqual(expect.objectContaining({ state: "unavailable", reason: "startup-failed" }));
    if (status.state === "unavailable") {
      expect(status.message).toContain("tail");
      expect(status.message).not.toContain("prefix");
    }
  });
});

describe("OpenCodeService disposal", () => {
  test("dispose before start is idempotent and prevents spawning", async () => {
    const { service, calls } = fixture();
    await Promise.all([service.dispose(), service.dispose()]);
    expect(await service.status()).toEqual(expect.objectContaining({ state: "unavailable" }));
    expect(calls).toHaveLength(0);
  });

  test("concurrent disposal terminates a ready service once and clears credentials", async () => {
    const { service, signals } = fixture();
    await service.status();
    await Promise.all([service.dispose(), service.dispose(), service.dispose()]);
    expect(signals.filter(signal => signal === "SIGTERM")).toHaveLength(1);
    expect(service.currentConnection()).toBeNull();
  });

  test("unexpected exit invalidates a ready connection", async () => {
    const { service, exit } = fixture();
    await service.status();
    exit.resolve(9);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.currentConnection()).toBeNull();
    expect(await service.status()).toEqual(expect.objectContaining({ state: "unavailable", reason: "startup-failed" }));
  });
});
