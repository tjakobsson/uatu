import { describe, expect, test } from "bun:test";

import {
  OpenCodeService,
  classifyProbeFailure,
  resolveStartupTimeoutMs,
  type SpawnedOpenCode,
} from "./opencode-service";

// A clock the stubbed `sleep` drives. Without it a no-op `sleep` spins the
// readiness loop against the real wall clock for the whole budget.
function fakeClock(step = 100) {
  let current = 0;
  return {
    elapsed: () => current,
    options: {
      now: () => current,
      sleep: async (milliseconds: number) => { current += Math.max(milliseconds, step); },
    },
  };
}

// The shapes Bun actually produces, verified against a live server.
function refusal(): Error {
  return Object.assign(new Error("Unable to connect."), { code: "ConnectionRefused" });
}

function abandoned(): Error {
  return Object.assign(new Error("The operation timed out."), { name: "TimeoutError", code: 23 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

// A fresh child per spawn, each with its own unresolved `exited` that the
// paired killGroup settles. The single-child fixture cannot serve retry: the
// first terminate() resolves `exited`, so the second attempt would see an
// already-dead process before it ever probed.
function respawning(output: { stdout?: string; stderr?: string } = {}) {
  const exits: Array<{ resolve: (value: number | null) => void }> = [];
  return {
    spawn(): SpawnedOpenCode {
      const exit = deferred<number | null>();
      exits.push(exit);
      return {
        pid: 42 + exits.length,
        exited: exit.promise,
        stderr: stream(output.stderr ?? ""),
        stdout: output.stdout === undefined ? undefined : stream(output.stdout),
        kill() {},
      };
    },
    killGroup(_pid: number, signal: NodeJS.Signals | 0) {
      exits.at(-1)?.resolve(signal === "SIGTERM" ? 143 : 137);
    },
  };
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
    discoverCandidates: async () => ["/bin/opencode"],
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
    const { service, calls } = fixture({ discoverCandidates: async () => [] });
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
      discoverCandidates: async () => ["/bin/opencode"],
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

  test("bounds captured output", async () => {
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
      expect(status.diagnostics?.stderr).toContain("tail");
      expect(status.diagnostics?.stderr).not.toContain("prefix");
    }
  });
});

describe("OpenCodeService phase attribution", () => {
  test("a never-answering server fails the bind phase, not the health phase", async () => {
    const clock = fakeClock();
    const { service } = fixture({ ...clock.options, fetch: async () => { throw refusal(); }, bindAttempts: 1 });
    const status = await service.status();
    if (status.state !== "unavailable") throw new Error("expected unavailable");
    expect(status.message).toContain("never accepted a health request");
    expect(status.message).toContain("http://127.0.0.1:43210");
    expect(status.message).toContain("connection refused");
    expect(status.diagnostics?.lastProbe).toEqual({ kind: "refused" });
  });

  test("a server that answers but stays unhealthy fails on the short health slice", async () => {
    const clock = fakeClock();
    const { service } = fixture({
      ...clock.options,
      fetch: async () => new Response("nope", { status: 401 }),
      bindAttempts: 1,
    });
    const status = await service.status();
    if (status.state !== "unavailable") throw new Error("expected unavailable");
    expect(status.message).toContain("answered at http://127.0.0.1:43210");
    expect(status.message).toContain("HTTP 401");
    expect(status.diagnostics?.lastProbe).toEqual({ kind: "http-status", status: 401 });
    // The 5s health slice, not the 30s startup budget.
    expect(clock.elapsed()).toBeLessThan(10_000);
  });

  test("a bind that answers late still gets the full health slice", async () => {
    const clock = fakeClock();
    let answered = false;
    const { service } = fixture({
      ...clock.options,
      startupTimeoutMs: 1_000,
      fetch: async () => {
        // Refused until just before the bind budget expires, then bound but
        // briefly unhealthy — recovering within the health slice, which must
        // not have shrunk to the sliver left of the bind budget.
        if (clock.elapsed() < 900) throw refusal();
        if (!answered) {
          answered = true;
          return new Response("starting", { status: 503 });
        }
        return Response.json({ healthy: true, version: "1.18.18" });
      },
      bindAttempts: 1,
    });
    expect(await service.status()).toEqual({ state: "ready", version: "1.18.18" });
  });

  test("an accepted-but-unanswered connection still yields repeated probes", async () => {
    const clock = fakeClock();
    const { service } = fixture({
      ...clock.options,
      fetch: async () => { throw abandoned(); },
      startupTimeoutMs: 1_000,
      bindAttempts: 1,
    });
    const status = await service.status();
    if (status.state !== "unavailable") throw new Error("expected unavailable");
    expect(status.diagnostics?.lastProbe).toEqual({ kind: "abandoned" });
    expect(status.diagnostics?.probes).toBeGreaterThan(1);
  });

  test("an unrecognized failure is recorded as unknown rather than a refusal", async () => {
    expect(classifyProbeFailure(new Error("something else"))).toEqual({ kind: "unknown", error: "something else" });
    expect(classifyProbeFailure(refusal())).toEqual({ kind: "refused" });
    expect(classifyProbeFailure(abandoned())).toEqual({ kind: "abandoned" });

    const clock = fakeClock();
    const { service } = fixture({
      ...clock.options,
      fetch: async () => { throw new Error("tls handshake exploded"); },
      startupTimeoutMs: 500,
      bindAttempts: 1,
    });
    const status = await service.status();
    if (status.state !== "unavailable") throw new Error("expected unavailable");
    expect(status.diagnostics?.lastProbe).toEqual({ kind: "unknown", error: "tls handshake exploded" });
  });

  test("readiness does not depend on what OpenCode prints", async () => {
    const { service } = fixture({
      spawn: () => ({
        pid: 42,
        exited: deferred<number | null>().promise,
        stderr: stream(),
        stdout: stream("a totally unrecognizable banner\n"),
        kill() {},
      }),
      killGroup() {},
    });
    expect(await service.status()).toEqual({ state: "ready", version: "1.18.18" });
  });
});

describe("OpenCodeService failure diagnostics", () => {
  test("carries the evidence needed to diagnose the failure from the report alone", async () => {
    const clock = fakeClock();
    const { service } = fixture({
      ...clock.options,
      discoverCandidates: async () => ["/home/linuxbrew/.linuxbrew/bin/opencode", "/mnt/c/npm/opencode"],
      probeVersion: async () => "1.18.18",
      ...respawning({ stderr: "boot failed\n", stdout: "opencode server listening on http://127.0.0.1:43210\n" }),
      fetch: async () => { throw refusal(); },
      startupTimeoutMs: 500,
      bindAttempts: 1,
    });
    const status = await service.status();
    if (status.state !== "unavailable") throw new Error("expected unavailable");
    const diagnostics = status.diagnostics!;
    expect(diagnostics.executable).toBe("/home/linuxbrew/.linuxbrew/bin/opencode");
    expect(diagnostics.shadowedExecutables).toEqual(["/mnt/c/npm/opencode"]);
    expect(diagnostics.version).toBe("1.18.18");
    expect(diagnostics.endpoint).toBe("http://127.0.0.1:43210");
    expect(diagnostics.elapsedMs).toBeGreaterThanOrEqual(500);
    expect(diagnostics.probes).toBeGreaterThan(0);
    expect(diagnostics.stdout).toContain("listening on");
    expect(diagnostics.stderr).toContain("boot failed");
  });

  test("a spawn failure still carries structured diagnostics", async () => {
    const { service } = fixture({
      spawn: () => { throw new Error("EACCES: permission denied"); },
      probeVersion: async () => "1.18.18",
    });
    const status = await service.status();
    if (status.state !== "unavailable") throw new Error("expected unavailable");
    expect(status.reason).toBe("startup-failed");
    expect(status.message).toContain("EACCES");
    expect(status.diagnostics).toEqual(expect.objectContaining({
      executable: "/bin/opencode",
      shadowedExecutables: [],
      version: "1.18.18",
      endpoint: "http://127.0.0.1:43210",
      probes: 0,
      lastProbe: { kind: "none" },
    }));
  });

  test("a version that cannot be determined does not mask the original error", async () => {
    const clock = fakeClock();
    const { service } = fixture({
      ...clock.options,
      probeVersion: async () => { throw new Error("version probe hung"); },
      fetch: async () => { throw refusal(); },
      startupTimeoutMs: 500,
      bindAttempts: 1,
    });
    const status = await service.status();
    if (status.state !== "unavailable") throw new Error("expected unavailable");
    expect(status.diagnostics?.version).toBeNull();
    expect(status.message).toContain("never accepted a health request");
  });

  test("the server password never reaches the diagnostics, even if OpenCode echoes it", async () => {
    const clock = fakeClock();
    const { service } = fixture({
      ...clock.options,
      ...respawning({
        // The literal, and the Basic credential the health probe sends — a
        // request-header echo carries the password base64-encoded.
        stderr: `env OPENCODE_SERVER_PASSWORD=secret-password\nauthorization: Basic ${Buffer.from("opencode:secret-password").toString("base64")}\n`,
        stdout: "starting with secret-password in view\n",
      }),
      fetch: async () => { throw refusal(); },
      startupTimeoutMs: 500,
      bindAttempts: 1,
    });
    const status = await service.status();
    if (status.state !== "unavailable") throw new Error("expected unavailable");
    expect(JSON.stringify(status)).not.toContain("secret-password");
    expect(JSON.stringify(status)).not.toContain(Buffer.from("opencode:secret-password").toString("base64"));
    expect(status.diagnostics?.stderr).toContain("[redacted]");
    expect(status.diagnostics?.stdout).toContain("[redacted]");
  });
});

describe("OpenCodeService retry", () => {
  test("retry clears a cached failure and can succeed without a new service", async () => {
    const clock = fakeClock();
    let healthy = false;
    const { service } = fixture({
      ...clock.options,
      ...respawning(),
      fetch: async () => {
        if (!healthy) throw refusal();
        return Response.json({ healthy: true, version: "1.18.18" });
      },
      startupTimeoutMs: 500,
      bindAttempts: 1,
    });
    expect((await service.status()).state).toBe("unavailable");
    // A second status() still short-circuits to the cached failure.
    expect((await service.status()).state).toBe("unavailable");

    healthy = true;
    expect(await service.retry()).toEqual({ state: "ready", version: "1.18.18" });
  });

  test("a retry that fails again reports the new attempt's diagnostics", async () => {
    const clock = fakeClock();
    const outcomes = [refusal(), abandoned()];
    let call = 0;
    const { service } = fixture({
      ...clock.options,
      ...respawning(),
      fetch: async () => { throw outcomes[Math.min(call, outcomes.length - 1)]!; },
      startupTimeoutMs: 500,
      bindAttempts: 1,
    });
    const first = await service.status();
    expect(first.state === "unavailable" && first.diagnostics?.lastProbe).toEqual({ kind: "refused" });

    call = 1;
    const second = await service.retry();
    expect(second.state === "unavailable" && second.diagnostics?.lastProbe).toEqual({ kind: "abandoned" });
  });

  test("concurrent restarts join one replacement instead of leaking a process", async () => {
    const clock = fakeClock();
    let spawns = 0;
    const spawner = respawning();
    const { service } = fixture({
      ...clock.options,
      spawn: () => { spawns += 1; return spawner.spawn(); },
      killGroup: spawner.killGroup,
      startupTimeoutMs: 500,
    });
    expect(await service.status()).toEqual({ state: "ready", version: "1.18.18" });
    expect(spawns).toBe(1);

    const [first, second] = await Promise.all([service.restart(), service.restart()]);
    expect(first).toEqual({ state: "ready", version: "1.18.18" });
    expect(second).toEqual(first);
    // One replacement for both callers — an uncoalesced pair could detach the
    // other's fresh process and leave it running untracked.
    expect(spawns).toBe(2);
    await service.dispose();
  });

  test("concurrent retries join one attempt instead of spawning twice", async () => {
    const { service, calls } = fixture();
    await service.status();
    const [a, b] = await Promise.all([service.retry(), service.retry()]);
    expect(a).toEqual(b);
    // Already ready, so no respawn; the join is what matters.
    expect(calls).toHaveLength(1);
  });
});

describe("OpenCodeService startup budget", () => {
  test("honors UATU_OPENCODE_STARTUP_TIMEOUT_MS and rejects unusable values", () => {
    expect(resolveStartupTimeoutMs({ UATU_OPENCODE_STARTUP_TIMEOUT_MS: "60000" })).toBe(60_000);
    expect(resolveStartupTimeoutMs({ UATU_OPENCODE_STARTUP_TIMEOUT_MS: " 60000 " })).toBe(60_000);
    // Partially numeric typos must fall back too: parseInt would read "1ms"
    // as 1 and collapse the startup window instead of leaving the default.
    for (const value of ["", "abc", "0", "-1", " ", "1ms", "30s", "1e4", "10.5"]) {
      expect(resolveStartupTimeoutMs({ UATU_OPENCODE_STARTUP_TIMEOUT_MS: value })).toBeUndefined();
    }
    expect(resolveStartupTimeoutMs({})).toBeUndefined();
  });

  test("an override widens the window a failing startup waits for", async () => {
    const waited: number[] = [];
    for (const override of ["1000", "4000"]) {
      const clock = fakeClock();
      const { service } = fixture({
        env: { PATH: "/bin", UATU_OPENCODE_STARTUP_TIMEOUT_MS: override },
        ...clock.options,
        fetch: async () => { throw refusal(); },
        bindAttempts: 1,
      });
      await service.status();
      waited.push(clock.elapsed());
    }
    expect(waited[0]).toBeGreaterThanOrEqual(1_000);
    expect(waited[1]).toBeGreaterThanOrEqual(4_000);
    expect(waited[1]).toBeGreaterThan(waited[0]!);
  });

  test("a garbage override leaves the default in force rather than failing", async () => {
    const clock = fakeClock();
    const { service } = fixture({
      env: { PATH: "/bin", UATU_OPENCODE_STARTUP_TIMEOUT_MS: "not-a-number" },
      ...clock.options,
      fetch: async () => { throw refusal(); },
      bindAttempts: 1,
    });
    expect(await service.status()).toEqual(expect.objectContaining({ state: "unavailable" }));
    // The 30s default, not a zero-length or infinite window.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(30_000);
    expect(clock.elapsed()).toBeLessThan(40_000);
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
