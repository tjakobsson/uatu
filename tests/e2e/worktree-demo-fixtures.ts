import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";

// Only the demo web server is spawned. It has no child/session backend.
export const test = base.extend<{}, { demoOrigin: string }>({
  demoOrigin: [async ({}, use) => {
    const child = spawn("bun", ["run", "tests/e2e/worktree-demo-server.ts"], {
      env: { PATH: process.env.PATH, UATU_WORKTREE_DEMO_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const origin = await new Promise<string>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error("Worktree demo startup timed out")),15000);
        let output="",errors="";
        child.stderr!.on("data",chunk=>errors+=chunk.toString());
        child.stdout!.on("data",chunk=>{output+=chunk.toString();const line=output.split("\n").find(line=>line.startsWith("uatu-worktree-demo "));if(line){clearTimeout(timer);resolve(JSON.parse(line.slice("uatu-worktree-demo ".length)).origin);}});
        child.on("error",error=>{clearTimeout(timer);reject(error);});
        child.on("exit",code=>{clearTimeout(timer);reject(new Error(`Demo exited ${code}: ${errors}`));});
      });
      await use(origin);
    } finally {
      if(child.exitCode===null) { child.kill("SIGTERM"); await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill("SIGKILL");resolve();},3000);child.once("exit",()=>{clearTimeout(timer);resolve();});}); }
    }
  }, {scope:"worker"}],
  baseURL: async ({demoOrigin},use)=>use(demoOrigin),
});
export { expect };
