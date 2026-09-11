import { spawn } from "node:child_process";
import { open, readFile, unlink, lstat } from "node:fs/promises";
import { assertFreePort } from "./server";
import { reviewHostingOptions } from "./hosting";

const runtime = new URL("./runtime/", import.meta.url);
const recordPath = new URL("server.json", runtime);
const serverPath = new URL("./server.ts", import.meta.url).pathname;
export type Ownership = { schema: 1; pid: number; instanceId: string; port: number; publicOrigin?: string; processIdentity: string; fingerprint: string };
type Hosting = ReturnType<typeof reviewHostingOptions>;

export function hostingArgs(options: Hosting): string[] {
  return ["--port", String(options.port), ...(options.publicOrigin === undefined ? [] : ["--public-origin", options.publicOrigin])];
}

export function hostingUrl(options: Hosting): string {
  return options.publicOrigin ?? `http://127.0.0.1:${options.port}`;
}

export async function processIdentity(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Unsafe PID");
  const proc = Bun.spawn(["ps", "-ww", "-p", String(pid), "-o", "lstart=,command="], { stdout: "pipe", stderr: "pipe" });
  const text = (await new Response(proc.stdout).text()).trim();
  if (await proc.exited !== 0 || !text) throw new Error("Owned process is absent; stale record retained for inspection");
  return text;
}

export async function readHealth(port: number): Promise<any> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || [4700, 4701, 4702].includes(port)) throw new Error("Unsafe review port");
  const response = await fetch(`http://127.0.0.1:${port}/review/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
  if (!response.ok) throw new Error("Review health unavailable");
  return response.json();
}

export async function verifyOwned(record: Ownership, inspect = processIdentity, health = readHealth): Promise<void> {
  if (record.schema !== 1 || !/^[a-f0-9-]{36}$/.test(record.instanceId) || !/^sha256:[a-f0-9]{64}$/.test(record.fingerprint)) throw new Error("Invalid ownership record");
  const options = managedHostingOptions(hostingArgs({ port: record.port, publicOrigin: record.publicOrigin }), {});
  if (!record.processIdentity.endsWith(` ${process.execPath} ${serverPath} ${hostingArgs(options).join(" ")}`)) throw new Error("Unexpected startup command");
  if (await inspect(record.pid) !== record.processIdentity) throw new Error("PID/startup identity mismatch; refusing operation");
  const result = await health(record.port);
  if (result.status !== "ready" || result.backend !== "synthetic" || result.assembly !== "same-document-mobile" || result.pid !== record.pid || result.instanceId !== record.instanceId || result.version?.fingerprint !== record.fingerprint) throw new Error("Instance/build identity mismatch; refusing operation");
  if (await inspect(record.pid) !== record.processIdentity) throw new Error("Process changed during verification");
}

async function load(): Promise<Ownership> {
  if (!(await lstat(recordPath)).isFile() || (await lstat(recordPath)).isSymbolicLink()) throw new Error("Unsafe ownership record");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

export function managedHostingOptions(args: string[], env: Record<string, string | undefined> = process.env) {
  const options = reviewHostingOptions(args, env);
  if (!options.port) throw new Error("Managed listener requires an explicit nonzero port");
  return options;
}

async function start(args: string[]) {
  const options = managedHostingOptions(args, {});
  await assertFreePort(options.port);
  // Exclusive ownership record: never overwrite another launcher or stale PID.
  const file = await open(recordPath, "wx", 0o600);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const log = await open(new URL("server.log", runtime), "a", 0o600);
    const instanceId = crypto.randomUUID();
    try {
      child = spawn(process.execPath, [serverPath, ...hostingArgs(options)], {
        detached: true, stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, UATU_MOBILE_REVIEW_PUBLIC_ORIGIN: options.publicOrigin, UATU_MOBILE_REVIEW_INSTANCE_ID: instanceId },
      });
    } finally { await log.close(); }
    let spawnError: Error | undefined;
    child.on("error", error => { spawnError = error; });
    await file.writeFile(JSON.stringify({ schema: 1, state: "starting", pid: child.pid, instanceId, ...options }));
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error("Review child exited during startup");
      try {
        const health = await readHealth(options.port);
        if (health.instanceId === instanceId && health.pid === child.pid) {
          const record: Ownership = { schema: 1, pid: child.pid!, instanceId, port: options.port, publicOrigin: options.publicOrigin, processIdentity: await processIdentity(child.pid!), fingerprint: health.version?.fingerprint };
          await verifyOwned(record);
          await file.truncate(0); await file.write(JSON.stringify(record, null, 2), 0, "utf8"); await file.sync();
          child.unref();
          console.info(JSON.stringify({ ...record, url: hostingUrl(options), evidence: `${hostingUrl(options)}/review/evidence` }, null, 2));
          return;
        }
      } catch { /* bounded startup wait; never kill an unverified PID */ }
      await Bun.sleep(250);
    }
    throw new Error("Startup not verified; ownership record/log retained. No unverified process was killed.");
  } finally { child?.unref(); await file.close(); }
}

async function stop(owned?: Ownership) {
  const record = owned ?? await load();
  await verifyOwned(record);
  process.kill(record.pid, "SIGTERM");
  for (let attempt = 0; attempt < 80; attempt++) {
    let identity: string | undefined;
    try { identity = await processIdentity(record.pid); } catch {}
    if (identity !== record.processIdentity) { await unlink(recordPath); console.info("Owned review stopped"); return; }
    await Bun.sleep(100);
  }
  throw new Error("Graceful stop not confirmed; record retained, no escalation");
}

// Injectable lifecycle keeps restart ordering testable without signalling real PIDs.
export async function restartOwned<T>(args: string[], env: Record<string, string | undefined>, lifecycle: {
  load(): Promise<Ownership>; verify(record: Ownership): Promise<void>;
  stop(record: Ownership): Promise<void>; start(args: string[]): Promise<T>;
}): Promise<T> {
  const record = await lifecycle.load();
  await lifecycle.verify(record);
  const options = managedHostingOptions(args, {
    UATU_MOBILE_REVIEW_PORT: env.UATU_MOBILE_REVIEW_PORT ?? String(record.port),
    UATU_MOBILE_REVIEW_PUBLIC_ORIGIN: env.UATU_MOBILE_REVIEW_PUBLIC_ORIGIN ?? record.publicOrigin,
  });
  await lifecycle.stop(record);
  return lifecycle.start(hostingArgs(options));
}

export async function manage(args: string[]) {
  const [command, ...options] = args;
  if (!["start", "stop", "restart", "reset", "status"].includes(command ?? "")) throw new Error("Usage: bun tests/mobile-hub-review/manage.ts start|stop|restart|reset|status [--port N --public-origin ORIGIN]");
  if (!["start", "restart"].includes(command!) && options.length) throw new Error("Only start/restart accept hosting options");
  // Serializes lifecycle invocations; a crash leaves a fail-closed lock to inspect.
  const lockPath = new URL("manage.lock", runtime);
  const lock = await open(lockPath, "wx", 0o600);
  try {
    if (command === "start") return await start(hostingArgs(managedHostingOptions(options)));
    if (command === "stop") return await stop();
    if (command === "restart") return await restartOwned(options, process.env, { load, verify: verifyOwned, stop, start });
    const record = await load(); await verifyOwned(record);
    if (command === "status") { console.info(JSON.stringify(await readHealth(record.port), null, 2)); return; }
    const response = await fetch(`http://127.0.0.1:${record.port}/review/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario: "mixed" }), signal: AbortSignal.timeout(1500), redirect: "error" });
    if (!response.ok) throw new Error("Synthetic reset failed");
    console.info(await response.text());
  } finally { await lock.close(); await unlink(lockPath); }
}

if (import.meta.main) {
  try { await manage(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Review lifecycle failed"); process.exitCode = 1; }
}
