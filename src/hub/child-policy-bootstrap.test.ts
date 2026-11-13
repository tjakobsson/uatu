import { expect, test } from "bun:test";
import { closeSync, writeSync } from "node:fs";
import { createChildPolicyAuthority } from "./child-policy";
import { sendChildPolicyDescriptor } from "./child-policy-bootstrap";

test("private descriptor is consumed and closed before tool descendants while lifetime stdin stays open", async () => {
  const authority = createChildPolicyAuthority("project", "/s/project/");
  const modulePath = new URL("./child-policy-bootstrap.ts", import.meta.url).pathname;
  const script = `import {consumeChildPolicyDescriptor} from ${JSON.stringify(modulePath)};
    import {fstatSync} from 'node:fs'; const before=fstatSync(3); let closed=false;
    const policy = await consumeChildPolicyDescriptor(3, 1000);
    try { closed=fstatSync(3).ino!==before.ino; } catch { closed=true; }
    const child = Bun.spawn([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'], {stdout:'pipe'});
    const env = await new Response(child.stdout).text(); await child.exited;
    console.log(JSON.stringify({trusted:!!policy, instance:policy?.instanceId, closed, env}));`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdio: ["pipe", "pipe", "pipe", "socket-fd"] });
  const fd = child.stdio[3]!;
  expect(await sendChildPolicyDescriptor(fd, () => authority.bootstrap(), 1000)).toBe(true);
  const output = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(output)).toMatchObject({ trusted: true, instance: authority.instanceId, closed: true });
  expect(output).not.toContain(JSON.parse(authority.bootstrap()).secret);
  expect(output).not.toContain("HUB_POLICY_SECRET");
});

test("an old or non-consuming child never receives secret material", async () => {
  const child = Bun.spawn([process.execPath, "-e", `process.stdin.resume(); console.log('old-child');`], { stdio: ["pipe", "pipe", "pipe", "socket-fd"] });
  let materialized = false;
  try {
    expect(await sendChildPolicyDescriptor(child.stdio[3]!, () => { materialized = true; return "private-secret"; }, 30)).toBe(false);
    expect(materialized).toBe(false);
  } finally { child.kill(); await child.exited; }
});

test("missing, malformed and timed-out private bootstrap returns unavailable without printing payloads", async () => {
  const modulePath = new URL("./child-policy-bootstrap.ts", import.meta.url).pathname;
  for (const input of [null, "malformed-private-data\n", ""]) {
    const child = Bun.spawn([process.execPath, "-e", `import {consumeChildPolicyDescriptor} from ${JSON.stringify(modulePath)}; console.log((await consumeChildPolicyDescriptor(3, 30)) === null ? 'unavailable' : 'trusted');`], {
      stdio: ["pipe", "pipe", "pipe", ...(input === null ? [] : ["socket-fd" as const])],
    });
    const fd = child.stdio[3];
    if (typeof fd === "number" && input) { writeSync(fd, input); closeSync(fd); }
    try {
      expect(await new Response(child.stdout).text()).toBe("unavailable\n");
      expect(await new Response(child.stderr).text()).toBe("");
      expect(await child.exited).toBe(0);
    } finally { if (typeof fd === "number" && !input) closeSync(fd); }
  }
});
